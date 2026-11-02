<?php
namespace Synthetic\SourceFlow\Service;
use Synthetic\SourceFlow\DAO\InvoiceDao;
final class InvoiceService {
    public function __construct(private InvoiceDao $dao) {}
    public function load(string $id): string { return $this->dao->find($id); }
}