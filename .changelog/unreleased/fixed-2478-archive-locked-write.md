- **Basement and restore write under the per-id Memory lock they hold.**

  `POST /MemoryArchive` takes the id's lock (and the lock of the `supersedes`
  target its write closes) after its first read. Holding it, the archive
  re-reads the row and writes it in one transaction, then confirms the stored
  row's identity and its archive fields (`archived`, `archivedAt`,
  `archivedBy`) before it answers. While the archive holds the id, an owner
  `PUT` or `PATCH` of it waits within its budget and otherwise answers
  `503 memory_busy`. When the archive cannot take the lock within that budget,
  it answers `503 memory_busy` and writes nothing. A stored row that does not
  hold the archive fields after the commit answers `409 stored_row_changed`.
  A skill row is archived and restored as before.
