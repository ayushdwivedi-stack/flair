- **Owner DELETE and owner POST take the per-id Memory write lock.**

  A `DELETE /Memory/<id>` takes the id's lock before its first read, reads and
  deletes the addressed row inside one owned transaction, and holds the lock
  across that transaction's commit.
  A `POST /Memory` that names an id or a `supersedes` target takes the same
  locks, so its read, decision and write (and the superseded row's close) run
  on one basis. A POST joins the request's open transaction, which commits
  after the lock is released. While another writer holds the id through the owner wait budget
  either answers `503 memory_busy` and writes nothing.
