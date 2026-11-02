<?php
namespace Synthetic\SourceFlow\Application;
use Synthetic\SourceFlow\Service\InvoiceService;
final class BatchHandler {
    public function __construct(private InvoiceService $service) {}
    public function handle(string $id): string { return $this->service->load($id); }
}