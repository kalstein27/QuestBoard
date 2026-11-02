<?php
namespace Synthetic\SourceFlow\DAO;
use Synthetic\SourceFlow\Contract\LedgerPort;
final class InvoiceDao implements LedgerPort {
    public function find(string $id): string { return 'invoice-' . $id; }
}