import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require=createRequire(import.meta.url);
const module=await import(pathToFileURL(require.resolve("@sourcegraph/scip-typescript/dist/src/scip.js")).href);
const scip=module.scip??module.default?.scip;
const e=scip?.Language;
console.log(JSON.stringify({languageType:typeof e,keys:Object.keys(e??{}).filter(k=>/php|type|java|py|rust|go|typescript|javascript|19/i.test(k)).slice(0,40),nineteen:e?.[19],php:e?.PHP,languageEnumKeys:Object.keys(e??{}).slice(0,10)},null,2));
