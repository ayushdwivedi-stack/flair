- **Harper moves from 5.3.1 to 5.3.3.** The pinned dependency ships its
  production dependencies as a bundle instead of an `npm-shrinkwrap.json`. Those
  copies sit under `node_modules/harper/node_modules` in a bun install too, where
  root overrides do not replace them and `bun audit` does not report them;
  `node scripts/ci/list-harper-bundled.mjs` prints each copy and its version.
