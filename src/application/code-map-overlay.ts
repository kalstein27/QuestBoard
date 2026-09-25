import type {
  CodeArchitectureNode,
  CodeArchitectureProjection,
} from "./code-map-projection.js";

export const CODE_MAP_TASK_LINK_KINDS = ["affects", "implemented_in", "investigates"] as const;
export type CodeMapTaskLinkKind = (typeof CODE_MAP_TASK_LINK_KINDS)[number];

export interface CodeMapTaskLink {
  taskId: string;
  codeNodeId: string;
  kind: CodeMapTaskLinkKind;
}

export interface CodeMapTaskOverlayNode extends CodeArchitectureNode {
  taskLinks: readonly CodeMapTaskLink[];
}

export interface CodeMapTaskOverlay {
  projectId: string;
  sourceIndexedAt: string;
  nodes: readonly CodeMapTaskOverlayNode[];
  relations: CodeArchitectureProjection["relations"];
  orphanedLinks: readonly CodeMapTaskLink[];
}

function linkIdentity(link: CodeMapTaskLink): string {
  return `${link.taskId}:${link.kind}:${link.codeNodeId}`;
}

export function overlayCodeMapTasks(
  projection: CodeArchitectureProjection,
  links: readonly CodeMapTaskLink[],
): CodeMapTaskOverlay {
  const nodeIds = new Set(projection.nodes.map((node) => node.id));
  const seen = new Set<string>();
  const validLinks: CodeMapTaskLink[] = [];
  const orphanedLinks: CodeMapTaskLink[] = [];

  for (const link of links) {
    if (!link.taskId.trim() || !link.codeNodeId.trim()) {
      throw new TypeError("Code Map Task links require non-empty taskId and codeNodeId");
    }
    const identity = linkIdentity(link);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (nodeIds.has(link.codeNodeId)) {
      validLinks.push(link);
    } else {
      orphanedLinks.push(link);
    }
  }

  const linksByNode = new Map<string, CodeMapTaskLink[]>();
  for (const link of validLinks) {
    const nodeLinks = linksByNode.get(link.codeNodeId) ?? [];
    nodeLinks.push(link);
    linksByNode.set(link.codeNodeId, nodeLinks);
  }

  const nodes: CodeMapTaskOverlayNode[] = projection.nodes.map((node) => ({
    ...node,
    taskLinks: [...(linksByNode.get(node.id) ?? [])].sort((left, right) =>
      linkIdentity(left).localeCompare(linkIdentity(right)),
    ),
  }));

  return {
    projectId: projection.projectId,
    sourceIndexedAt: projection.sourceIndexedAt,
    nodes,
    relations: projection.relations,
    orphanedLinks: [...orphanedLinks].sort((left, right) =>
      linkIdentity(left).localeCompare(linkIdentity(right)),
    ),
  };
}
