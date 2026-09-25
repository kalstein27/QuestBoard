import {
  assertValidCodeGraphSnapshot,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
} from "./code-intelligence.js";
import {
  overlayCodeMapTasks,
  type CodeMapTaskLink,
  type CodeMapTaskOverlay,
} from "./code-map-overlay.js";
import {
  projectCodeArchitecture,
  type CodeArchitectureProjection,
} from "./code-map-projection.js";

export type CodeMapRefreshMode = "full" | "incremental" | "cache-hit";

export interface CodeMapSnapshot {
  graph: CodeGraphSnapshot;
  projection: CodeArchitectureProjection;
}

export interface CodeMapRefreshResult extends CodeMapSnapshot {
  mode: CodeMapRefreshMode;
  changedArchitectureNodeIds: readonly string[];
}

function architectureNodeFingerprint(
  node: CodeArchitectureProjection["nodes"][number],
  projection: CodeArchitectureProjection,
): string {
  const attachedRelations = projection.relations
    .filter((relation) => relation.from === node.id || relation.to === node.id)
    .map((relation) => `${relation.from}:${relation.kind}:${relation.to}`)
    .sort();
  return JSON.stringify({
    kind: node.kind,
    title: node.title,
    members: [...node.memberNodeIds].sort(),
    relations: attachedRelations,
  });
}

function changedArchitectureNodeIds(
  previous: CodeArchitectureProjection | undefined,
  next: CodeArchitectureProjection,
): string[] {
  if (!previous) return next.nodes.map((node) => node.id);

  const previousById = new Map(previous.nodes.map((node) => [node.id, node] as const));
  const nextById = new Map(next.nodes.map((node) => [node.id, node] as const));
  const allIds = new Set([...previousById.keys(), ...nextById.keys()]);
  const changed: string[] = [];

  for (const id of allIds) {
    const before = previousById.get(id);
    const after = nextById.get(id);
    if (!before || !after) {
      changed.push(id);
      continue;
    }
    if (
      architectureNodeFingerprint(before, previous) !==
      architectureNodeFingerprint(after, next)
    ) {
      changed.push(id);
    }
  }
  return changed.sort();
}

export class CodeMapService {
  readonly #provider: CodeIntelligenceProvider;
  readonly #cache = new Map<string, CodeMapSnapshot>();

  constructor(provider: CodeIntelligenceProvider) {
    this.#provider = provider;
  }

  get capabilities(): CodeIntelligenceProvider["capabilities"] {
    return this.#provider.capabilities;
  }

  get providerId(): string {
    return this.#provider.providerId ?? "unknown";
  }

  getCached(projectId: string): CodeMapSnapshot | undefined {
    return this.#cache.get(projectId);
  }

  async refresh(request: CodeIndexRequest): Promise<CodeMapRefreshResult> {
    const cached = this.#cache.get(request.projectId);
    if (cached && request.changes && request.changes.length === 0) {
      return {
        ...cached,
        mode: "cache-hit",
        changedArchitectureNodeIds: [],
      };
    }

    const graph = await this.#provider.indexProject(request);
    if (graph.projectId !== request.projectId) {
      throw new Error(
        `Code intelligence provider returned project ${graph.projectId} for ${request.projectId}`,
      );
    }
    if (graph.rootPath !== request.rootPath) {
      throw new Error(
        `Code intelligence provider returned root ${graph.rootPath} for ${request.rootPath}`,
      );
    }
    assertValidCodeGraphSnapshot(graph);

    const projection = projectCodeArchitecture(graph);
    const changedIds = changedArchitectureNodeIds(cached?.projection, projection);
    const snapshot: CodeMapSnapshot = { graph, projection };
    this.#cache.set(request.projectId, snapshot);

    return {
      ...snapshot,
      mode: cached && request.changes ? "incremental" : "full",
      changedArchitectureNodeIds: changedIds,
    };
  }

  overlayTasks(projectId: string, links: readonly CodeMapTaskLink[]): CodeMapTaskOverlay {
    const cached = this.#cache.get(projectId);
    if (!cached) {
      throw new Error(`Code Map has not been indexed for project ${projectId}`);
    }
    return overlayCodeMapTasks(cached.projection, links);
  }

  invalidate(projectId: string): void {
    this.#cache.delete(projectId);
  }
}
