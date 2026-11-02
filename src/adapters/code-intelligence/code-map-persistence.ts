import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CodeMapPersistedSnapshotStore,
  CodeMapRefreshJobReceipt,
  CodeMapSourceStateProvider,
  PersistedCodeMapSnapshotEnvelope,
} from "../../application/code-map-persistence.js";
import {
  DEFAULT_CODE_MAP_IGNORED_DIRECTORIES,
  gitCodeMapPaths,
  safeCodeMapPath,
} from "./file-inventory.js";

// Bounded configurable limit for large code snapshots.
function maxSnapshotBytes(): number {
  const raw = process.env.QUESTBOARD_CODE_MAP_MAX_SNAPSHOT_MIB?.trim();
  if (!raw) return 128 * 1024 * 1024;
  const mib = Number(raw);
  if (!Number.isSafeInteger(mib) || mib < 16 || mib > 2048) {
    throw new Error("QUESTBOARD_CODE_MAP_MAX_SNAPSHOT_MIB must be an integer from 16 to 2048");
  }
  return mib * 1024 * 1024;
}
const MAX_REFRESH_JOB_BYTES = 64 * 1024;
const DEFAULT_MAX_FILES = 50_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectSnapshotPath(storageRoot: string, projectId: string): string {
  return join(storageRoot, "snapshots", sha256(projectId), "snapshot.json");
}

function projectRefreshJobPath(storageRoot: string, projectId: string): string {
  return join(storageRoot, "snapshots", sha256(projectId), "refresh-job.json");
}

function canonicalPathAllowingMissingLeaf(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync.native(cursor), ...suffix);
}

export function assertCodeMapStorageRootOutsideProject(storageRoot: string, projectRoot: string): void {
  const canonicalProjectRoot = realpathSync.native(resolve(projectRoot));
  const canonicalStorageRoot = canonicalPathAllowingMissingLeaf(storageRoot);
  const relation = relative(canonicalProjectRoot, canonicalStorageRoot);
  const insideProject = relation === ""
    || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
  if (insideProject) {
    throw new Error("Code Map storage root must be outside the project checkout");
  }
}

export class FileSystemCodeMapPersistedSnapshotStore implements CodeMapPersistedSnapshotStore {
  readonly #storageRoot: string;

  constructor(storageRoot: string) {
    if (!storageRoot.trim()) throw new TypeError("Code Map snapshot storage root must not be empty");
    this.#storageRoot = resolve(storageRoot);
  }

  revisionToken(projectId: string): string | undefined {
    const path = projectSnapshotPath(this.#storageRoot, projectId);
    try {
      const stat = statSync(path, { bigint: true });
      if (!stat.isFile()) return undefined;
      // Snapshot writers always create a new inode and atomically rename.
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  load(projectId: string): unknown | undefined {
    const path = projectSnapshotPath(this.#storageRoot, projectId);
    if (!existsSync(path)) return undefined;
    const metadata = statSync(path);
    if (!metadata.isFile()) throw new Error("Persisted Code Map snapshot is not a regular file");
    if (metadata.size > maxSnapshotBytes()) throw new Error("Persisted Code Map snapshot exceeds the read limit");
    return JSON.parse(readFileSync(path, "utf8"));
  }

  loadRefreshJob(projectId: string): unknown | undefined {
    const path = projectRefreshJobPath(this.#storageRoot, projectId);
    if (!existsSync(path)) return undefined;
    const metadata = statSync(path);
    if (!metadata.isFile()) throw new Error("Persisted Code Map refresh job is not a regular file");
    if (metadata.size > MAX_REFRESH_JOB_BYTES) throw new Error("Persisted Code Map refresh job exceeds the read limit");
    return JSON.parse(readFileSync(path, "utf8"));
  }

  saveRefreshJob(projectId: string, receipt: CodeMapRefreshJobReceipt): void {
    const path = projectRefreshJobPath(this.#storageRoot, projectId);
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(receipt)}\n`;
    if (Buffer.byteLength(serialized) > MAX_REFRESH_JOB_BYTES) {
      throw new Error("Persisted Code Map refresh job exceeds the write limit");
    }

    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, path);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporaryPath, { force: true });
    }
  }

  save(projectId: string, snapshot: PersistedCodeMapSnapshotEnvelope): void {
    const path = projectSnapshotPath(this.#storageRoot, projectId);
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(serialized) > maxSnapshotBytes()) {
      throw new Error("Persisted Code Map snapshot exceeds the write limit");
    }

    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, path);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporaryPath, { force: true });
    }
  }
}

export interface FileSystemCodeMapSourceStateOptions {
  maxFiles?: number;
  ignoredDirectories?: ReadonlySet<string>;
}

function portableRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

export class FileSystemCodeMapSourceStateProvider implements CodeMapSourceStateProvider {
  readonly #maxFiles: number;
  readonly #ignoredDirectories: ReadonlySet<string>;

  constructor(options: FileSystemCodeMapSourceStateOptions = {}) {
    this.#maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.#ignoredDirectories = options.ignoredDirectories ?? DEFAULT_CODE_MAP_IGNORED_DIRECTORIES;
  }

  rootIdentity(rootPath: string): string {
    const resolved = resolve(rootPath);
    const canonical = realpathSync.native(resolved);
    return sha256(canonical);
  }

  sourceManifestFingerprint(rootPath: string): string {
    const root = realpathSync.native(resolve(rootPath));
    const gitPaths = gitCodeMapPaths(root);
    if (gitPaths) {
      const hash = createHash("sha256");
      const excludeComposerVendor = existsSync(join(root, "composer.json"))
        && existsSync(join(root, "composer.lock"));
      let count = 0;
      for (const path of gitPaths) {
        if (excludeComposerVendor && path.startsWith("vendor/")) continue;
        if (path.split("/").some((segment) => this.#ignoredDirectories.has(segment))) continue;
        const full = resolve(root, path);
        let metadata;
        try {
          metadata = lstatSync(full, { bigint: true });
        } catch { continue; }
        if (!metadata.isFile()) continue;
        if (++count > this.#maxFiles) {
          hash.update("truncated:git:" + this.#maxFiles + "\n");
          process.emitWarning(
            "Code Map source manifest truncated to " + this.#maxFiles + " files; freshness is checked for a subset",
            { code: "QUESTBOARD_CODE_MAP_MANIFEST_TRUNCATED" },
          );
          break;
        }
        hash.update(path).update("\0").update(String(metadata.size)).update("\0")
          .update(String(metadata.mtimeNs)).update("\n");
      }
      return hash.digest("hex");
    }
    const directories = [root];
    const entries: string[] = [];

    while (directories.length > 0) {
      const directory = directories.pop()!;
      const children = readdirSync(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (child.isSymbolicLink()) continue;
        const absolutePath = resolve(directory, child.name);
        if (child.isDirectory()) {
          if (!this.#ignoredDirectories.has(child.name)) directories.push(absolutePath);
          continue;
        }
        if (!child.isFile()) continue;
        const relativePath = portableRelativePath(root, absolutePath);
        if (!safeCodeMapPath(relativePath)) continue;
        const metadata = statSync(absolutePath, { bigint: true });
        if (entries.length >= this.#maxFiles) {
          entries.push("truncated:filesystem:" + this.#maxFiles);
          process.emitWarning(
            "Code Map source manifest truncated to " + this.#maxFiles + " files; freshness is checked for a subset",
            { code: "QUESTBOARD_CODE_MAP_MANIFEST_TRUNCATED" },
          );
          directories.length = 0;
          break;
        }
        entries.push(`${relativePath}\0${metadata.size}\0${metadata.mtimeNs}`);
      }
    }

    entries.sort();
    const hash = createHash("sha256");
    for (const entry of entries) hash.update(entry).update("\n");
    return hash.digest("hex");
  }
}
