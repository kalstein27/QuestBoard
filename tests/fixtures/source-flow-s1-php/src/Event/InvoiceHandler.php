<?php
namespace Synthetic\SourceFlow\Event;
use Synthetic\SourceFlow\Application\BatchHandler;
final class InvoiceHandler {
    public function __construct(private BatchHandler $handler) {}
    public function __invoke(string $id): string { return $this->handler->handle($id); }
}