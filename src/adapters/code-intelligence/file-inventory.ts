import { readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { CodeFileInventory, CodeFileInventoryEntry } from "../../application/code-map-hierarchy.js";

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".chatgpt2codex",
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
]);

export interface FileSystemCodeFileInventoryOptions {
  maxFiles?: number;
  ignoredDirectories?: ReadonlySet<string>;
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

  constructor(options: FileSystemCodeFileInventoryOptions = {}) {
    this.#maxFiles = options.maxFiles ?? 50_000;
    this.#ignoredDirectories = options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES;
  }

  async listFiles(rootPath: string): Promise<readonly CodeFileInventoryEntry[]> {
    const root = resolve(rootPath);
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
          if (!this.#ignoredDirectories.has(entry.name)) directories.push(absolutePath);
          continue;
        }
        if (!entry.isFile()) continue;
        files.push({ path: portableRelativePath(root, absolutePath) });
        if (files.length > this.#maxFiles) {
          throw new Error(`Code Map file inventory exceeded ${this.#maxFiles} files under ${rootPath}`);
        }
      }
    }

    return files.sort((left, right) => left.path.localeCompare(right.path));
  }
}
