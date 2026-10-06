import assert from "node:assert/strict";
import test from "node:test";
import {
  recommendCodeMapNextAction,
  type CodeMapProviderCapabilityReport,
  type CodeMapRefreshJobReceipt,
} from "../src/index.js";

function capabilities(
  providers: CodeMapProviderCapabilityReport["providers"],
): CodeMapProviderCapabilityReport {
  return {
    providers,
    languages: [],
    indexed: false,
    health: "healthy",
    semanticCoverage: null,
    degraded: false,
  };
}

function provider(overrides: Partial<CodeMapProviderCapabilityReport["providers"][number]> = {}) {
  return {
    providerId: "scip-typescript",
    languages: ["typescript"],
    fidelity: "semantic-call" as const,
    version: "0.4.0",
    configured: true,
    installed: true,
    available: true,
    executable: "scip-typescript",
    health: "ready" as const,
    diagnostics: [],
    requirement: "required" as const,
    requirementReason: "detected_supported_language" as const,
    matchingLanguages: ["typescript"],
    ...overrides,
  };
}

function refresh(state: CodeMapRefreshJobReceipt["state"]): CodeMapRefreshJobReceipt {
  return {
    jobId: "refresh_test",
    projectId: "project-1",
    providerId: "scip-typescript",
    state,
    phase: state === "running" ? "indexing" : "complete",
    startedAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:01:00.000Z",
  };
}

const base = {
  projectId: "project-1",
  enabled: true,
  rootPathConfigured: true,
} as const;

test("Code Map next action does not invent work when runtime or canonical root is unavailable", () => {
  assert.equal(recommendCodeMapNextAction({
    ...base,
    surface: "status",
    enabled: false,
    indexed: false,
  }), null);
  assert.equal(recommendCodeMapNextAction({
    ...base,
    surface: "status",
    rootPathConfigured: false,
    indexed: false,
  }), null);
});

test("running refresh always wins over install or duplicate refresh recommendations", () => {
  assert.deepEqual(recommendCodeMapNextAction({
    ...base,
    surface: "status",
    indexed: false,
    refresh: refresh("running"),
    providerCapabilities: capabilities([
      provider({
        installed: false,
        available: false,
        health: "missing_executable",
        installOption: {
          providerId: "scip-typescript",
          sourceType: "npm",
          source: "@sourcegraph/scip-typescript",
          version: "0.4.0",
          executable: "scip-typescript",
          trust: "project-pinned",
          requiresApproval: true,
          executionBoundary: "external-host",
          permissions: ["network"],
          reindexMode: "full",
        },
      }),
    ]),
  }), {
    tool: "questboard_get_code_map_refresh_status",
    args: { projectId: "project-1" },
    reason: "refresh_in_progress",
  });
});

test("missing required provider recommends only the trusted install-request tool", () => {
  assert.deepEqual(recommendCodeMapNextAction({
    ...base,
    surface: "capabilities",
    indexed: false,
    providerCapabilities: capabilities([
      provider({
        providerId: "scip-php",
        languages: ["php"],
        installed: false,
        available: false,
        health: "missing_executable",
        executable: "scip-php",
        matchingLanguages: ["php"],
        installOption: {
          providerId: "scip-php",
          sourceType: "composer",
          source: "davidrjenni/scip-php",
          version: "test",
          executable: "scip-php",
          trust: "project-pinned",
          requiresApproval: true,
          executionBoundary: "external-host",
          permissions: ["network", "project-dependency-install"],
          reindexMode: "full",
        },
      }),
    ]),
  }), {
    tool: "questboard_request_code_map_provider_install",
    args: { projectId: "project-1", providerId: "scip-php" },
    reason: "required_provider_missing",
  });
});

test("unknown provider requirement fails closed instead of recommending install or refresh", () => {
  assert.equal(recommendCodeMapNextAction({
    ...base,
    surface: "capabilities",
    indexed: false,
    providerCapabilities: capabilities([
      provider({
        requirement: "unknown",
        requirementReason: "language_inventory_unavailable",
        matchingLanguages: [],
      }),
    ]),
  }), null);
});

test("ready unindexed and stale indexed projects recommend refresh", () => {
  const readyCapabilities = capabilities([provider()]);
  assert.deepEqual(recommendCodeMapNextAction({
    ...base,
    surface: "status",
    indexed: false,
    providerCapabilities: readyCapabilities,
  }), {
    tool: "questboard_refresh_code_map",
    args: { projectId: "project-1" },
    reason: "refresh_required_unindexed",
  });

  assert.deepEqual(recommendCodeMapNextAction({
    ...base,
    surface: "status",
    indexed: true,
    freshness: "stale",
    snapshotSource: "persisted",
    providerCapabilities: readyCapabilities,
  }), {
    tool: "questboard_refresh_code_map",
    args: { projectId: "project-1" },
    reason: "refresh_required_stale",
  });
});

test("fresh/current indexed projects recommend one bounded discovery query", () => {
  assert.deepEqual(recommendCodeMapNextAction({
    ...base,
    surface: "status",
    indexed: true,
    freshness: "current",
    snapshotSource: "persisted",
    providerCapabilities: capabilities([provider()]),
  }), {
    tool: "questboard_query_code_map",
    args: { projectId: "project-1", operation: "find_nodes", limit: 20 },
    reason: "query_indexed_snapshot",
  });

  assert.equal(recommendCodeMapNextAction({
    ...base,
    surface: "status",
    indexed: true,
    freshness: "unknown",
    snapshotSource: "persisted",
    providerCapabilities: capabilities([provider()]),
  }), null);
});

test("refresh receipts guide polling and terminal verification without replaying refresh", () => {
  assert.deepEqual(recommendCodeMapNextAction({
    ...base,
    surface: "refresh",
    indexed: false,
    refresh: refresh("running"),
  }), {
    tool: "questboard_get_code_map_refresh_status",
    args: { projectId: "project-1" },
    reason: "refresh_in_progress",
  });
  assert.deepEqual(recommendCodeMapNextAction({
    ...base,
    surface: "refresh",
    indexed: true,
    refresh: refresh("succeeded"),
  }), {
    tool: "questboard_get_code_map_status",
    args: { projectId: "project-1" },
    reason: "refresh_succeeded_verify_status",
  });
  assert.deepEqual(recommendCodeMapNextAction({
    ...base,
    surface: "refresh",
    indexed: true,
    refresh: refresh("failed"),
  }), {
    tool: "questboard_get_code_map_status",
    args: { projectId: "project-1" },
    reason: "refresh_failed_inspect_status",
  });
  assert.deepEqual(recommendCodeMapNextAction({
    ...base,
    surface: "refresh",
    indexed: false,
  }), {
    tool: "questboard_get_code_map_status",
    args: { projectId: "project-1" },
    reason: "refresh_status_unavailable",
  });
});
