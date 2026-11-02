<?php
declare(strict_types=1);

// Trusted, read-only PHP Parser 5 bridge for the QuestBoard SCIP PHP adapter.
// Input (stdin): JSON array of native SCIP document-relative PHP paths.
// Output (stdout): JSON object with lexical owner scopes only, never code text.
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

        public function enterNode(PhpParser\Node $node): ?int {
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
            $this->scopes[] = [
                'type' => $type,
                'range' => $range,
                ...($name === null ? [] : ['name' => $name, 'nameRange' => $nameRange]),
            ];
            return null;
        }
    };
    $traverser = new PhpParser\NodeTraverser();
    $traverser->addVisitor($visitor);
    $traverser->traverse($ast);
    $globalScopes += count($visitor->scopes);
    if ($globalScopes > 150000) {
        fwrite(STDERR, "PHP scope count exceeds bounded contract\n");
        exit(3);
    }
    $result[$relative] = $visitor->scopes;
}
echo json_encode(['documents' => $result, 'parsed' => $parsed, 'errors' => $errors],
    JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
