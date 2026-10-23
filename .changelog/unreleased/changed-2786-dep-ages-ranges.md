- **The bake-time dependency gate checks a range at the version bun.lock
  resolves it to.** `node scripts/check-dep-ages.mjs` age-checks ranged entries
  in `dependencies`, `devDependencies`, `optionalDependencies` and `overrides`
  — root and every workspace package.json — against the same minimum release
  age and keep-current list as exact pins. An `npm:` alias range is checked at
  the version installed under the alias. A top-level override range is checked
  at every installed copy of its package, a nested one at the copies installed
  below its enclosing packages; an override range with no installed copy in
  that scope is listed, with nothing to check. A range the gate cannot resolve
  fails the gate; a fresh resolved version is reported with its publish date.
  Exact pins are checked as before; exact `devDependencies` pins are still not
  checked.
