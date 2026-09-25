import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_MAP_INVESTIGATION_BINDING_STATES,
  CODE_MAP_INVESTIGATION_NODE_PREVIEW_STATES,
  CODE_MAP_INVESTIGATION_RELATION_PREVIEW_STATES,
  fingerprintCodeMapInvestigationNode,
  fingerprintCodeMapInvestigationProjection,
  fingerprintCodeMapInvestigationRelation,
  investigationKindForCodeMapNode,
  investigationRelationItemTitle,
  type CodeArchitectureProjection,
} from "../src/index.js";

function projection(): CodeArchitectureProjection {
  return {
    projectId: "questboard",
    sourceIndexedAt: "2026-09-24T10:00:00.000Z",
    nodes: [
      {
        id: "code-map:node:http",
        kind: "http_api",
        title: "HTTP API",
        memberNodeIds: ["symbol:b", "symbol:a"],
      },
      {
        id: "code-map:node:service",
        kind: "application_service",
        title: "Application Service",
        memberNodeIds: ["symbol:c"],
      },
    ],
    relations: [
      {
        id: "code-map:relation:http-service",
        from: "code-map:node:http",
        to: "code-map:node:service",
        kind: "invokes",
        sourceRelationIds: ["raw:2", "raw:1"],
      },
    ],
  };
}

test("sync contract exposes explicit binding and preview states", () => {
  assert.deepEqual(CODE_MAP_INVESTIGATION_BINDING_STATES, ["active", "stale", "detached"]);
  assert.deepEqual(CODE_MAP_INVESTIGATION_NODE_PREVIEW_STATES, [
    "create",
    "unchanged",
    "evidence_changed",
    "stale",
    "detached",
  ]);
  assert.deepEqual(CODE_MAP_INVESTIGATION_RELATION_PREVIEW_STATES, [
    "create",
    "unchanged",
    "evidence_changed",
    "stale",
    "detached",
    "blocked",
  ]);
});

test("mapping helpers preserve the Investigation Item-origin flow contract", () => {
  const map = projection();
  assert.equal(investigationKindForCodeMapNode(map.nodes[0]!.kind), "code-map/http_api");
  assert.equal(
    investigationRelationItemTitle(map.relations[0]!, map.nodes[1]!),
    "invokes → Application Service",
  );
});

test("node fingerprints ignore member/evidence ordering but change for structural evidence", () => {
  const first = projection();
  const reordered = projection();
  reordered.nodes = [
    { ...reordered.nodes[0]!, memberNodeIds: ["symbol:a", "symbol:b"] },
    reordered.nodes[1]!,
  ];
  reordered.relations = [
    { ...reordered.relations[0]!, sourceRelationIds: ["raw:1", "raw:2"] },
  ];

  assert.equal(
    fingerprintCodeMapInvestigationNode(first.nodes[0]!, first),
    fingerprintCodeMapInvestigationNode(reordered.nodes[0]!, reordered),
  );

  const changedMember = projection();
  changedMember.nodes = [
    { ...changedMember.nodes[0]!, memberNodeIds: ["symbol:a", "symbol:b", "symbol:new"] },
    changedMember.nodes[1]!,
  ];
  assert.notEqual(
    fingerprintCodeMapInvestigationNode(first.nodes[0]!, first),
    fingerprintCodeMapInvestigationNode(changedMember.nodes[0]!, changedMember),
  );

  const changedTopology = projection();
  changedTopology.relations = [
    { ...changedTopology.relations[0]!, kind: "depends_on_contract" },
  ];
  assert.notEqual(
    fingerprintCodeMapInvestigationNode(first.nodes[0]!, first),
    fingerprintCodeMapInvestigationNode(changedTopology.nodes[0]!, changedTopology),
  );
});

test("relation fingerprints are deterministic and include source evidence", () => {
  const first = projection().relations[0]!;
  const reordered = { ...first, sourceRelationIds: ["raw:1", "raw:2"] } as const;
  assert.equal(
    fingerprintCodeMapInvestigationRelation(first),
    fingerprintCodeMapInvestigationRelation(reordered),
  );

  const changed = { ...first, sourceRelationIds: [...first.sourceRelationIds, "raw:3"] };
  assert.notEqual(
    fingerprintCodeMapInvestigationRelation(first),
    fingerprintCodeMapInvestigationRelation(changed),
  );
});

test("projection fingerprint is order-stable and invalidates across re-index or semantic change", () => {
  const first = projection();
  const reordered = projection();
  reordered.nodes = [...reordered.nodes].reverse();
  reordered.relations = [...reordered.relations].reverse();
  reordered.nodes = reordered.nodes.map((node) => ({ ...node, memberNodeIds: [...node.memberNodeIds].reverse() }));
  reordered.relations = reordered.relations.map((relation) => ({
    ...relation,
    sourceRelationIds: [...relation.sourceRelationIds].reverse(),
  }));

  assert.equal(
    fingerprintCodeMapInvestigationProjection(first),
    fingerprintCodeMapInvestigationProjection(reordered),
  );

  const reindexed = { ...projection(), sourceIndexedAt: "2026-09-24T10:05:00.000Z" };
  assert.notEqual(
    fingerprintCodeMapInvestigationProjection(first),
    fingerprintCodeMapInvestigationProjection(reindexed),
  );

  const changedEvidence = projection();
  changedEvidence.relations = [
    { ...changedEvidence.relations[0]!, sourceRelationIds: ["raw:1", "raw:2", "raw:3"] },
  ];
  assert.notEqual(
    fingerprintCodeMapInvestigationProjection(first),
    fingerprintCodeMapInvestigationProjection(changedEvidence),
  );
});
