import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { CodeFileInventory, CodeFileInventoryEntry } from "../../application/code-map-hierarchy.js";

export const DEFAULT_CODE_MAP_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".chatgpt2codex",
  ".questboard",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".gradle",
  ".idea",
  ".vscode",
  "DerivedData",
  ".venv",
  "venv",
  "__pycache__",
]);

/** Credentials are never source-tree entries, even when accidentally tracked. */
export function safeCodeMapPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) return false;
  if (parts.some((part) => DEFAULT_CODE_MAP_IGNORED_DIRECTORIES.has(part))) return false;
  const name = parts.at(-1)!.toLowerCase();
  if (name === ".env" || name.startsWith(".env.")
      || /\.(?:key|pem|p12|pfx|der)$/.test(name)) return false;
  return true;
}

/** Git correctly honors nested .gitignore and per-user excludes. */
export function gitCodeMapPaths(root: string): readonly string[] | undefined {
  let top: string;
  try {
    top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return undefined; }
  if (realpathSync.native(top) !== realpathSync.native(root)) return undefined;
  const output = execFileSync("git", [
    "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z",
  ], {
    encoding: "buffer", timeout: 20_000, maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return [...new Set(output.toString("utf8").split("\0").filter(safeCodeMapPath))].sort();
}

export interface FileSystemCodeFileInventoryOptions {
  maxFiles?: number;
  ignoredDirectories?: ReadonlySet<string>;
  /** Diagnostic escape hatch. Normal Code Map never expands a Composer root's vendor tree. */
  includeComposerDependencies?: boolean;
}

function portableRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

/**
 * Provider-neutral repository inventory. It deliberately records regular files
 * without trying to decide whether their language is currently understood.
 * Generated/dependency directories are skipped to keep the canonical map bounded.
 */
export class FileSystemCodeFileInventory implements CodeFileInventory {
  readonly #maxFiles: number;
  readonly #ignoredDirectories: ReadonlySet<string>;
  readonly #includeComposerDependencies: boolean;

  constructor(options: FileSystemCodeFileInventoryOptions = {}) {
    this.#maxFiles = options.maxFiles ?? 50_000;
    this.#ignoredDirectories = options.ignoredDirectories ?? DEFAULT_CODE_MAP_IGNORED_DIRECTORIES;
    this.#includeComposerDependencies = options.includeComposerDependencies ?? false;
  }

  async listFiles(rootPath: string): Promise<readonly CodeFileInventoryEntry[]> {
    const root = resolve(rootPath);
    // A root Composer vendor/ tree is installed third-party code, not the
    // repository's source inventory. Do NOT blindly ignore nested directories
    // called vendor in other projects, and never discard semantic provider facts.
    // Explicit opt-in permits legacy/diagnostic full inventory comparisons.
    const excludeComposerVendor = !this.#includeComposerDependencies
      && existsSync(join(root, "composer.json"))
      && existsSync(join(root, "composer.lock"));
    // Explicit diagnostic inventory still walks vendor even when Git ignores it.
    const gitPaths = this.#includeComposerDependencies ? undefined : gitCodeMapPaths(root);
    if (gitPaths) {
      const files: CodeFileInventoryEntry[] = [];
      for (const path of gitPaths) {
        if (excludeComposerVendor && path.startsWith("vendor/")) continue;
        try {
          if (!lstatSync(resolve(root, path)).isFile()) continue;
        } catch { continue; } // A tracked path may have been deleted locally.
        files.push({ path });
        if (files.length > this.#maxFiles) {
          throw new Error("Code Map file inventory exceeded the configured file cap");
        }
      }
      return files;
    }
    const directories = [root];
    const files: CodeFileInventoryEntry[] = [];

    while (directories.length > 0) {
      const directory = directories.pop()!;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolutePath = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          if (!this.#ignoredDirectories.has(entry.name)
            && !(excludeComposerVendor && directory === root && entry.name === "vendor")) {
            directories.push(absolutePath);
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const path = portableRelativePath(root, absolutePath);
        if (!safeCodeMapPath(path)) continue;
        files.push({ path });
        if (files.length > this.#maxFiles) {
          throw new Error(`Code Map file inventory exceeded ${this.#maxFiles} files under ${rootPath}`);
        }
      }
    }

    return files.sort((left, right) => left.path.localeCompare(right.path));
  }
}
