- **Owner DELETE takes the per-id Memory write lock.**

  A `DELETE /Memory/<id>` now takes the id's lock before its first read (and,
  for a skill row, the live head's), reads and deletes the addressed row
  inside one owned transaction, and holds the lock across that transaction's
  commit. While another writer holds the id through the owner wait budget the
  delete answers `503 memory_busy`; nothing is written. The skill delete path
  runs inside the same lock.
