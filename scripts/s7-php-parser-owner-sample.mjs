// Read-only fixture check: confirm real PHP Parser 5 AST produces named scopes.
import { extractPhpLexicalScopes } from "../dist/src/adapters/code-intelligence/php-lexical-scopes.js";
const root="/tmp/questboard-s7-bookstack-20261030";
const documents=[
  "app/Access/Controllers/LoginController.php",
  "app/Access/Controllers/ConfirmEmailController.php",
  "app/App/helpers.php",
];
const scopes=await extractPhpLexicalScopes(root,documents);
console.log(JSON.stringify({
  parsed:scopes.size,
  summary:[...scopes.entries()].map(([file,list])=>({
    file,total:list.length,named:list.filter(s=>s.name).length,
    samples:list.filter(s=>s.name).slice(0,7).map(s=>({name:s.name,nameRange:s.nameRange,range:s.range})),
  })),
},null,2));
