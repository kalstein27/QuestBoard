import { createHash } from "node:crypto";
import type { CodeGraphSnapshot } from "./code-intelligence.js";
import { CodeMapQueryError } from "./code-map-query.js";

/** Stable serialization independent of object property insertion order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface CodeMapSnapshotIdentity {
  graphDigest: string;
  snapshotId: string;
  /** Absent if no exact provider-native artifact/run fingerprint is available. */
  providerRunFingerprint?: string;
}

/** Offset pages must belong to the same exact raw graph, not merely the same indexing timestamp. */
export function assertCodeMapExactPageSnapshot(
  input: { offset: number; expectedSnapshotId?: string | undefined; expectedSourceIndexedAt?: string | undefined },
  current: { snapshotId?: string | undefined; indexedAt: string },
  surface: "continuation" | "subsystem",
): void {
  const expectedIndexedAt = input.expectedSourceIndexedAt?.trim();
  const expectedId = input.expectedSnapshotId?.trim();
  if (input.offset > 0 && !expectedIndexedAt) {
    throw new CodeMapQueryError("code_map_query_invalid", `expectedSourceIndexedAt is required when ${surface} query offset is greater than zero`);
  }
  if (input.offset > 0 && !expectedId) {
    throw new CodeMapQueryError("code_map_query_invalid", `expectedSnapshotId is required when ${surface} query offset is greater than zero`);
  }
  if (expectedIndexedAt && expectedIndexedAt !== current.indexedAt) {
    throw new CodeMapQueryError("code_map_subsystem_snapshot_stale", `${surface} page source snapshot has changed`);
  }
  if (expectedId && expectedId !== current.snapshotId || input.offset > 0 && !current.snapshotId) {
    throw new CodeMapQueryError("code_map_snapshot_changed", "Requested Code Map snapshot is not the current exact snapshot");
  }
}

export function computeCodeMapSnapshotIdentity(input: {
  projectId: string;
  rootIdentity: string;
  providerConfigFingerprint: string;
  sourceManifestFingerprint?: string | undefined;
  graph: CodeGraphSnapshot;
}): CodeMapSnapshotIdentity {
  for (const run of input.graph.providerRuns ?? []) {
    const expected = createHash("sha256")
      .update(JSON.stringify([run.providerId, run.nativeArtifactSha256, run.indexedAt]))
      .digest("hex");
    if (expected !== run.fingerprint) throw new Error("Invalid native provider run fingerprint");
  }
  const graphDigest = sha256(input.graph);
  const runs = [...(input.graph.providerRuns ?? [])]
    .map(({ providerId, nativeArtifactSha256, indexedAt, fingerprint }) =>
      ({ providerId, nativeArtifactSha256, indexedAt, fingerprint }))
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
  const providerRunFingerprint = runs.length ? sha256(runs) : undefined;
  const snapshotId = sha256({
    projectId: input.projectId,
    rootIdentity: input.rootIdentity,
    providerConfigFingerprint: input.providerConfigFingerprint,
    sourceManifestFingerprint: input.sourceManifestFingerprint ?? null,
    sourceIndexedAt: input.graph.indexedAt,
    graphDigest,
    providerRunFingerprint: providerRunFingerprint ?? null,
  });
  return {
    graphDigest,
    snapshotId,
    ...(providerRunFingerprint ? { providerRunFingerprint } : {}),
  };
}
