- **The bake-time dependency gate checks a range at the version bun.lock
  resolves it to.** `node scripts/check-dep-ages.mjs` age-checks ranged entries
  in `dependencies`, `devDependencies`, `optionalDependencies` and `overrides`
  — root and every workspace package.json — against the same minimum release
  age and keep-current list as exact pins. An override range is checked at
  every lockfile copy it covers. A dependency range bun.lock does not resolve
  fails the gate; a fresh resolved version is reported with its publish date.
  Exact pins are checked as before.
