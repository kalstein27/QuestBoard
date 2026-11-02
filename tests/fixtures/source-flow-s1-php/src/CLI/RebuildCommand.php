<?php
namespace Synthetic\SourceFlow\CLI;
use Synthetic\SourceFlow\Application\BatchHandler;
final class RebuildCommand {
    public function __construct(private BatchHandler $handler) {}
    public function run(string $id): string { return $this->handler->handle($id); }
}