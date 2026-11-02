<?php
namespace Synthetic\SourceFlow\Contract;
interface LedgerPort { public function find(string $id): string; }