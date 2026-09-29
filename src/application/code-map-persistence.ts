import type { CodeGraphSnapshot } from "./code-intelligence.js";

export const CODE_MAP_PERSISTED_SNAPSHOT_FORMAT_VERSION = 1 as const;

export type CodeMapSnapshotSource = "fresh-index" | "persisted";
export type CodeMapSnapshotFreshness = "current" | "stale" | "unknown";
export type CodeMapSnapshotStaleReason = "source_changed" | "source_check_failed";
export type CodeMapHydrationRejectReason =
  | "corrupt"
  | "format_changed"
  | "schema_changed"
  | "project_changed"
  | "root_changed"
  | "provider_changed"
  | "storage_inside_project"
  | "graph_invalid";

export interface PersistedCodeMapSnapshotEnvelope {
  formatVersion: typeof CODE_MAP_PERSISTED_SNAPSHOT_FORMAT_VERSION;
  graphSchemaVersion: CodeGraphSnapshot["schemaVersion"];
  projectId: string;
  rootIdentity: string;
  providerConfigFingerprint: string;
  sourceManifestFingerprint?: string;
  persistedAt: string;
  graph: CodeGraphSnapshot;
}

export interface CodeMapPersistedSnapshotStore {
  load(projectId: string): unknown | undefined;
  save(projectId: string, snapshot: PersistedCodeMapSnapshotEnvelope): void;
}

export interface CodeMapSourceStateProvider {
  rootIdentity(rootPath: string): string;
  sourceManifestFingerprint(rootPath: string): string;
}

export interface CodeMapPersistenceConfig {
  store: CodeMapPersistedSnapshotStore;
  sourceState: CodeMapSourceStateProvider;
  providerConfigFingerprint: string;
  rootPathForProject?: (projectId: string) => string | undefined;
  validateStorageRootForProject?: (rootPath: string) => void;
  now?: () => string;
}

export interface CodeMapSnapshotLifecycleState {
  snapshotSource: CodeMapSnapshotSource;
  freshness: CodeMapSnapshotFreshness;
  staleReason?: CodeMapSnapshotStaleReason;
}

export interface CodeMapHydrationDiagnostic {
  hydrationRejectReason: CodeMapHydrationRejectReason;
}
