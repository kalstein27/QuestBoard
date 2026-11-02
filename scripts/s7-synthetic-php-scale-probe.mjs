// S7 synthetic scale probe: extrapolates Laravel file-path distribution only.
// Never models PHP semantic calls, never touches the source checkout or QuestBoard DB.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { CODE_GRAPH_SCHEMA_VERSION } from "../dist/src/application/code-intelligence.js";
import { materializeCodeFileHierarchy } from "../dist/src/application/code-map-hierarchy.js";
import { CodeMapService } from "../dist/src/application/code-map-service.js";
import { FileSystemCodeFileInventory } from "../dist/src/adapters/code-intelligence/file-inventory.js";

const root = "/tmp/questboard-s7-laravel-framework-20261022";
const size = Number(process.argv[2] ?? "20000");
if (![5000, 20000, 50000].includes(size)) throw new Error("Permitted synthetic sizes: 5000, 20000, 50000");
const native = await new FileSystemCodeFileInventory().listFiles(root);
assert.ok(native.length > 1000, "Expected the public Laravel checkout");
const entries = Array.from({ length: size }, (_, index) => ({
  path: `synthetic_group_${Math.floor(index / native.length).toString().padStart(3, "0")}/${native[index % native.length].path}`,
}));
const memory = () => {
  const m = process.memoryUsage();
  return { rssMiB: +(m.rss / 1048576).toFixed(1), heapUsedMiB: +(m.heapUsed / 1048576).toFixed(1), maxRssKiB: process.resourceUsage().maxRSS };
};
const base = {schemaVersion:CODE_GRAPH_SCHEMA_VERSION,projectId:"s7-synthetic-"+size,rootPath:root,indexedAt:new Date().toISOString(),nodes:[],relations:[]};
const start = performance.now();
const baseline = memory();
const graph = materializeCodeFileHierarchy(base,entries);
const elapsed = +(performance.now()-start).toFixed(1);
const after = memory();
assert.equal(graph.nodes.length,size);
assert.equal(graph.relations.length,0);
const source = {providerId:"synthetic-file-only",fidelity:"file-only",capabilities:{incrementalIndexing:false,impactAnalysis:false,callTrace:false},indexProject:async (request)=>({...base,projectId:request.projectId,rootPath:request.rootPath})};
const inventory = {listFiles:async()=>entries};
const service = new CodeMapService(source,inventory);
const refreshStart=performance.now();
const refreshed=await service.refresh({projectId:base.projectId,rootPath:root});
const serviceElapsed=+(performance.now()-refreshStart).toFixed(1);
assert.equal(refreshed.graph.nodes.length,size);
const final=memory();
console.log(JSON.stringify({kind:"synthetic_laravel_path_scale",size,realRepoNativeFiles:native.length,semantic:"not_run",relations:0,hierarchy:{durationMs:elapsed,before:baseline,after},fullCodeMapRefresh:{durationMs:serviceElapsed,after:final},peakRssMiB:+(process.resourceUsage().maxRSS/1024).toFixed(1)},null,2));
