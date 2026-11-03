<?php
declare(strict_types=1);

// Trusted, read-only PHP Parser 5 bridge for the QuestBoard SCIP PHP adapter.
// Input (stdin): JSON array of native SCIP document-relative PHP paths.
// Output (stdout): lexical scopes and bounded, type-proven method call sites; never code text.
// Keep all untrusted project files within the caller's canonical project root.
if (count($argv) !== 2 || !is_dir($argv[1])) {
    fwrite(STDERR, "Missing canonical PHP project root\n");
    exit(2);
}
$root = realpath($argv[1]);
if ($root === false || $root !== $argv[1]) {
    fwrite(STDERR, "Noncanonical PHP project root\n");
    exit(2);
}
require $root . '/vendor/autoload.php';
$input = stream_get_contents(STDIN, 1024 * 1024 + 1);
if ($input === false || strlen($input) > 1024 * 1024) {
    fwrite(STDERR, "PHP scope input too large\n");
    exit(2);
}
$paths = json_decode($input, true, 32, JSON_THROW_ON_ERROR);
if (!is_array($paths) || !array_is_list($paths) || count($paths) > 10000) {
    fwrite(STDERR, "Invalid PHP scope document list\n");
    exit(2);
}
$parser = (new PhpParser\ParserFactory())->createForNewestSupportedVersion();
$result = [];
$errors = 0;
$parsed = 0;
$globalScopes = 0;
$globalCallReferenceSites = 0;
$maxCallReferenceSites = 250000;

// Read declarations first. Return types can live in any other indexed file.
function qbPhpParsedFile(string $root, mixed $relative, PhpParser\Parser $parser): ?array {
    if (!is_string($relative) || strlen($relative) > 1024 || str_contains($relative, "\0")
        || !str_ends_with(strtolower($relative), '.php')) return null;
    $full = realpath($root . '/' . $relative);
    if ($full === false || !str_starts_with($full, $root . DIRECTORY_SEPARATOR)
        || !is_file($full) || filesize($full) > 3_000_000) return null;
    $source = file_get_contents($full);
    if (!is_string($source) || strlen($source) > 3_000_000) return null;
    try { $ast = $parser->parse($source); }
    catch (PhpParser\Error) { return null; }
    if ($ast === null) return null;
    $names = new PhpParser\NodeTraverser();
    $names->addVisitor(new PhpParser\NodeVisitor\NameResolver());
    return [$source, $names->traverse($ast)];
}
function qbPhpName(PhpParser\Node|null $type, ?string $owner = null): ?string {
    if ($type instanceof PhpParser\Node\NullableType) $type = $type->type;
    if (!$type instanceof PhpParser\Node\Name) return null;
    $name = ltrim($type->toString(), '\\');
    if (in_array(strtolower($name), ['self','static'], true)) return $owner;
    if (strtolower($name) === 'parent') return null;
    return $name === '' ? null : $name;
}
function qbPhpDocArray(?string $doc, string $tag, string $namespace, array $aliases): ?string {
    if (!$doc || !preg_match('/@' . preg_quote($tag, '/') .
        '\s+(?:(?:array|list)\s*<\s*(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*)\s*>|(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*)\s*\[\s*\])/i', $doc, $match)) return null;
    $name = $match[1] !== '' ? $match[1] : ($match[2] ?? '');
    if ($name === '') return null;
    if ($name[0] === '\\') return substr($name, 1);
    $pieces = explode('\\', $name);
    $alias = $aliases[strtolower($pieces[0])] ?? null;
    if ($alias !== null) return $alias . (count($pieces) > 1 ? '\\' . implode('\\', array_slice($pieces, 1)) : '');
    return $namespace !== '' ? $namespace . '\\' . $name : $name;
}
function qbPhpAliases(array $statements): array {
    $aliases = [];
    foreach ($statements as $statement) {
        if ($statement instanceof PhpParser\Node\Stmt\Use_) {
            foreach ($statement->uses as $use) {
                if ($statement->type !== PhpParser\Node\Stmt\Use_::TYPE_NORMAL) continue;
                $alias = $use->alias?->toString() ?? $use->name->getLast();
                $aliases[strtolower($alias)] = ltrim($use->name->toString(), '\\');
            }
        }
    }
    return $aliases;
}
$methodReturns = [];
$methodArrayElements = [];
foreach ($paths as $relative) {
    $parsedFile = qbPhpParsedFile($root, $relative, $parser);
    if ($parsedFile === null) continue;
    [, $decls] = $parsedFile;
    // Traverse class declarations without keeping ASTs from other documents in memory.
    foreach ($decls as $namespaceNode) {
        $statements = $namespaceNode instanceof PhpParser\Node\Stmt\Namespace_ ? $namespaceNode->stmts : [$namespaceNode];
        $namespace = $namespaceNode instanceof PhpParser\Node\Stmt\Namespace_
            ? ($namespaceNode->name?->toString() ?? '') : '';
        $aliases = qbPhpAliases($statements);
        foreach ($statements as $declaration) {
            if (!$declaration instanceof PhpParser\Node\Stmt\ClassLike || $declaration->name === null) continue;
            $qualified = $declaration->namespacedName ?? $declaration->getAttribute('namespacedName');
            $class = $qualified instanceof PhpParser\Node\Name ? $qualified->toString() : $declaration->name->toString();
            foreach ($declaration->getMethods() as $method) {
                $key = strtolower($class . '::' . $method->name->toString());
                $return = qbPhpName($method->returnType, $class);
                // Docblock arrays are accepted only for an array or absent native return type.
                $nativeArray = $method->returnType instanceof PhpParser\Node\Identifier
                    && strtolower($method->returnType->toString()) === 'array';
                $element = ($nativeArray || $method->returnType === null)
                    ? qbPhpDocArray($method->getDocComment()?->getText(), 'return', $namespace, $aliases) : null;
                if (array_key_exists($key, $methodReturns)) {
                    $methodReturns[$key] = null;
                    $methodArrayElements[$key] = null;
                } else {
                    $methodReturns[$key] = $return;
                    $methodArrayElements[$key] = $element;
                }
            }
        }
    }
    if (count($methodReturns) > 150000) {
        fwrite(STDERR, "PHP method signature cap exceeded\n");
        exit(3);
    }
}

foreach ($paths as $relative) {
    if (!is_string($relative) || strlen($relative) > 1024
        || str_contains($relative, "\0")
        || !str_ends_with(strtolower($relative), '.php')) {
        continue;
    }
    $fullPath = realpath($root . '/' . $relative);
    if ($fullPath === false || !str_starts_with($fullPath, $root . DIRECTORY_SEPARATOR)
        || !is_file($fullPath) || filesize($fullPath) > 3_000_000) {
        continue;
    }
    $source = file_get_contents($fullPath);
    if (!is_string($source) || strlen($source) > 3_000_000) continue;
    try {
        $ast = $parser->parse($source);
    } catch (PhpParser\Error) {
        $errors++;
        continue;
    }
    if ($ast === null) continue;
    $parsed++;
    $lineStarts = [0];
    $offset = -1;
    while (($offset = strpos($source, "\n", $offset + 1)) !== false) {
        $lineStarts[] = $offset + 1;
    }
    $visitor = new class($source, $lineStarts, $methodReturns, $methodArrayElements) extends PhpParser\NodeVisitorAbstract {
        public array $scopes = [];
        public int $callCount = 0;
        public int $unresolvedCount = 0;
        private array $classStack = [];
        private string $namespace = '';
        private array $aliases = [];
        public function __construct(
            private readonly string $source, private readonly array $lineStarts,
            private readonly array $methodReturns, private readonly array $methodArrayElements,
        ) {}

        private function range(PhpParser\Node $node): ?array {
            $first = $node->getStartFilePos();
            $last = $node->getEndFilePos();
            if ($first < 0 || $last < $first || $last >= strlen($this->source)) return null;
            $start = $this->point($node->getStartLine(), $first);
            $end = $this->point($node->getEndLine(), $last + 1);
            if ($start === null || $end === null) return null;
            return [$start[0], $start[1], $end[0], $end[1]];
        }

        private function point(int $line, int $offset): ?array {
            if ($line < 1 || !isset($this->lineStarts[$line - 1])) return null;
            $lineStart = $this->lineStarts[$line - 1];
            if ($offset < $lineStart || $offset > strlen($this->source)) return null;
            // SCIP columns are Unicode UTF-16 positions; PHP parser offsets are bytes.
            $prefix = substr($this->source, $lineStart, $offset - $lineStart);
            if (function_exists('mb_check_encoding') && function_exists('mb_convert_encoding')) {
                if (!mb_check_encoding($prefix, 'UTF-8')) return null;
                $utf16 = mb_convert_encoding($prefix, 'UTF-16LE', 'UTF-8');
                return [$line - 1, intdiv(strlen($utf16), 2)];
            }
            // A PHP installation without ext-mbstring can still prove ASCII
            // source columns. Non-ASCII offsets are excluded, never guessed.
            if (preg_match('/[^\\x00-\\x7F]/', $prefix) === 1) return null;
            return [$line - 1, strlen($prefix)];
        }


        private function resolvedType(?PhpParser\Node $type): ?string {
            if ($type instanceof PhpParser\Node\NullableType) $type = $type->type;
            return qbPhpName($type, $this->classStack
                ? ($this->classStack[count($this->classStack) - 1]['class'] ?? null) : null);
        }

        private function classContext(PhpParser\Node\Stmt\ClassLike $node): array {
            $qualified = $node->namespacedName ?? $node->getAttribute('namespacedName');
            $class = $qualified instanceof PhpParser\Node\Name ? $qualified->toString() : null;
            if ($class === null && $node->name !== null) $class = $node->name->toString();
            $properties = [];
            $propertyDefinitions = [];
            $docMethods = [];
            $comment = $node->getDocComment();
            if ($comment !== null) {
                $text = $comment->getText();
                // Only explicit class-level @method annotations qualify.
                if (preg_match_all('/(?:^|\n)[ \t]*\*?[ \t]*(@method[^\r\n(]{0,256})\(/',
                    $text, $annotations, PREG_OFFSET_CAPTURE)) {
                    foreach ($annotations[1] as [$annotation, $offset]) {
                        if (count($docMethods) >= 1024) break;
                        $prefix = rtrim(substr($annotation, strlen('@method')));
                        if (!preg_match('/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)$/', $prefix, $name)) continue;
                        $namePosition = strrpos($annotation, $name[1]);
                        if ($namePosition === false) continue;
                        $absolute = $comment->getStartFilePos() + $offset + $namePosition;
                        $before = substr($this->source, 0, $absolute);
                        $line = substr_count($before, "\n") + 1;
                        $start = $this->point($line, $absolute);
                        $end = $this->point($line, $absolute + strlen($name[1]));
                        if ($start === null || $end === null) continue;
                        $docMethods[] = [
                            'name'=>$name[1],
                            'nameRange'=>[$start[0],$start[1],$end[0],$end[1]],
                            'isStatic'=>preg_match('/^\s*static\b/i', $prefix) === 1,
                        ];
                    }
                }
            }
            foreach ($node->stmts as $member) {
                if (!$member instanceof PhpParser\Node\Stmt\Property) continue;
                $type = $this->resolvedType($member->type);
                foreach ($member->props as $prop) {
                    if (($range = $this->range($prop->name)) !== null) {
                        $propertyDefinitions[] = ['name'=>$prop->name->toString(), 'nameRange'=>$range];
                    }
                    if ($type !== null) $properties[$prop->name->toString()] = $type;
                }
            }
            $ancestors = [];
            if ($node instanceof PhpParser\Node\Stmt\Class_ && $node->extends instanceof PhpParser\Node\Name) {
                $ancestors[] = ['relation'=>'extends','className'=>$node->extends->toString()];
            }
            if ($node instanceof PhpParser\Node\Stmt\Class_) {
                foreach ($node->implements as $iface) $ancestors[] = ['relation'=>'implements','className'=>$iface->toString()];
            }
            if ($node instanceof PhpParser\Node\Stmt\Interface_) {
                foreach ($node->extends as $iface) $ancestors[] = ['relation'=>'extends','className'=>$iface->toString()];
            }
            foreach ($node->stmts as $member) {
                if ($member instanceof PhpParser\Node\Stmt\TraitUse) {
                    foreach ($member->traits as $trait) $ancestors[] = ['relation'=>'trait','className'=>$trait->toString()];
                }
            }
            return ['class'=>$class,'properties'=>$properties,'ancestors'=>$ancestors,
                'propertyDefinitions'=>$propertyDefinitions,'docMethods'=>$docMethods];
        }

        private function methodCalls(PhpParser\Node $function, array $properties): array {
            $known = []; $arrayTypes = []; $calls = []; $unresolved = []; $propertyAccesses = [];
            $doc = $function->getDocComment()?->getText();
            if ($doc) {
                preg_match_all('/@param\\s+((?:array|list)\\s*<\\s*\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*\\s*>|\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*\\s*\\[\\s*\\])\\s+\\$([A-Za-z_][A-Za-z0-9_]*)/i', $doc, $paramMatches, PREG_SET_ORDER);
                foreach ($paramMatches as $match) {
                    $type = qbPhpDocArray('/** @return ' . $match[1] . ' */', 'return', $this->namespace, $this->aliases);
                    if ($type !== null) $arrayTypes[$match[2]] = $type;
                }
            }
            $currentClass = $this->classStack ? ($this->classStack[count($this->classStack)-1]['class'] ?? null) : null;
            foreach ($function->getParams() as $param) {
                $name = $param->var instanceof PhpParser\Node\Expr\Variable ? $param->var->name : null;
                $type = $this->resolvedType($param->type);
                if (is_string($name) && $type !== null) $known[$name] = ['className'=>$type, 'source'=>'native'];
            }
            $key = static fn(string $class, string $name): string => strtolower(ltrim($class, '\\').'::'.$name);
            $infer = function($expr, array $known) use (&$infer, $properties, $currentClass, $key): ?array {
                if ($expr instanceof PhpParser\Node\Expr\Variable && is_string($expr->name)) {
                    return $expr->name === 'this' && $currentClass !== null
                        ? ['className'=>$currentClass,'source'=>'native'] : ($known[$expr->name] ?? null);
                }
                if ($expr instanceof PhpParser\Node\Expr\New_) {
                    $type = qbPhpName($expr->class,$currentClass);
                    return $type === null ? null : ['className'=>$type,'source'=>'native'];
                }
                if ($expr instanceof PhpParser\Node\Expr\PropertyFetch
                    && $expr->var instanceof PhpParser\Node\Expr\Variable && $expr->var->name === 'this'
                    && $expr->name instanceof PhpParser\Node\Identifier) {
                    $type = $properties[$expr->name->toString()] ?? null;
                    return $type === null ? null : ['className'=>$type,'source'=>'native'];
                }
                if ($expr instanceof PhpParser\Node\Expr\StaticCall
                    && $expr->name instanceof PhpParser\Node\Identifier) {
                    $class = qbPhpName($expr->class,$currentClass);
                    $type = $class === null ? null : ($this->methodReturns[$key($class,$expr->name->toString())] ?? null);
                    return $type === null ? null : ['className'=>$type,'source'=>'native'];
                }
                if (($expr instanceof PhpParser\Node\Expr\MethodCall
                    || $expr instanceof PhpParser\Node\Expr\NullsafeMethodCall)
                    && $expr->name instanceof PhpParser\Node\Identifier) {
                    $receiver = $infer($expr->var,$known);
                    $type = $receiver === null ? null
                        : ($this->methodReturns[$key($receiver['className'],$expr->name->toString())] ?? null);
                    return $type === null ? null : ['className'=>$type,'source'=>$receiver['source']];
                }
                return null;
            };
            $inferArray = function($expr,array $known,array $arrays) use ($infer,$key,$currentClass): ?string {
                if ($expr instanceof PhpParser\Node\Expr\Variable && is_string($expr->name)) return $arrays[$expr->name] ?? null;
                if (($expr instanceof PhpParser\Node\Expr\StaticCall || $expr instanceof PhpParser\Node\Expr\MethodCall)
                    && $expr->name instanceof PhpParser\Node\Identifier) {
                    $class = $expr instanceof PhpParser\Node\Expr\StaticCall
                        ? qbPhpName($expr->class,$currentClass)
                        : ($infer($expr->var,$known)['className'] ?? null);
                    return $class === null ? null : ($this->methodArrayElements[$key($class,$expr->name->toString())] ?? null);
                }
                return null;
            };
            $modified = function($part,array &$names) use (&$modified): void {
                if (is_array($part)) { foreach ($part as $entry) $modified($entry,$names); return; }
                if (!$part instanceof PhpParser\Node || $part instanceof PhpParser\Node\FunctionLike
                    || $part instanceof PhpParser\Node\Stmt\ClassLike) return;
                if (($part instanceof PhpParser\Node\Expr\Assign || $part instanceof PhpParser\Node\Expr\AssignOp)
                    && $part->var instanceof PhpParser\Node\Expr\Variable && is_string($part->var->name)) $names[$part->var->name]=true;
                if ($part instanceof PhpParser\Node\Stmt\Foreach_) {
                    foreach ([$part->valueVar,$part->keyVar] as $bound)
                        if ($bound instanceof PhpParser\Node\Expr\Variable && is_string($bound->name)) $names[$bound->name]=true;
                }
                foreach ($part->getSubNodeNames() as $field) $modified($part->$field,$names);
            };
            $walk = function($part,array &$types,array &$arrays) use (&$walk,$infer,$inferArray,$modified,&$calls,&$unresolved,&$propertyAccesses,$currentClass,$function): void {
                if (is_array($part)) { foreach ($part as $entry) $walk($entry,$types,$arrays); return; }
                if (!$part instanceof PhpParser\Node || $part instanceof PhpParser\Node\FunctionLike
                    || $part instanceof PhpParser\Node\Stmt\ClassLike) return;
                if ($part instanceof PhpParser\Node\Stmt\Expression && $part->expr instanceof PhpParser\Node\Expr\Assign) {
                    $walk($part->expr,$types,$arrays);
                    $name = $part->expr->var instanceof PhpParser\Node\Expr\Variable ? $part->expr->var->name : null;
                    $hint = qbPhpDocArray($part->getDocComment()?->getText(),'var',$this->namespace,$this->aliases);
                    if (is_string($name) && $hint !== null) $arrays[$name]=$hint;
                    return;
                }
                if ($part instanceof PhpParser\Node\Expr\Assign) {
                    if ($part->var instanceof PhpParser\Node\Expr\PropertyFetch
                        && $part->var->name instanceof PhpParser\Node\Identifier) {
                        $receiver = $infer($part->var->var, $types);
                        $range = $this->range($part->var->name);
                        if ($receiver !== null && $range !== null) {
                            $propertyAccesses[] = ['className'=>$receiver['className'],
                                'name'=>$part->var->name->toString(),'nameRange'=>$range,'kind'=>'writes',
                                'evidenceSource'=>$receiver['source']];
                        }
                        $walk($part->var->var, $types, $arrays);
                    }
                    $walk($part->expr,$types,$arrays);
                    if ($part->var instanceof PhpParser\Node\Expr\Variable && is_string($part->var->name)) {
                        $name=$part->var->name; $type=$infer($part->expr,$types);
                        if ($type!==null) $types[$name]=$type; else unset($types[$name]);
                        $element=$inferArray($part->expr,$types,$arrays);
                        if ($element!==null) $arrays[$name]=$element; else unset($arrays[$name]);
                    }
                    return;
                }
                if ($part instanceof PhpParser\Node\Stmt\If_) {
                    $walk($part->cond,$types,$arrays);
                    $before=$types; $beforeArrays=$arrays;
                    $then=$before; $thenArrays=$beforeArrays;
                    if ($part->cond instanceof PhpParser\Node\Expr\Instanceof_
                        && $part->cond->expr instanceof PhpParser\Node\Expr\Variable
                        && is_string($part->cond->expr->name)) {
                        $narrow=qbPhpName($part->cond->class,$currentClass);
                        if ($narrow!==null) $then[$part->cond->expr->name]=['className'=>$narrow,'source'=>'native'];
                    }
                    $walk($part->stmts,$then,$thenArrays);
                    foreach ($part->elseifs as $arm) { $tmp=$before; $tmpArrays=$beforeArrays; $walk($arm,$tmp,$tmpArrays); }
                    if ($part->else!==null) { $tmp=$before; $tmpArrays=$beforeArrays; $walk($part->else,$tmp,$tmpArrays); }
                    $changed=[]; $modified($part,$changed);
                    foreach ($changed as $name=>$_) unset($types[$name],$arrays[$name]);
                    return;
                }
                if ($part instanceof PhpParser\Node\Stmt\Foreach_) {
                    $walk($part->expr,$types,$arrays);
                    $tmp=$types; $tmpArrays=$arrays;
                    if ($part->valueVar instanceof PhpParser\Node\Expr\Variable && is_string($part->valueVar->name)) {
                        $name=$part->valueVar->name; $element=$inferArray($part->expr,$types,$arrays);
                        if ($element!==null) $tmp[$name]=['className'=>$element,'source'=>'docblock']; else unset($tmp[$name]);
                        unset($tmpArrays[$name]);
                    }
                    if ($part->keyVar instanceof PhpParser\Node\Expr\Variable && is_string($part->keyVar->name))
                        unset($tmp[$part->keyVar->name],$tmpArrays[$part->keyVar->name]);
                    $walk($part->stmts,$tmp,$tmpArrays);
                    $changed=[]; $modified($part,$changed);
                    foreach ($changed as $name=>$_) unset($types[$name],$arrays[$name]);
                    return;
                }
                if ($part instanceof PhpParser\Node\Stmt\For_ || $part instanceof PhpParser\Node\Stmt\While_
                    || $part instanceof PhpParser\Node\Stmt\Do_ || $part instanceof PhpParser\Node\Stmt\Switch_
                    || $part instanceof PhpParser\Node\Stmt\TryCatch) {
                    $tmp=$types; $tmpArrays=$arrays;
                    foreach ($part->getSubNodeNames() as $field) $walk($part->$field,$tmp,$tmpArrays);
                    $changed=[]; $modified($part,$changed);
                    foreach ($changed as $name=>$_) unset($types[$name],$arrays[$name]);
                    return;
                }
                if ($part instanceof PhpParser\Node\Expr\PropertyFetch
                    && $part->name instanceof PhpParser\Node\Identifier) {
                    $receiver = $infer($part->var, $types);
                    $range = $this->range($part->name);
                    if ($receiver !== null && $range !== null) {
                        $propertyAccesses[] = ['className'=>$receiver['className'],
                            'name'=>$part->name->toString(),'nameRange'=>$range,'kind'=>'reads',
                            'evidenceSource'=>$receiver['source']];
                    }
                }
                if ($part instanceof PhpParser\Node\Expr\AssignOp && $part->var instanceof PhpParser\Node\Expr\Variable
                    && is_string($part->var->name)) unset($types[$part->var->name],$arrays[$part->var->name]);
                if ($part instanceof PhpParser\Node\Expr\StaticCall
                    && $part->name instanceof PhpParser\Node\Identifier
                    && ($range = $this->range($part->name)) !== null
                    && !($function instanceof PhpParser\Node\Expr\Closure)
                    && !($function instanceof PhpParser\Node\Expr\ArrowFunction)) {
                    $class = qbPhpName($part->class, $currentClass);
                    if ($class !== null) $calls[] = ['className'=>$class,
                        'name'=>$part->name->toString(),'nameRange'=>$range,'evidenceSource'=>'native'];
                    else $unresolved[] = ['name'=>$part->name->toString(),'nameRange'=>$range];
                }
                if (($function instanceof PhpParser\Node\Expr\Closure
                    || $function instanceof PhpParser\Node\Expr\ArrowFunction)
                    && $part instanceof PhpParser\Node\Expr\StaticCall
                    && $part->name instanceof PhpParser\Node\Identifier
                    && ($range = $this->range($part->name)) !== null) {
                    $unresolved[] = ['name'=>$part->name->toString(),'nameRange'=>$range];
                }
                if (($part instanceof PhpParser\Node\Expr\MethodCall || $part instanceof PhpParser\Node\Expr\NullsafeMethodCall)
                    && $part->name instanceof PhpParser\Node\Identifier) {
                    $type=$infer($part->var,$types); $range=$this->range($part->name);
                    if ($range!==null) {
                        if ($type!==null) $calls[]=['className'=>$type['className'],'name'=>$part->name->toString(),
                            'nameRange'=>$range,'evidenceSource'=>$type['source']];
                        else $unresolved[]=['name'=>$part->name->toString(),'nameRange'=>$range];
                    }
                }
                foreach ($part->getSubNodeNames() as $field) $walk($part->$field,$types,$arrays);
            };
            $walk($function->getStmts() ?? [],$known,$arrayTypes);
            $this->callCount+=count($calls);
            $this->unresolvedCount+=count($unresolved);
            return ['calls'=>$calls,'unresolvedCalls'=>$unresolved,'propertyAccesses'=>$propertyAccesses];
        }

        public function fileCallSites(array $statements): array {
            $calls = []; $unresolved = [];
            $walk = function($part) use (&$walk, &$calls, &$unresolved): void {
                if (is_array($part)) { foreach ($part as $entry) $walk($entry); return; }
                if (!$part instanceof PhpParser\Node) return;
                if ($part instanceof PhpParser\Node\Stmt\ClassLike
                    || $part instanceof PhpParser\Node\FunctionLike) return;
                if ($part instanceof PhpParser\Node\Expr\StaticCall
                    && $part->name instanceof PhpParser\Node\Identifier) {
                    $range = $this->range($part->name);
                    $class = qbPhpName($part->class);
                    if ($range !== null) {
                        if ($class !== null) $calls[] = ['className'=>$class,
                            'name'=>$part->name->toString(),'nameRange'=>$range,'evidenceSource'=>'native'];
                        else $unresolved[]=['name'=>$part->name->toString(),'nameRange'=>$range];
                    }
                } elseif (($part instanceof PhpParser\Node\Expr\MethodCall
                    || $part instanceof PhpParser\Node\Expr\NullsafeMethodCall)
                    && $part->name instanceof PhpParser\Node\Identifier
                    && ($range = $this->range($part->name)) !== null) {
                    $unresolved[]=['name'=>$part->name->toString(),'nameRange'=>$range];
                }
                foreach ($part->getSubNodeNames() as $field) $walk($part->$field);
            };
            foreach ($statements as $statement) {
                if ($statement instanceof PhpParser\Node\Stmt\Namespace_) $walk($statement->stmts);
                else $walk($statement);
            }
            return ['calls'=>$calls,'unresolvedCalls'=>$unresolved];
        }

        public function enterNode(PhpParser\Node $node): ?int {
            if ($node instanceof PhpParser\Node\Stmt\Namespace_) {
                $this->namespace = $node->name?->toString() ?? '';
                $this->aliases = qbPhpAliases($node->stmts);
            }
            if ($node instanceof PhpParser\Node\Stmt\ClassLike) {
                $context = $this->classContext($node);
                $this->classStack[] = $context;
                if ($context['class'] !== null && ($range = $this->range($node)) !== null) {
                    $this->scopes[] = ['type'=>'class','className'=>$context['class'],
                        'nameRange'=>$node->name ? $this->range($node->name) : null,
                        'range'=>$range,'ancestors'=>$context['ancestors'],
                        'propertyDefinitions'=>$context['propertyDefinitions'],
                        'docMethods'=>$context['docMethods']];
                }
                return null;
            }
            $name = null;
            $nameRange = null;
            if ($node instanceof PhpParser\Node\Stmt\ClassMethod) {
                $type = 'method';
                $name = $node->name->toString();
                $nameRange = $this->range($node->name);
            } elseif ($node instanceof PhpParser\Node\Stmt\Function_) {
                $type = 'function';
                $name = $node->name->toString();
                $nameRange = $this->range($node->name);
            } elseif ($node instanceof PhpParser\Node\Expr\Closure
                || $node instanceof PhpParser\Node\Expr\ArrowFunction) {
                // An anonymous lexical function is a barrier: its calls must
                // never be attributed to an outer named function.
                $type = 'anonymous';
            } else {
                return null;
            }
            $range = $this->range($node);
            if ($range === null || ($type !== 'anonymous' && $nameRange === null)) return null;
            $context = $this->classStack ? $this->classStack[count($this->classStack) - 1] : null;
            $sites = $this->methodCalls($node,$context['properties'] ?? []);
            if ($type === 'anonymous') {
                foreach ($sites['calls'] as $call) {
                    $sites['unresolvedCalls'][] = ['name'=>$call['name'],'nameRange'=>$call['nameRange']];
                }
                $sites['calls'] = [];
            }
            $this->scopes[] = [
                'type' => $type,
                'range' => $range,
                ...($name === null ? [] : ['name' => $name, 'nameRange' => $nameRange]),
                ...($type === 'method' && $context !== null && $context['class'] !== null
                    ? ['className' => $context['class'],
                        'isStatic'=>$node->isStatic(),
                        'isConcretePublic'=>$node->isPublic() && !$node->isAbstract()] : []),
                ...($sites['calls'] ? ['calls'=>$sites['calls']] : []),
                ...($sites['unresolvedCalls'] ? ['unresolvedCalls'=>$sites['unresolvedCalls']] : []),
                ...($type !== 'anonymous' && $sites['propertyAccesses']
                    ? ['propertyAccesses'=>$sites['propertyAccesses']] : []),
            ];
            return null;
        }
        public function leaveNode(PhpParser\Node $node): ?int {
            if ($node instanceof PhpParser\Node\Stmt\ClassLike) array_pop($this->classStack);
            return null;
        }
    };
    // Resolve all names before collecting method-local facts: when NameResolver
    // and the collector share a pass, the method body's new/typed-property nodes
    // have not been visited yet at the method's enterNode callback.
    $resolver = new PhpParser\NodeTraverser();
    $resolver->addVisitor(new PhpParser\NodeVisitor\NameResolver());
    $resolved = $resolver->traverse($ast);
    $traverser = new PhpParser\NodeTraverser();
    $traverser->addVisitor($visitor);
    $traverser->traverse($resolved);
    $globalSites = $visitor->fileCallSites($resolved);
    if ($globalSites['calls'] || $globalSites['unresolvedCalls']) {
        $visitor->scopes[] = [
            'type'=>'file',
            'range'=>[0,0,count($lineStarts)-1,strlen($source) - $lineStarts[count($lineStarts)-1]],
            ...($globalSites['calls'] ? ['calls'=>$globalSites['calls']] : []),
            ...($globalSites['unresolvedCalls'] ? ['unresolvedCalls'=>$globalSites['unresolvedCalls']] : []),
        ];
    }
    $globalScopes += count($visitor->scopes);
    foreach ($visitor->scopes as $scope) {
        $globalCallReferenceSites += count($scope['calls'] ?? [])
            + count($scope['unresolvedCalls'] ?? [])
            + count($scope['propertyAccesses'] ?? []);
    }
    if ($globalScopes > 150000 || $globalCallReferenceSites > $maxCallReferenceSites) {
        fwrite(STDERR, "PHP scope or call/reference site count exceeds bounded contract\n");
        exit(3);
    }
    $result[$relative] = $visitor->scopes;
}
echo json_encode(['documents' => $result, 'parsed' => $parsed, 'errors' => $errors],
    JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
