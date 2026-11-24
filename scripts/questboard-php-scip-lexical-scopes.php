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
        '\s+((?:(?:array|list)\s*<[^>\r\n]{1,200}>|\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*(?:\[\]){1,4}))(?:\s*\|\s*null)?/i', $doc, $match)) return null;
    $suffix = substr($doc, strpos($doc, $match[0]) + strlen($match[0]));
    if (preg_match('/^\s*\|/', $suffix)) return null; // multi-class union has no single element type
    $expression = $match[1];
    if (preg_match('/^(?:array|list)\s*<\s*(?:(?:int|string|array-key)\s*,\s*)?(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*)(\s*(?:\[\s*\]){0,3})\s*>$/i',
        $expression, $inner)) {
        $name = $inner[1];
        $depth = 1 + substr_count($inner[2], '[');
    } elseif (preg_match('/^(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*)((?:\[\]){1,4})$/', $expression, $inner)) {
        $name = $inner[1];
        $depth = substr_count($inner[2], '[');
    } else return null;
    if ($depth < 1 || $depth > 4) return null;
    if ($name[0] === '\\') return substr($name, 1) . str_repeat('[]', $depth - 1);
    $pieces = explode('\\', $name);
    $alias = $aliases[strtolower($pieces[0])] ?? null;
    $resolved = $alias !== null
        ? $alias . (count($pieces) > 1 ? '\\' . implode('\\', array_slice($pieces, 1)) : '')
        : ($namespace !== '' ? $namespace . '\\' . $name : $name);
    return $resolved . str_repeat('[]', $depth - 1);
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
$methodNullableReturns = [];
$methodArrayElements = [];
$propertyTypes = [];
$propertyNullableTypes = [];
$functionByRefArgs = [];
$methodByRefArgs = [];
$classParents = [];
$fileStaticReturns = [];
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
            if ($declaration instanceof PhpParser\Node\Stmt\Function_) {
                $qualified = $declaration->namespacedName ?? $declaration->getAttribute('namespacedName');
                $functionName = $qualified instanceof PhpParser\Node\Name
                    ? $qualified->toString()
                    : ($namespace === '' ? '' : $namespace . '\\') . $declaration->name->toString();
                $key = strtolower($functionName);
                $byRef = [];
                foreach ($declaration->getParams() as $position => $parameter) {
                    if ($parameter->byRef && $parameter->var instanceof PhpParser\Node\Expr\Variable
                        && is_string($parameter->var->name))
                        $byRef[] = ['position'=>$position, 'name'=>$parameter->var->name];
                }
                $functionByRefArgs[$key] = array_key_exists($key,$functionByRefArgs) ? null : $byRef;
            }
            if (!$declaration instanceof PhpParser\Node\Stmt\ClassLike || $declaration->name === null) continue;
            $qualified = $declaration->namespacedName ?? $declaration->getAttribute('namespacedName');
            $class = $qualified instanceof PhpParser\Node\Name ? $qualified->toString() : $declaration->name->toString();
            if ($declaration instanceof PhpParser\Node\Stmt\Class_
                && $declaration->extends instanceof PhpParser\Node\Name)
                $classParents[strtolower($class)] = $declaration->extends->toString();
            foreach ($declaration->stmts as $member) {
                if (!$member instanceof PhpParser\Node\Stmt\Property) continue;
                $propertyType = qbPhpName($member->type, $class);
                foreach ($member->props as $property) {
                    $key = strtolower($class . '::' . $property->name->toString());
                    $propertyTypes[$key] = array_key_exists($key, $propertyTypes)
                        ? null : $propertyType;
                    $propertyNullableTypes[$key] = array_key_exists($key, $propertyNullableTypes)
                        || $member->type instanceof PhpParser\Node\NullableType;
                }
            }
            foreach ($declaration->getMethods() as $method) {
                $key = strtolower($class . '::' . $method->name->toString());
                $byRef = [];
                foreach ($method->getParams() as $position => $parameter) {
                    if ($parameter->byRef && $parameter->var instanceof PhpParser\Node\Expr\Variable
                        && is_string($parameter->var->name))
                        $byRef[] = ['position'=>$position, 'name'=>$parameter->var->name];
                }
                $methodByRefArgs[$key] = array_key_exists($key,$methodByRefArgs) ? null : $byRef;
                $return = qbPhpName($method->returnType, $class);
                // Keep the existing A2 method-return narrowing, but remember
                // nullability separately so a closure cannot treat ?T as T.
                $methodNullableReturns[$key] = array_key_exists($key, $methodReturns)
                    || $method->returnType instanceof PhpParser\Node\NullableType;
                // File-level X::factory()->method() may use only one native,
                // non-nullable, non-union return class from a static method.
                // Late static binding and duplicate signatures are ambiguous.
                $fileReturn = $method->isStatic() && $method->isPublic() && !$method->isAbstract()
                    && $method->returnType instanceof PhpParser\Node\Name
                    && strtolower($method->returnType->toString()) !== 'static'
                    && strtolower($method->returnType->toString()) !== 'parent'
                    ? $return : null;
                $fileStaticReturns[$key] = array_key_exists($key, $fileStaticReturns)
                    ? null : $fileReturn;
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
    $visitor = new class($source, $lineStarts, $methodReturns, $methodNullableReturns, $methodArrayElements, $propertyTypes, $propertyNullableTypes, $functionByRefArgs, $methodByRefArgs, $classParents, $fileStaticReturns) extends PhpParser\NodeVisitorAbstract {
        public array $scopes = [];
        public int $callCount = 0;
        public int $unresolvedCount = 0;
        private array $classStack = [];
        // AST-node-local snapshots: never promote a closure's captured types
        // into its enclosing method or a sibling anonymous function.
        private array $closureCaptures = [];
        private string $namespace = '';
        private array $aliases = [];
        public function __construct(
            private readonly string $source, private readonly array $lineStarts,
            private readonly array $methodReturns, private readonly array $methodNullableReturns,
            private readonly array $methodArrayElements,
            private readonly array $propertyTypes, private readonly array $propertyNullableTypes,
            private readonly array $functionByRefArgs, private readonly array $methodByRefArgs,
            private readonly array $classParents,
            private readonly array $fileStaticReturns,
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

        private function initializerRange(?PhpParser\Node\Expr $value, array $nameRange): ?array {
            if ($value === null || ($range = $this->range($value)) === null) return null;
            // Keep only the expression owned by this member. In particular, a
            // multi-constant/property statement must not own the next member.
            if ($range[0] < $nameRange[2]
                || ($range[0] === $nameRange[2] && $range[1] < $nameRange[3])) return null;
            return $range;
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
            $constantDefinitions = [];
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
                        $valueRange = $this->initializerRange($prop->default, $range);
                        $propertyDefinitions[] = ['name'=>$prop->name->toString(), 'nameRange'=>$range,
                            ...($valueRange === null ? [] : ['valueRange'=>$valueRange])];
                    }
                    if ($type !== null) $properties[$prop->name->toString()] = $type;
                }
            }
            foreach ($node->stmts as $member) {
                if ($member instanceof PhpParser\Node\Stmt\ClassConst) {
                    foreach ($member->consts as $const) {
                        if (($range = $this->range($const->name)) !== null) {
                            $valueRange = $this->initializerRange($const->value, $range);
                            $constantDefinitions[] = [
                                'name'=>$const->name->toString(), 'nameRange'=>$range, 'kind'=>'constant',
                                ...($valueRange === null ? [] : ['valueRange'=>$valueRange]),
                            ];
                        }
                    }
                } elseif ($member instanceof PhpParser\Node\Stmt\EnumCase) {
                    if (($range = $this->range($member->name)) !== null) {
                        $valueRange = $this->initializerRange($member->expr, $range);
                        $constantDefinitions[] = [
                            'name'=>$member->name->toString(), 'nameRange'=>$range, 'kind'=>'enum_case',
                            ...($valueRange === null ? [] : ['valueRange'=>$valueRange]),
                        ];
                    }
                }
                if (count($constantDefinitions) > 15000) break;
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
                'propertyDefinitions'=>$propertyDefinitions,'constantDefinitions'=>$constantDefinitions,
                'docMethods'=>$docMethods];
        }

        private function methodCalls(PhpParser\Node $function, array $properties): array {
            $known = []; $arrayTypes = []; $calls = []; $unresolved = []; $propertyAccesses = [];
            // Reference aliases outlive assignments. Once an alias exists,
            // reassigning either name does not prove a stable receiver type.
            $referenceTainted = [];
            if ($function instanceof PhpParser\Node\Expr\Closure) {
                $known = $this->closureCaptures[spl_object_id($function)] ?? [];
                unset($this->closureCaptures[spl_object_id($function)]);
            }
            $doc = $function->getDocComment()?->getText();
            if ($doc) {
                preg_match_all('/@param\\s+([^\\r\\n$]{1,160}?)\\s+\\$([A-Za-z_][A-Za-z0-9_]*)/i', $doc, $paramMatches, PREG_SET_ORDER);
                foreach ($paramMatches as $match) {
                    $type = qbPhpDocArray('/** @return ' . $match[1] . ' */', 'return', $this->namespace, $this->aliases);
                    // An array-or-null annotation cannot prove that indexing
                    // will yield a single receiver. Element unions/shapes
                    // already fail closed in qbPhpDocArray().
                    if ($type !== null && !preg_match('/\|\s*null\b/i', $match[1]))
                        $arrayTypes[$match[2]] = $type;
                }
            }
            $currentClass = $this->classStack ? ($this->classStack[count($this->classStack)-1]['class'] ?? null) : null;
            $arrayParams = [];
            $untypedClosureParams = [];
            foreach ($function->getParams() as $param) {
                $name = $param->var instanceof PhpParser\Node\Expr\Variable ? $param->var->name : null;
                $type = $this->resolvedType($param->type);
                if (is_string($name) && $type !== null) $known[$name] = [
                    'className'=>$type, 'source'=>'native',
                    'nullable'=>$param->type instanceof PhpParser\Node\NullableType,
                ];
                if (is_string($name)) $arrayParams[$name] = true;
                if ($function instanceof PhpParser\Node\Expr\Closure && is_string($name)
                    && $param->type === null && !$param->byRef) $untypedClosureParams[$name] = true;
                // An array-element docblock must not contradict a native
                // scalar/object/nullable/union parameter declaration.
                if (is_string($name) && isset($arrayTypes[$name])
                    && $param->type !== null
                    && !($param->type instanceof PhpParser\Node\Identifier
                        && strtolower($param->type->toString()) === 'array'))
                    unset($arrayTypes[$name]);
            }
            // A @param tag alone cannot introduce a phantom local variable.
            foreach (array_keys($arrayTypes) as $name) {
                if (!isset($arrayParams[$name])) unset($arrayTypes[$name]);
            }
            $key = static fn(string $class, string $name): string => strtolower(ltrim($class, '\\').'::'.$name);
            $infer = function($expr, array $known) use (&$infer, $properties, $currentClass, $key, &$referenceTainted): ?array {
                if ($expr instanceof PhpParser\Node\Expr\CallLike && $expr->isFirstClassCallable()) return null;
                if ($expr instanceof PhpParser\Node\Expr\Variable && is_string($expr->name)) {
                    if (isset($referenceTainted[$expr->name])) return null;
                    return $expr->name === 'this' && $currentClass !== null
                        ? ['className'=>$currentClass,'source'=>'native'] : ($known[$expr->name] ?? null);
                }
                if ($expr instanceof PhpParser\Node\Expr\New_) {
                    $type = qbPhpName($expr->class,$currentClass);
                    return $type === null ? null : ['className'=>$type,'source'=>'native'];
                }
                if ($expr instanceof PhpParser\Node\Expr\Clone_) return $infer($expr->expr,$known);
                if ($expr instanceof PhpParser\Node\Expr\BinaryOp\Coalesce) {
                    $left=$infer($expr->left,$known); $right=$infer($expr->right,$known);
                    if ($left !== null && !($left['nullable'] ?? false)) return $left;
                    return $left !== null && $right !== null
                        && strcasecmp($left['className'],$right['className']) === 0
                        ? ['className'=>$left['className'],
                            'source'=>$left['source'] === 'docblock' || $right['source'] === 'docblock'
                                ? 'docblock' : 'native',
                            'nullable'=>$right['nullable'] ?? false] : null;
                }
                if ($expr instanceof PhpParser\Node\Expr\Ternary) {
                    $left=$infer($expr->if ?? $expr->cond,$known); $right=$infer($expr->else,$known);
                    return $left !== null && $right !== null
                        && strcasecmp($left['className'],$right['className']) === 0
                        ? ['className'=>$left['className'],
                            'source'=>$left['source'] === 'docblock' || $right['source'] === 'docblock'
                                ? 'docblock' : 'native',
                            'nullable'=>($left['nullable'] ?? false) || ($right['nullable'] ?? false)] : null;
                }
                if ($expr instanceof PhpParser\Node\Expr\PropertyFetch
                    && $expr->var instanceof PhpParser\Node\Expr\Variable && $expr->var->name === 'this'
                    && $expr->name instanceof PhpParser\Node\Identifier) {
                    $type = $properties[$expr->name->toString()] ?? null;
                    return $type === null ? null : ['className'=>$type,'source'=>'native',
                        'nullable'=>$currentClass !== null
                            && ($this->propertyNullableTypes[$key($currentClass,$expr->name->toString())] ?? false)];
                }
                if (($expr instanceof PhpParser\Node\Expr\PropertyFetch
                    || $expr instanceof PhpParser\Node\Expr\NullsafePropertyFetch)
                    && $expr->name instanceof PhpParser\Node\Identifier) {
                    $receiver=$infer($expr->var,$known);
                    $propertyKey = $receiver === null ? null : $key($receiver['className'],$expr->name->toString());
                    $type=$propertyKey === null ? null : ($this->propertyTypes[$propertyKey] ?? null);
                    return $type === null ? null
                        : ['className'=>$type,'source'=>$receiver['source'],
                            'nullable'=>($receiver['nullable'] ?? false)
                                || ($this->propertyNullableTypes[$propertyKey] ?? false)];
                }
                if ($expr instanceof PhpParser\Node\Expr\StaticCall
                    && $expr->name instanceof PhpParser\Node\Identifier) {
                    $class = qbPhpName($expr->class,$currentClass);
                    $methodKey = $class === null ? null : $key($class,$expr->name->toString());
                    $type = $methodKey === null ? null : ($this->methodReturns[$methodKey] ?? null);
                    return $type === null ? null : ['className'=>$type,'source'=>'native',
                        'nullable'=>$this->methodNullableReturns[$methodKey] ?? false];
                }
                if (($expr instanceof PhpParser\Node\Expr\MethodCall
                    || $expr instanceof PhpParser\Node\Expr\NullsafeMethodCall)
                    && $expr->name instanceof PhpParser\Node\Identifier) {
                    $receiver = $infer($expr->var,$known);
                    $methodKey = $receiver === null ? null : $key($receiver['className'],$expr->name->toString());
                    $type = $methodKey === null ? null : ($this->methodReturns[$methodKey] ?? null);
                    return $type === null ? null : ['className'=>$type,'source'=>$receiver['source'],
                        'nullable'=>($receiver['nullable'] ?? false)
                            || ($this->methodNullableReturns[$methodKey] ?? false)];
                }
                return null;
            };
            $inferArray = function($expr,array $known,array $arrays) use (&$inferArray,$infer,$key,$currentClass,&$referenceTainted): ?string {
                if ($expr instanceof PhpParser\Node\Expr\CallLike && $expr->isFirstClassCallable()) return null;
                if ($expr instanceof PhpParser\Node\Expr\Variable && is_string($expr->name))
                    return isset($referenceTainted[$expr->name]) ? null : ($arrays[$expr->name] ?? null);
                if ($expr instanceof PhpParser\Node\Expr\ArrayDimFetch) {
                    $element=$inferArray($expr->var,$known,$arrays);
                    return $element !== null && str_ends_with($element,'[]')
                        ? substr($element,0,-2) : null;
                }
                if ($expr instanceof PhpParser\Node\Expr\FuncCall
                    && $expr->name instanceof PhpParser\Node\Name
                    && in_array(strtolower($expr->name->toString()),
                        ['array_pop','array_shift','current','end','reset'],true)
                    && count($expr->args) === 1) {
                    $element=$inferArray($expr->args[0]->value,$known,$arrays);
                    return $element !== null && str_ends_with($element,'[]')
                        ? substr($element,0,-2) : null;
                }
                if (($expr instanceof PhpParser\Node\Expr\StaticCall || $expr instanceof PhpParser\Node\Expr\MethodCall)
                    && $expr->name instanceof PhpParser\Node\Identifier) {
                    $class = $expr instanceof PhpParser\Node\Expr\StaticCall
                        ? qbPhpName($expr->class,$currentClass)
                        : ($infer($expr->var,$known)['className'] ?? null);
                    return $class === null ? null : ($this->methodArrayElements[$key($class,$expr->name->toString())] ?? null);
                }
                return null;
            };
            $arrayElementReceiver = function($expr, array $types, array $arrays) use ($inferArray): ?array {
                if (!$expr instanceof PhpParser\Node\Expr\ArrayDimFetch) return null;
                // An ordinary variable index is valid with a proven
                // homogeneous array element type. Arbitrary index
                // expressions, append syntax and dynamic array bases are not.
                for ($part = $expr; $part instanceof PhpParser\Node\Expr\ArrayDimFetch; $part = $part->var) {
                    if ($part->dim === null
                        || !($part->dim instanceof PhpParser\Node\Expr\Variable
                            && is_string($part->dim->name))
                        && !$part->dim instanceof PhpParser\Node\Scalar\Int_
                        && !$part->dim instanceof PhpParser\Node\Scalar\String_) return null;
                }
                if (!$part instanceof PhpParser\Node\Expr\Variable
                    || !is_string($part->name)) return null;
                $element = $inferArray($expr->var, $types, $arrays);
                if ($element === null || str_ends_with($element, '[]')
                    || !preg_match('/^\\\\?[A-Za-z_][A-Za-z0-9_]*(?:\\\\[A-Za-z_][A-Za-z0-9_]*)*$/D', $element))
                    return null;
                return ['className'=>$element,'source'=>'docblock'];
            };
            // These builtins can replace or add elements through an array
            // argument. They invalidate homogeneous element-type evidence.
            $arrayMutationTargets = function($part, array $types = []) use ($infer,$currentClass,$key): array {
                $byRef = [];
                if ($part instanceof PhpParser\Node\Expr\FuncCall
                    && $part->name instanceof PhpParser\Node\Name) {
                    $name = strtolower(ltrim($part->name->toString(), '\\'));
                    $byRef = in_array($name,
                        ['array_push', 'array_unshift', 'array_splice', 'array_walk', 'array_walk_recursive'], true)
                        ? [['position'=>0,'name'=>'array']] : null;
                    if ($byRef === null) {
                        $qualified = $part->name instanceof PhpParser\Node\Name\FullyQualified
                            ? $name : ($this->namespace === '' ? $name : strtolower($this->namespace) . '\\' . $name);
                        $byRef = $this->functionByRefArgs[$qualified] ?? $this->functionByRefArgs[$name] ?? [];
                    }
                } elseif (($part instanceof PhpParser\Node\Expr\MethodCall
                    || $part instanceof PhpParser\Node\Expr\NullsafeMethodCall)
                    && $part->name instanceof PhpParser\Node\Identifier) {
                    $receiver = $infer($part->var, $types);
                    $class = $receiver['className'] ?? null;
                } elseif ($part instanceof PhpParser\Node\Expr\StaticCall
                    && $part->name instanceof PhpParser\Node\Identifier) {
                    $class = qbPhpName($part->class,$currentClass);
                } else return [];
                if (isset($class) && $class !== null) {
                    // A child may inherit an implementation with by-reference
                    // parameters. A declared override takes precedence.
                    for ($depth = 0; $depth < 24; $depth++) {
                        $signature = $key($class,$part->name->toString());
                        if (array_key_exists($signature,$this->methodByRefArgs)) {
                            $byRef = $this->methodByRefArgs[$signature] ?? [];
                            break;
                        }
                        $class = $this->classParents[strtolower(ltrim($class,'\\'))] ?? null;
                        if ($class === null) break;
                    }
                }
                $names = [];
                foreach ($part->args as $index => $arg) {
                    if (!$arg instanceof PhpParser\Node\Arg
                        || !$arg->value instanceof PhpParser\Node\Expr\Variable
                        || !is_string($arg->value->name)) continue;
                    foreach ($byRef as $parameter) {
                        if ($arg->name !== null
                            ? strcasecmp($arg->name->toString(), $parameter['name']) !== 0
                            : $index !== $parameter['position']) continue;
                        $names[] = $arg->value->name;
                    }
                }
                return array_values(array_unique($names));
            };
            $modified = function($part,array &$names,array $types = []) use (&$modified,$arrayMutationTargets): void {
                if (is_array($part)) { foreach ($part as $entry) $modified($entry,$names,$types); return; }
                if (!$part instanceof PhpParser\Node || $part instanceof PhpParser\Node\FunctionLike
                    || $part instanceof PhpParser\Node\Stmt\ClassLike) return;
                foreach ($arrayMutationTargets($part,$types) as $name) $names[$name] = true;
                if ($part instanceof PhpParser\Node\Expr\AssignRef) {
                    foreach ([$part->var,$part->expr] as $value)
                        if ($value instanceof PhpParser\Node\Expr\Variable && is_string($value->name))
                            $names[$value->name] = true;
                }
                if ($part instanceof PhpParser\Node\Stmt\Unset_) {
                    foreach ($part->vars as $value) {
                        while ($value instanceof PhpParser\Node\Expr\ArrayDimFetch) $value=$value->var;
                        if ($value instanceof PhpParser\Node\Expr\Variable && is_string($value->name))
                            $names[$value->name] = true;
                    }
                }
                if (($part instanceof PhpParser\Node\Expr\Assign || $part instanceof PhpParser\Node\Expr\AssignOp)
                    && $part->var instanceof PhpParser\Node\Expr\Variable && is_string($part->var->name)) $names[$part->var->name]=true;
                if (($part instanceof PhpParser\Node\Expr\Assign || $part instanceof PhpParser\Node\Expr\AssignOp)
                    && $part->var instanceof PhpParser\Node\Expr\ArrayDimFetch) {
                    $base = $part->var;
                    while ($base instanceof PhpParser\Node\Expr\ArrayDimFetch) $base = $base->var;
                    if ($base instanceof PhpParser\Node\Expr\Variable && is_string($base->name))
                        $names[$base->name] = true;
                }
                if ($part instanceof PhpParser\Node\Stmt\Foreach_) {
                    foreach ([$part->valueVar,$part->keyVar] as $bound)
                        if ($bound instanceof PhpParser\Node\Expr\Variable && is_string($bound->name)) $names[$bound->name]=true;
                    if ($part->byRef) {
                        $base=$part->expr;
                        while ($base instanceof PhpParser\Node\Expr\ArrayDimFetch) $base=$base->var;
                        if ($base instanceof PhpParser\Node\Expr\Variable && is_string($base->name))
                            $names[$base->name]=true;
                    }
                }
                foreach ($part->getSubNodeNames() as $field) $modified($part->$field,$names,$types);
            };
            $walk = function($part,array &$types,array &$arrays) use (&$walk,$infer,$inferArray,$arrayElementReceiver,$arrayMutationTargets,$modified,&$referenceTainted,&$calls,&$unresolved,&$propertyAccesses,$currentClass,$function,$untypedClosureParams): void {
                if (is_array($part)) { foreach ($part as $entry) $walk($entry,$types,$arrays); return; }
                if ($part instanceof PhpParser\Node\Expr\Closure) {
                    $captured = [];
                    $changed = [];
                    $modified($part->stmts,$changed,$types);
                    foreach ($part->uses as $use) {
                        $name = $use->var instanceof PhpParser\Node\Expr\Variable ? $use->var->name : null;
                        if ($use->byRef && is_string($name)) {
                            // A by-ref capture that can write this variable
                            // can mutate it after a later assignment. Merely
                            // observing an object through a reference does not
                            // invalidate a subsequent by-value capture.
                            if (isset($changed[$name])) {
                                $referenceTainted[$name] = true;
                                unset($types[$name],$arrays[$name]);
                            }
                            continue;
                        }
                        if (!$use->byRef && is_string($name) && !isset($referenceTainted[$name])
                            && isset($types[$name]) && !($types[$name]['nullable'] ?? false))
                            $captured[$name] = $types[$name];
                    }
                    $this->closureCaptures[spl_object_id($part)] = $captured;
                    return;
                }
                if (!$part instanceof PhpParser\Node || $part instanceof PhpParser\Node\FunctionLike
                    || $part instanceof PhpParser\Node\Stmt\ClassLike) return;
                if ($part instanceof PhpParser\Node\Expr\FuncCall) {
                    foreach ($part->getSubNodeNames() as $field) $walk($part->$field,$types,$arrays);
                    foreach ($arrayMutationTargets($part,$types) as $name) unset($arrays[$name]);
                    return;
                }
                if ($part instanceof PhpParser\Node\Expr\AssignRef) {
                    $walk($part->expr,$types,$arrays);
                    // Both roots can be mutated through the other alias even
                    // after a later assignment or a flow-branch join.
                    foreach ([$part->var,$part->expr] as $value) {
                        while ($value instanceof PhpParser\Node\Expr\ArrayDimFetch) $value=$value->var;
                        if ($value instanceof PhpParser\Node\Expr\Variable && is_string($value->name)) {
                            $referenceTainted[$value->name] = true;
                            unset($arrays[$value->name],$types[$value->name]);
                        }
                    }
                    return;
                }
                if ($part instanceof PhpParser\Node\Stmt\Unset_) {
                    $changed=[]; $modified($part,$changed,$types);
                    foreach ($changed as $name=>$_) unset($types[$name],$arrays[$name]);
                    return;
                }
                // A local @var on a direct closure-parameter call is evidence
                // for that statement only, not a new parameter declaration.
                if ($part instanceof PhpParser\Node\Stmt\Expression
                    && $part->expr instanceof PhpParser\Node\Expr\MethodCall
                    && !$part->expr->isFirstClassCallable()
                    && $part->expr->var instanceof PhpParser\Node\Expr\Variable
                    && is_string($part->expr->var->name)) {
                    $name = $part->expr->var->name;
                    $doc = $part->getDocComment()?->getText();
                    if (isset($untypedClosureParams[$name])
                        && !isset($referenceTainted[$name]) && !isset($types[$name]) && !isset($arrays[$name])
                        && $doc !== null && preg_match_all('/@var\s+(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*)\s+\$([A-Za-z_][A-Za-z0-9_]*)\b/i',
                            $doc, $annotations, PREG_SET_ORDER) === 1 && $annotations[0][2] === $name) {
                        $type = qbPhpDocArray('/** @return '.$annotations[0][1].'[] */',
                            'return',$this->namespace,$this->aliases);
                        if ($type !== null && !str_ends_with($type,'[]')) {
                            $types[$name]=['className'=>$type,'source'=>'docblock'];
                            $walk($part->expr,$types,$arrays);
                            unset($types[$name],$arrays[$name]);
                            return;
                        }
                    }
                }
                if ($part instanceof PhpParser\Node\Stmt\Expression && $part->expr instanceof PhpParser\Node\Expr\Assign) {
                    $walk($part->expr,$types,$arrays);
                    $name = $part->expr->var instanceof PhpParser\Node\Expr\Variable ? $part->expr->var->name : null;
                    $doc=$part->getDocComment()?->getText();
                    $hint = qbPhpDocArray($doc,'var',$this->namespace,$this->aliases);
                    if (is_string($name) && $hint !== null) $arrays[$name]=$hint;
                    if (is_string($name) && $doc !== null
                        && preg_match('/@var\s+(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*)\s+\$([A-Za-z_][A-Za-z0-9_]*)/i',
                            $doc,$annotation)
                        && $annotation[2] === $name) {
                        $type=qbPhpDocArray('/** @return '.$annotation[1].'[] */',
                            'return',$this->namespace,$this->aliases);
                        if ($type !== null && !str_ends_with($type,'[]'))
                            $types[$name]=['className'=>$type,'source'=>'docblock'];
                    }
                    return;
                }
                if ($part instanceof PhpParser\Node\Expr\Assign) {
                    if ($part->var instanceof PhpParser\Node\Expr\ArrayDimFetch) {
                        $walk($part->expr,$types,$arrays);
                        $walk($part->var,$types,$arrays);
                        $base=$part->var;
                        while ($base instanceof PhpParser\Node\Expr\ArrayDimFetch) $base=$base->var;
                        if ($base instanceof PhpParser\Node\Expr\Variable && is_string($base->name))
                            unset($arrays[$base->name]);
                        return;
                    }
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
                        $item = null;
                        if ($part->expr instanceof PhpParser\Node\Expr\ArrayDimFetch) {
                            $item=$inferArray($part->expr->var,$types,$arrays);
                        } elseif ($part->expr instanceof PhpParser\Node\Expr\FuncCall
                            && $part->expr->name instanceof PhpParser\Node\Name
                            && in_array(strtolower($part->expr->name->toString()),
                                ['array_pop','array_shift','current','end','reset'],true)
                            && count($part->expr->args) === 1) {
                            $item=$inferArray($part->expr->args[0]->value,$types,$arrays);
                        }
                        if ($item !== null && !str_ends_with($item,'[]')) {
                            $type=['className'=>$item,'source'=>'docblock'];
                        }
                        if ($type!==null) $types[$name]=$type; else unset($types[$name]);
                        $element=$inferArray($part->expr,$types,$arrays);
                        if ($item !== null && str_ends_with($item,'[]')) $element=substr($item,0,-2);
                        if ($element!==null) $arrays[$name]=$element; else unset($arrays[$name]);
                    }
                    return;
                }
                if ($part instanceof PhpParser\Node\Stmt\If_) {
                    $walk($part->cond,$types,$arrays);
                    $before=$types; $beforeArrays=$arrays; $beforeTaint=$referenceTainted;
                    $then=$before; $thenArrays=$beforeArrays;
                    if ($part->cond instanceof PhpParser\Node\Expr\Instanceof_
                        && $part->cond->expr instanceof PhpParser\Node\Expr\Variable
                        && is_string($part->cond->expr->name)) {
                        $narrow=qbPhpName($part->cond->class,$currentClass);
                        if ($narrow!==null) $then[$part->cond->expr->name]=['className'=>$narrow,'source'=>'native'];
                    }
                    $walk($part->stmts,$then,$thenArrays);
                    $branches=[$then]; $arrayBranches=[$thenArrays]; $taintBranches=[$referenceTainted];
                    foreach ($part->elseifs as $arm) {
                        $tmp=$before; $tmpArrays=$beforeArrays;
                        $referenceTainted=$beforeTaint;
                        $walk($arm,$tmp,$tmpArrays);
                        $branches[]=$tmp; $arrayBranches[]=$tmpArrays;
                        $taintBranches[]=$referenceTainted;
                    }
                    if ($part->else!==null) {
                        $tmp=$before; $tmpArrays=$beforeArrays;
                        $referenceTainted=$beforeTaint;
                        $walk($part->else,$tmp,$tmpArrays);
                        $branches[]=$tmp; $arrayBranches[]=$tmpArrays;
                        $taintBranches[]=$referenceTainted;
                    } else {
                        $branches[]=$before; $arrayBranches[]=$beforeArrays;
                        $taintBranches[]=$beforeTaint;
                    }
                    $referenceTainted=$beforeTaint;
                    $changed=[]; $modified($part,$changed,$before);
                    foreach ($changed as $name=>$_) {
                        $candidate=$branches[0][$name] ?? null;
                        foreach ($branches as $branch) {
                            $other=$branch[$name] ?? null;
                            if ($candidate===null || $other===null
                                || strcasecmp($candidate['className'],$other['className']) !== 0) {
                                $candidate=null; break;
                            }
                            if ($other['source']==='docblock') $candidate['source']='docblock';
                            if ($other['nullable'] ?? false) $candidate['nullable']=true;
                        }
                        if ($candidate!==null) $types[$name]=$candidate; else unset($types[$name]);
                    }
                    // Join array element evidence once, including mutations
                    // through receivers first created inside a branch.
                    foreach (array_unique([...array_keys($changed), ...array_keys($beforeArrays)]) as $name) {
                        $element=$arrayBranches[0][$name] ?? null;
                        foreach ($arrayBranches as $branch) {
                            if ($element===null || !isset($branch[$name])
                                || strcasecmp($branch[$name],$element) !== 0) { $element=null; break; }
                        }
                        if ($element!==null) $arrays[$name]=$element; else unset($arrays[$name]);
                    }
                    foreach ($taintBranches as $tainted) $referenceTainted += $tainted;
                    foreach ($referenceTainted as $name=>$_) unset($types[$name],$arrays[$name]);
                    // Only a simple, unconditional early exit proves the
                    // opposite guard on the surviving path. Never infer past
                    // a nonterminating/conditional body or a reference alias.
                    if (!$part->elseifs && $part->else === null && count($part->stmts) === 1
                        && ($part->stmts[0] instanceof PhpParser\Node\Stmt\Return_
                            || ($part->stmts[0] instanceof PhpParser\Node\Stmt\Expression
                                && $part->stmts[0]->expr instanceof PhpParser\Node\Expr\Throw_))) {
                        $cond=$part->cond;
                        if ($cond instanceof PhpParser\Node\Expr\BinaryOp\Identical) {
                            $left=$cond->left; $right=$cond->right;
                            if ($left instanceof PhpParser\Node\Expr\ConstFetch) { $tmp=$left; $left=$right; $right=$tmp; }
                            if ($left instanceof PhpParser\Node\Expr\Variable && is_string($left->name)
                                && $right instanceof PhpParser\Node\Expr\ConstFetch
                                && strtolower($right->name->toString()) === 'null'
                                && isset($before[$left->name]) && !isset($referenceTainted[$left->name])) {
                                $types[$left->name]=$before[$left->name];
                                $types[$left->name]['nullable']=false;
                            }
                        } elseif ($cond instanceof PhpParser\Node\Expr\BooleanNot
                            && $cond->expr instanceof PhpParser\Node\Expr\Instanceof_
                            && $cond->expr->expr instanceof PhpParser\Node\Expr\Variable
                            && is_string($cond->expr->expr->name)) {
                            $name=$cond->expr->expr->name;
                            $narrow=qbPhpName($cond->expr->class,$currentClass);
                            if ($narrow!==null && !isset($referenceTainted[$name]))
                                $types[$name]=['className'=>$narrow,'source'=>'native','nullable'=>false];
                        }
                    }
                    return;
                }
                if ($part instanceof PhpParser\Node\Stmt\Foreach_) {
                    $walk($part->expr,$types,$arrays);
                    $tmp=$types; $tmpArrays=$arrays;
                    if ($part->valueVar instanceof PhpParser\Node\Expr\Variable && is_string($part->valueVar->name)) {
                        $name=$part->valueVar->name; $element=$inferArray($part->expr,$types,$arrays);
                        if ($element!==null && !str_ends_with($element,'[]')) {
                            $tmp[$name]=['className'=>$element,'source'=>'docblock'];
                            unset($tmpArrays[$name]);
                        } elseif ($element!==null) {
                            unset($tmp[$name]);
                            $tmpArrays[$name]=substr($element,0,-2);
                        } else {
                            unset($tmp[$name],$tmpArrays[$name]);
                        }
                    }
                    if ($part->keyVar instanceof PhpParser\Node\Expr\Variable && is_string($part->keyVar->name))
                        unset($tmp[$part->keyVar->name],$tmpArrays[$part->keyVar->name]);
                    if ($part->byRef && $part->expr instanceof PhpParser\Node\Expr\Variable
                        && is_string($part->expr->name))
                        unset($tmpArrays[$part->expr->name]);
                    $walk($part->stmts,$tmp,$tmpArrays);
                    $changed=[]; $modified($part,$changed,$types);
                    foreach ($changed as $name=>$_) {
                        if (!isset($types[$name],$tmp[$name])
                            || strcasecmp($types[$name]['className'],$tmp[$name]['className']) !== 0) {
                            unset($types[$name]);
                        }
                        if (!isset($arrays[$name],$tmpArrays[$name])
                            || strcasecmp($arrays[$name],$tmpArrays[$name]) !== 0) unset($arrays[$name]);
                    }
                    if ($part->byRef && $part->expr instanceof PhpParser\Node\Expr\Variable
                        && is_string($part->expr->name)) unset($arrays[$part->expr->name]);
                    return;
                }
                if ($part instanceof PhpParser\Node\Stmt\TryCatch) {
                    // Catch may execute before any assignment inside try.
                    // Re-analyze every arm from the pre-try facts, and discard
                    // facts touched anywhere before continuing after try.
                    $beforeTaint=$referenceTainted;
                    $tryTypes=$types; $tryArrays=$arrays;
                    foreach ($part->stmts as $stmt) {
                        $walk($stmt,$tryTypes,$tryArrays);
                        // An unconditional throw makes later try statements
                        // unreachable, including reference aliases.
                        if ($stmt instanceof PhpParser\Node\Stmt\Expression
                            && $stmt->expr instanceof PhpParser\Node\Expr\Throw_) break;
                    }
                    $taintArms=[$referenceTainted];
                    foreach ($part->catches as $catch) {
                        $catchTypes=$types; $catchArrays=$arrays;
                        $referenceTainted=$taintArms[0];
                        $walk($catch,$catchTypes,$catchArrays);
                        $taintArms[]=$referenceTainted;
                    }
                    if ($part->finally !== null) {
                        $finallyTypes=$types; $finallyArrays=$arrays;
                        $referenceTainted=$beforeTaint;
                        foreach ($taintArms as $taint) $referenceTainted += $taint;
                        $walk($part->finally,$finallyTypes,$finallyArrays);
                        $taintArms[]=$referenceTainted;
                    }
                    $referenceTainted=$beforeTaint;
                    foreach ($taintArms as $taint) $referenceTainted += $taint;
                    $changed=[]; $modified($part,$changed,$types);
                    foreach ($changed as $name=>$_) unset($types[$name],$arrays[$name]);
                    foreach ($referenceTainted as $name=>$_) unset($types[$name],$arrays[$name]);
                    return;
                }
                if ($part instanceof PhpParser\Node\Stmt\Switch_) {
                    $walk($part->cond,$types,$arrays);
                    $beforeTypes=$types; $beforeArrays=$arrays;
                    $beforeTaint=$referenceTainted;
                    $fallthrough=false;
                    $fallthroughTypes=[]; $fallthroughArrays=[]; $fallthroughTaint=$beforeTaint;
                    $taintArms=[$beforeTaint];
                    foreach ($part->cases as $case) {
                        $caseTypes=$beforeTypes; $caseArrays=$beforeArrays;
                        if ($fallthrough) {
                            // Each case is directly enterable, or reachable
                            // from the previous case without a break.
                            foreach ($caseTypes as $name=>$type) {
                                if (!isset($fallthroughTypes[$name])
                                    || strcasecmp($type['className'],$fallthroughTypes[$name]['className'])!==0)
                                    unset($caseTypes[$name]);
                            }
                            foreach ($caseArrays as $name=>$element) {
                                if (!isset($fallthroughArrays[$name])
                                    || strcasecmp($element,$fallthroughArrays[$name])!==0)
                                    unset($caseArrays[$name]);
                            }
                        }
                        $referenceTainted=$fallthrough ? ($beforeTaint + $fallthroughTaint) : $beforeTaint;
                        if ($case->cond !== null) $walk($case->cond,$caseTypes,$caseArrays);
                        $walk($case->stmts,$caseTypes,$caseArrays);
                        $taintArms[]=$referenceTainted;
                        $last=$case->stmts ? $case->stmts[count($case->stmts)-1] : null;
                        $fallthrough=!($last instanceof PhpParser\Node\Stmt\Break_
                            || $last instanceof PhpParser\Node\Stmt\Return_
                            || ($last instanceof PhpParser\Node\Stmt\Expression
                                && $last->expr instanceof PhpParser\Node\Expr\Throw_));
                        $fallthroughTypes=$caseTypes;
                        $fallthroughArrays=$caseArrays;
                        $fallthroughTaint=$referenceTainted;
                    }
                    $referenceTainted=$beforeTaint;
                    $changed=[]; $modified($part,$changed,$types);
                    foreach ($changed as $name=>$_) unset($types[$name],$arrays[$name]);
                    foreach ($taintArms as $taint) $referenceTainted += $taint;
                    foreach ($referenceTainted as $name=>$_) unset($types[$name],$arrays[$name]);
                    return;
                }
                if ($part instanceof PhpParser\Node\Stmt\For_ || $part instanceof PhpParser\Node\Stmt\While_
                    || $part instanceof PhpParser\Node\Stmt\Do_
                ) {
                    $tmp=$types; $tmpArrays=$arrays;
                    foreach ($part->getSubNodeNames() as $field) $walk($part->$field,$tmp,$tmpArrays);
                    $changed=[]; $modified($part,$changed,$types);
                    $loop = $part instanceof PhpParser\Node\Stmt\For_
                        || $part instanceof PhpParser\Node\Stmt\While_
                        || $part instanceof PhpParser\Node\Stmt\Do_;
                    foreach ($changed as $name=>$_) {
                        if (!$loop || !isset($types[$name],$tmp[$name])
                            || strcasecmp($types[$name]['className'],$tmp[$name]['className']) !== 0) {
                            unset($types[$name]);
                        }
                        if (!$loop || !isset($arrays[$name],$tmpArrays[$name])
                            || strcasecmp($arrays[$name],$tmpArrays[$name]) !== 0) unset($arrays[$name]);
                    }
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
                if ($part instanceof PhpParser\Node\Expr\AssignOp
                    && $part->var instanceof PhpParser\Node\Expr\ArrayDimFetch) {
                    $base=$part->var;
                    while ($base instanceof PhpParser\Node\Expr\ArrayDimFetch) $base=$base->var;
                    if ($base instanceof PhpParser\Node\Expr\Variable && is_string($base->name))
                        unset($arrays[$base->name]);
                }
                if ($part instanceof PhpParser\Node\Expr\StaticCall
                    && !$part->isFirstClassCallable()
                    && $part->name instanceof PhpParser\Node\Identifier
                    && ($range = $this->range($part->name)) !== null) {
                    $special = $part->class instanceof PhpParser\Node\Name
                        ? strtolower($part->class->toString()) : null;
                    // Late static binding and dynamic class names do not have
                    // one proved receiver. Parent/self are statically bound.
                    $class = $special === 'static' ? null
                        : ($special === 'parent'
                            ? ($this->classStack
                                ? (array_values(array_filter(
                                    $this->classStack[count($this->classStack)-1]['ancestors'] ?? [],
                                    static fn($entry) => $entry['relation'] === 'extends'))[0]['className'] ?? null)
                                : null)
                            : qbPhpName($part->class, $currentClass));
                    if ($class !== null) $calls[] = ['className'=>$class,
                        'name'=>$part->name->toString(),'nameRange'=>$range,'evidenceSource'=>'native','callStyle'=>'static'];
                    else $unresolved[] = ['name'=>$part->name->toString(),'nameRange'=>$range];
                }
                if (($part instanceof PhpParser\Node\Expr\MethodCall || $part instanceof PhpParser\Node\Expr\NullsafeMethodCall)
                    && !$part->isFirstClassCallable()
                    && $part->name instanceof PhpParser\Node\Identifier) {
                    $type=$arrayElementReceiver($part->var,$types,$arrays) ?? $infer($part->var,$types);
                    $range=$this->range($part->name);
                    if ($range!==null) {
                        if ($type!==null) $calls[]=['className'=>$type['className'],'name'=>$part->name->toString(),
                            'nameRange'=>$range,'evidenceSource'=>$type['source'],'callStyle'=>'object'];
                        else $unresolved[]=['name'=>$part->name->toString(),'nameRange'=>$range];
                    }
                }
                $mutations = $arrayMutationTargets($part,$types);
                foreach ($part->getSubNodeNames() as $field) $walk($part->$field,$types,$arrays);
                foreach ($mutations as $name) unset($arrays[$name]);
            };
            // Arrow functions expose their body as expr, not getStmts().
            $walk($function instanceof PhpParser\Node\Expr\ArrowFunction
                ? [$function->expr] : ($function->getStmts() ?? []),$known,$arrayTypes);
            $this->callCount+=count($calls);
            $this->unresolvedCount+=count($unresolved);
            return ['calls'=>$calls,'unresolvedCalls'=>$unresolved,'propertyAccesses'=>$propertyAccesses];
        }

        public function fileCallSites(array $statements): array {
            $calls = []; $unresolved = []; $instantiations = []; $constantReads = [];
            $receiverClass = function($expr, array $known): ?string {
                if ($expr instanceof PhpParser\Node\Expr\Variable && is_string($expr->name))
                    return $known[$expr->name] ?? null;
                if ($expr instanceof PhpParser\Node\Expr\New_)
                    return qbPhpName($expr->class);
                if ($expr instanceof PhpParser\Node\Expr\StaticCall
                    && $expr->name instanceof PhpParser\Node\Identifier) {
                    $class = qbPhpName($expr->class);
                    return $class === null ? null
                        : ($this->fileStaticReturns[strtolower($class . '::' . $expr->name->toString())] ?? null);
                }
                return null;
            };
            $walk = function($part, array &$known) use (&$walk, $receiverClass, &$calls, &$unresolved, &$instantiations, &$constantReads): void {
                if (is_array($part)) { foreach ($part as $entry) $walk($entry, $known); return; }
                if (!$part instanceof PhpParser\Node) return;
                if ($part instanceof PhpParser\Node\Stmt\ClassLike
                    || $part instanceof PhpParser\Node\FunctionLike) return;
                if ($part instanceof PhpParser\Node\Stmt\Use_ || $part instanceof PhpParser\Node\Stmt\GroupUse
                    || $part instanceof PhpParser\Node\Stmt\Const_) return;
                if ($part instanceof PhpParser\Node\Expr\ClassConstFetch
                    && $part->class instanceof PhpParser\Node\Name
                    && $part->name instanceof PhpParser\Node\Identifier
                    && strtolower($part->name->toString()) !== 'class'
                    && ($range = $this->range($part->name)) !== null) $constantReads[] = $range;
                if ($part instanceof PhpParser\Node\Stmt\Namespace_) {
                    $namespaceKnown = [];
                    $walk($part->stmts, $namespaceKnown);
                    return;
                }
                if ($part instanceof PhpParser\Node\Stmt\TryCatch) {
                    // A catch starts from the state before entering try.
                    // Assignments later in try may never execute if it throws.
                    $tryKnown = $known;
                    $walk($part->stmts, $tryKnown);
                    foreach ($part->catches as $catch) {
                        $catchKnown = $known;
                        $walk($catch, $catchKnown);
                    }
                    if ($part->finally !== null) {
                        $finallyKnown = $known;
                        $walk($part->finally, $finallyKnown);
                    }
                    $known = [];
                    return;
                }
                // Values assigned in conditional or loop branches cannot escape
                // as a single proven type. Invalidate known top-level variables.
                if ($part instanceof PhpParser\Node\Stmt\If_
                    || $part instanceof PhpParser\Node\Stmt\Foreach_
                    || $part instanceof PhpParser\Node\Stmt\For_
                    || $part instanceof PhpParser\Node\Stmt\While_
                    || $part instanceof PhpParser\Node\Stmt\Do_
                    || $part instanceof PhpParser\Node\Stmt\Switch_) {
                    $branchKnown = $known;
                    foreach ($part->getSubNodeNames() as $field) $walk($part->$field, $branchKnown);
                    $known = [];
                    return;
                }
                if ($part instanceof PhpParser\Node\Expr\Assign
                    && $part->var instanceof PhpParser\Node\Expr\Variable
                    && is_string($part->var->name)) {
                    $walk($part->expr, $known);
                    $class = $part->expr instanceof PhpParser\Node\Expr\New_
                        ? qbPhpName($part->expr->class) : null;
                    if ($class === null) unset($known[$part->var->name]);
                    else $known[$part->var->name] = $class;
                    return;
                }
                if ($part instanceof PhpParser\Node\Expr\AssignOp
                    && $part->var instanceof PhpParser\Node\Expr\Variable
                    && is_string($part->var->name)) {
                    unset($known[$part->var->name]);
                }
                if ($part instanceof PhpParser\Node\Expr\New_
                    && $part->class instanceof PhpParser\Node\Name) {
                    $class = qbPhpName($part->class);
                    $range = $this->range($part->class);
                    if ($class !== null && $range !== null)
                        $instantiations[] = ['className'=>$class,'nameRange'=>$range];
                }
                if ($part instanceof PhpParser\Node\Expr\StaticCall
                    && !$part->isFirstClassCallable()
                    && $part->name instanceof PhpParser\Node\Identifier) {
                    $range = $this->range($part->name);
                    $class = qbPhpName($part->class);
                    if ($range !== null) {
                        if ($class !== null) $calls[] = ['className'=>$class,
                            'name'=>$part->name->toString(),'nameRange'=>$range,'evidenceSource'=>'native','callStyle'=>'static'];
                        else $unresolved[]=['name'=>$part->name->toString(),'nameRange'=>$range];
                    }
                } elseif (($part instanceof PhpParser\Node\Expr\MethodCall
                    || $part instanceof PhpParser\Node\Expr\NullsafeMethodCall)
                    && !$part->isFirstClassCallable()
                    && $part->name instanceof PhpParser\Node\Identifier
                    && ($range = $this->range($part->name)) !== null) {
                    $class = $receiverClass($part->var, $known);
                    if ($class !== null) $calls[] = ['className'=>$class,
                        'name'=>$part->name->toString(),'nameRange'=>$range,
                        'evidenceSource'=>'native','callStyle'=>'object'];
                    else $unresolved[] = ['name'=>$part->name->toString(),'nameRange'=>$range];
                }
                foreach ($part->getSubNodeNames() as $field) $walk($part->$field, $known);
            };
            $known = [];
            $walk($statements, $known);
            return ['calls'=>$calls,'unresolvedCalls'=>$unresolved,'instantiations'=>$instantiations,'constantReads'=>$constantReads];
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
                        'constantDefinitions'=>$context['constantDefinitions'],
                        'docMethods'=>$context['docMethods']];
                } elseif ($node instanceof PhpParser\Node\Stmt\Class_
                    && $node->name === null && ($range = $this->range($node)) !== null) {
                    // Anonymous migration classes are syntax-only structural scopes,
                    // never fabricated native SCIP declarations.
                    $this->scopes[] = ['type'=>'anonymous_class','range'=>$range];
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
            // Anonymous functions have their own verified lexical owner. Never
            // attribute their calls to the enclosing named method.
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
    if ($globalSites['calls'] || $globalSites['unresolvedCalls'] || $globalSites['instantiations'] || $globalSites['constantReads']) {
        $visitor->scopes[] = [
            'type'=>'file',
            'range'=>[0,0,count($lineStarts)-1,strlen($source) - $lineStarts[count($lineStarts)-1]],
            ...($globalSites['calls'] ? ['calls'=>$globalSites['calls']] : []),
            ...($globalSites['unresolvedCalls'] ? ['unresolvedCalls'=>$globalSites['unresolvedCalls']] : []),
            ...($globalSites['instantiations'] ? ['instantiations'=>$globalSites['instantiations']] : []),
            ...($globalSites['constantReads'] ? ['fileConstantReads'=>$globalSites['constantReads']] : []),
        ];
    }
    $globalScopes += count($visitor->scopes);
    foreach ($visitor->scopes as $scope) {
        $globalCallReferenceSites += count($scope['calls'] ?? [])
            + count($scope['unresolvedCalls'] ?? [])
            + count($scope['propertyAccesses'] ?? []) + count($scope['instantiations'] ?? []) + count($scope['fileConstantReads'] ?? []);
    }
    if ($globalScopes > 150000 || $globalCallReferenceSites > $maxCallReferenceSites) {
        fwrite(STDERR, "PHP scope or call/reference site count exceeds bounded contract\n");
        exit(3);
    }
    $result[$relative] = $visitor->scopes;
}
echo json_encode(['documents' => $result, 'parsed' => $parsed, 'errors' => $errors],
    JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
