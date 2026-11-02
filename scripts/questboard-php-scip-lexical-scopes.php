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
    $visitor = new class($source, $lineStarts) extends PhpParser\NodeVisitorAbstract {
        public array $scopes = [];
        public int $callCount = 0;
        private array $classStack = [];
        public function __construct(private readonly string $source, private readonly array $lineStarts) {}

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
            if (!$type instanceof PhpParser\Node\Name) return null;
            $name = ltrim($type->toString(), '\\');
            if (!$name || in_array(strtolower($name), ['self', 'static', 'parent'], true)) return null;
            return $name;
        }

        private function classContext(PhpParser\Node\Stmt\ClassLike $node): array {
            $qualified = $node->namespacedName ?? $node->getAttribute('namespacedName');
            $class = $qualified instanceof PhpParser\Node\Name ? $qualified->toString() : null;
            if ($class === null && $node->name !== null) $class = $node->name->toString();
            $properties = [];
            foreach ($node->stmts as $member) {
                if (!$member instanceof PhpParser\Node\Stmt\Property) continue;
                $type = $this->resolvedType($member->type);
                if ($type === null) continue;
                foreach ($member->props as $prop) $properties[$prop->name->toString()] = $type;
            }
            return ['class' => $class, 'properties' => $properties];
        }

        /** Only lexical, statically proved receiver types. No value-flow guesses across branches. */
        private function methodCalls(PhpParser\Node $function, array $properties): array {
            $types = [];
            foreach ($function->getParams() as $param) {
                $name = $param->var instanceof PhpParser\Node\Expr\Variable ? $param->var->name : null;
                $type = $this->resolvedType($param->type);
                if (is_string($name) && $type !== null) $types[$name] = $type;
            }
            $calls = [];
            $modified = function ($part, array &$names) use (&$modified): void {
                if (is_array($part)) {
                    foreach ($part as $item) $modified($item, $names);
                    return;
                }
                if (!$part instanceof PhpParser\Node) return;
                if ($part instanceof PhpParser\Node\FunctionLike
                    || $part instanceof PhpParser\Node\Stmt\ClassLike) return;
                if ($part instanceof PhpParser\Node\Expr\Assign
                    && $part->var instanceof PhpParser\Node\Expr\Variable
                    && is_string($part->var->name)) $names[$part->var->name] = true;
                if ($part instanceof PhpParser\Node\Expr\AssignOp
                    && $part->var instanceof PhpParser\Node\Expr\Variable
                    && is_string($part->var->name)) $names[$part->var->name] = true;
                foreach ($part->getSubNodeNames() as $field) $modified($part->$field, $names);
            };
            $walk = function ($part, array &$known) use (&$walk, $modified, $properties, &$calls): void {
                if (is_array($part)) {
                    foreach ($part as $item) $walk($item, $known);
                    return;
                }
                if (!$part instanceof PhpParser\Node) return;
                if ($part instanceof PhpParser\Node\FunctionLike
                    || $part instanceof PhpParser\Node\Stmt\ClassLike) return;
                // Branches and loops may execute zero or multiple times. Never propagate
                // inferred assignments out; invalidate variables assigned on any branch.
                if ($part instanceof PhpParser\Node\Stmt\If_
                    || $part instanceof PhpParser\Node\Stmt\For_
                    || $part instanceof PhpParser\Node\Stmt\Foreach_
                    || $part instanceof PhpParser\Node\Stmt\While_
                    || $part instanceof PhpParser\Node\Stmt\Do_
                    || $part instanceof PhpParser\Node\Stmt\Switch_
                    || $part instanceof PhpParser\Node\Stmt\TryCatch) {
                    $before = $known;
                    $invalidated = [];
                    // A foreach variable shadows any similarly named parameter.
                    if ($part instanceof PhpParser\Node\Stmt\Foreach_) {
                        foreach ([$part->valueVar, $part->keyVar] as $bound) {
                            if ($bound instanceof PhpParser\Node\Expr\Variable && is_string($bound->name)) {
                                $invalidated[$bound->name] = true;
                                unset($before[$bound->name]);
                            }
                        }
                    }
                    // Never carry types from an if arm into an else arm.
                    foreach ($part->getSubNodeNames() as $field) {
                        $branch = $part->$field;
                        if ($field === 'elseifs' && is_array($branch)) {
                            foreach ($branch as $arm) {
                                $local = $before;
                                $walk($arm, $local);
                            }
                        } else {
                            $local = $before;
                            $walk($branch, $local);
                        }
                    }
                    $modified($part, $invalidated);
                    foreach ($invalidated as $name => $_) unset($known[$name]);
                    return;
                }
                if ($part instanceof PhpParser\Node\Expr\Assign) {
                    $walk($part->expr, $known);
                    if ($part->var instanceof PhpParser\Node\Expr\Variable
                        && is_string($part->var->name)) {
                        $name = $part->var->name;
                        $type = $part->expr instanceof PhpParser\Node\Expr\New_
                            ? $this->resolvedType($part->expr->class) : null;
                        if ($type !== null) $known[$name] = $type;
                        else unset($known[$name]);
                    }
                    return;
                }
                if ($part instanceof PhpParser\Node\Expr\AssignOp
                    && $part->var instanceof PhpParser\Node\Expr\Variable
                    && is_string($part->var->name)) unset($known[$part->var->name]);
                if (($part instanceof PhpParser\Node\Expr\MethodCall
                        || $part instanceof PhpParser\Node\Expr\NullsafeMethodCall)
                    && $part->name instanceof PhpParser\Node\Identifier) {
                    $receiver = $part->var;
                    $type = null;
                    if ($receiver instanceof PhpParser\Node\Expr\Variable && is_string($receiver->name)) {
                        $type = $known[$receiver->name] ?? null;
                    } elseif ($receiver instanceof PhpParser\Node\Expr\PropertyFetch
                        && $receiver->var instanceof PhpParser\Node\Expr\Variable
                        && $receiver->var->name === 'this'
                        && $receiver->name instanceof PhpParser\Node\Identifier) {
                        $type = $properties[$receiver->name->toString()] ?? null;
                    }
                    $range = $this->range($part->name);
                    if ($type !== null && $range !== null) {
                        $calls[] = ['className' => $type, 'name' => $part->name->toString(), 'nameRange' => $range];
                    }
                }
                foreach ($part->getSubNodeNames() as $field) $walk($part->$field, $known);
            };
            $walk($function->getStmts() ?? [], $types);
            $this->callCount += count($calls);
            return $calls;
        }

        public function enterNode(PhpParser\Node $node): ?int {
            if ($node instanceof PhpParser\Node\Stmt\ClassLike) {
                $this->classStack[] = $this->classContext($node);
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
            $calls = $type === 'anonymous' ? [] : $this->methodCalls($node, $context['properties'] ?? []);
            $this->scopes[] = [
                'type' => $type,
                'range' => $range,
                ...($name === null ? [] : ['name' => $name, 'nameRange' => $nameRange]),
                ...($type === 'method' && $context !== null && $context['class'] !== null
                    ? ['className' => $context['class']] : []),
                ...($calls ? ['calls' => $calls] : []),
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
    $globalScopes += count($visitor->scopes);
    if ($globalScopes > 150000 || $visitor->callCount > 100000) {
        fwrite(STDERR, "PHP scope count exceeds bounded contract\n");
        exit(3);
    }
    $result[$relative] = $visitor->scopes;
}
echo json_encode(['documents' => $result, 'parsed' => $parsed, 'errors' => $errors],
    JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
