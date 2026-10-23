- **Basement and restore of a non-skill memory write under the per-id Memory lock they hold.**

  For a non-skill row, `POST /MemoryArchive` takes the id's lock (and the lock
  of the `supersedes` target its write closes) after its first read. Holding
  it, the archive re-reads the row and writes it in one transaction, then
  confirms the stored row's identity and its archive fields (`archived`,
  `archivedAt`, `archivedBy`) before it answers. While the archive holds the
  id, an owner `PUT` or `PATCH` of it waits within its budget and, if the hold
  outlasts it, answers `503 memory_busy` (an id with an unresolved write
  outcome answers `503 write_outcome_unknown` first). When the lock stays held
  for that budget, the archive answers `503 memory_busy` and writes nothing.
  A stored row that does not hold the archive fields after the commit answers
  `409 stored_row_changed`. A skill row keeps the existing `Memory.put` path
  and its skill-state refusals (`skill_state_requires_delete` for
  `archived: true`).
