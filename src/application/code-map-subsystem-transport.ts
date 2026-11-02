import type { CodeSourceSubsystemRead } from "./code-map-subsystem-read.js";

/** Bound the shared HTTP/MCP overview; full evidence remains available in paged queries. */
export const CODE_MAP_SUBSYSTEM_RESPONSE_MAX_BYTES = 48 * 1024;

type Overview = CodeSourceSubsystemRead & {
  responseTruncation?: { reason: "response_byte_cap"; maxBytes: number };
};

function byteSize(value: Overview): number {
  return Buffer.byteLength(JSON.stringify({ subsystems: value }), "utf8");
}

export function boundCodeMapSubsystemOverview(
  source: CodeSourceSubsystemRead,
  maxBytes = CODE_MAP_SUBSYSTEM_RESPONSE_MAX_BYTES,
): Overview {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2048) {
    throw new RangeError("Code Map overview byte cap is invalid");
  }
  if (byteSize(source) <= maxBytes) return source;

  let overview: Overview = {
    ...source,
    truncated: true,
    responseTruncation: { reason: "response_byte_cap", maxBytes },
    nodes: source.nodes.map((node) => ({
      ...node,
      notableNodes: node.notableNodes.slice(0, 1).map((notable) => ({
        ...notable,
        directSourceRelationIds: notable.directSourceRelationIds.slice(0, 1),
        directRelationEvidenceTruncated: notable.directRelationEvidenceTruncated
          || notable.directSourceRelationIds.length > 1,
      })),
      notableNodesTruncated: node.notableNodesTruncated || node.notableNodes.length > 1,
    })),
    relations: source.relations.map((relation) => ({
      ...relation,
      sourceRelationIds: relation.sourceRelationIds.slice(0, 1),
      evidenceSample: relation.evidenceSample.slice(0, 1),
      evidenceTruncated: relation.evidenceTruncated
        || relation.sourceRelationIds.length > 1 || relation.evidenceSample.length > 1,
      ...(relation.sourceRelationIds.length > 1 || relation.evidenceSample.length > 1
        ? { evidenceTruncationReason: "evidence_sample_cap" as const } : {}),
    })),
  };
  if (byteSize(overview) <= maxBytes) return overview;

  // Larger values must shed optional evidence before dropping subsystem summaries.
  overview = {
    ...overview,
    nodes: overview.nodes.map((node) => ({
      ...node,
      notableNodes: [],
      notableNodesTruncated: node.notableNodeCount > 0 || node.notableNodesTruncated,
    })),
    relations: overview.relations.map((relation) => ({
      ...relation,
      sourceRelationIds: [],
      evidenceSample: [],
      evidenceTruncated: relation.sourceRelationCount > 0 || relation.evidenceTruncated,
      evidenceTruncationReason: "evidence_sample_cap" as const,
    })),
  };
  while (byteSize(overview) > maxBytes && (overview.nodes.length || overview.relations.length)) {
    overview = overview.relations.length >= overview.nodes.length
      ? { ...overview, relations: overview.relations.slice(0, -1) }
      : { ...overview, nodes: overview.nodes.slice(0, -1) };
  }
  if (byteSize(overview) > maxBytes) {
    throw new Error("Code Map subsystem summary metadata exceeds the response byte cap");
  }
  return overview;
}
