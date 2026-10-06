import type { CodeMapProviderCapabilityReport } from "./code-map-provider-registry.js";
import type {
  CodeMapRefreshJobReceipt,
  CodeMapSnapshotFreshness,
  CodeMapSnapshotSource,
} from "./code-map-persistence.js";

export const CODE_MAP_RECOMMENDED_TOOLS = [
  "questboard_get_code_map_status",
  "questboard_request_code_map_provider_install",
  "questboard_refresh_code_map",
  "questboard_get_code_map_refresh_status",
  "questboard_query_code_map",
] as const;
export type CodeMapRecommendedTool = (typeof CODE_MAP_RECOMMENDED_TOOLS)[number];

export const CODE_MAP_NEXT_ACTION_REASONS = [
  "refresh_in_progress",
  "required_provider_missing",
  "refresh_required_unindexed",
  "refresh_required_stale",
  "refresh_succeeded_verify_status",
  "refresh_failed_inspect_status",
  "refresh_status_unavailable",
  "query_indexed_snapshot",
] as const;
export type CodeMapNextActionReason = (typeof CODE_MAP_NEXT_ACTION_REASONS)[number];

export interface CodeMapRecommendedNextAction {
  tool: CodeMapRecommendedTool;
  args: Readonly<Record<string, string | number>>;
  reason: CodeMapNextActionReason;
}

export interface CodeMapNextActionState {
  projectId: string;
  surface: "status" | "capabilities" | "refresh";
  enabled: boolean;
  rootPathConfigured: boolean;
  indexed: boolean;
  snapshotSource?: CodeMapSnapshotSource;
  freshness?: CodeMapSnapshotFreshness;
  providerCapabilities?: CodeMapProviderCapabilityReport;
  refresh?: CodeMapRefreshJobReceipt;
}

function action(
  tool: CodeMapRecommendedTool,
  projectId: string,
  reason: CodeMapNextActionReason,
  args: Readonly<Record<string, string | number>> = {},
): CodeMapRecommendedNextAction {
  return {
    tool,
    args: { projectId, ...args },
    reason,
  };
}

export function recommendCodeMapNextAction(
  state: CodeMapNextActionState,
): CodeMapRecommendedNextAction | null {
  if (!state.enabled || !state.rootPathConfigured) return null;

  if (state.surface === "refresh") {
    if (!state.refresh) {
      return action("questboard_get_code_map_status", state.projectId, "refresh_status_unavailable");
    }
    if (state.refresh.state === "running") {
      return action("questboard_get_code_map_refresh_status", state.projectId, "refresh_in_progress");
    }
    if (state.refresh.state === "succeeded") {
      return action("questboard_get_code_map_status", state.projectId, "refresh_succeeded_verify_status");
    }
    return action("questboard_get_code_map_status", state.projectId, "refresh_failed_inspect_status");
  }

  if (state.refresh?.state === "running") {
    return action("questboard_get_code_map_refresh_status", state.projectId, "refresh_in_progress");
  }

  const capabilities = state.providerCapabilities;
  const missingRequiredProvider = capabilities?.providers.find((provider) =>
    provider.requirement === "required"
    && !provider.available
    && Boolean(provider.installOption));
  if (missingRequiredProvider) {
    return action(
      "questboard_request_code_map_provider_install",
      state.projectId,
      "required_provider_missing",
      { providerId: missingRequiredProvider.providerId },
    );
  }

  if (capabilities?.providers.some((provider) => provider.requirement === "unknown")) {
    return null;
  }

  if (!state.indexed) {
    return action("questboard_refresh_code_map", state.projectId, "refresh_required_unindexed");
  }

  if (state.freshness === "stale") {
    return action("questboard_refresh_code_map", state.projectId, "refresh_required_stale");
  }

  if (state.freshness === "current" || state.snapshotSource === "fresh-index") {
    return action(
      "questboard_query_code_map",
      state.projectId,
      "query_indexed_snapshot",
      { operation: "find_nodes", limit: 20 },
    );
  }

  return null;
}
