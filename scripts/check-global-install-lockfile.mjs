#!/usr/bin/env node
/**
 * check-global-install-lockfile.mjs — flair#1683 regression lane.
 *
 * WHAT BROKE (0.54.1). `npm install -g --prefix <tmp> @tpsdev-ai/flair@0.54.1`
 * is a broken install, and nothing in CI noticed:
 *
 *   npm warn reify invalid or damaged lockfile detected        (×8)
 *   added 50 packages                                          (0.53.0 added 543)
 *   require.resolve('fs-extra', { paths: [<tree>/…/harper/dist/utility/logging] })
 *     → MODULE_NOT_FOUND (or, worse, a hit OUTSIDE the tree — see resolveFromLoggingDir)
 *   node <tree>/node_modules/harper/dist/bin/harper.js version
 *     → throws; the engine cannot start
 *
 * The package-count floor it enforces lives in the reviewed budget file
 * (.github/install-weight-budget.json → minPackages), not in this script.
 * The count it compares is the installed tree itself (countInstalledPackages:
 * package directories under the global lib/node_modules — one holding a
 * package.json with a name and version — nested and bundled copies included). npm's "added N
 * packages" summary is printed for information only: harper >5.3.1 ships its
 * dependencies as bundleDependencies, and npm's summary line does not count
 * bundled copies, so the summary understates a healthy tree.
 *
 * Cause: 0.54.1's `bundleDependencies: ["@tpsdev-ai/flair-tool-descriptors"]`
 * (#1681) interacted with harper's own npm-shrinkwrap.json. npm's reify then
 * gave up on harper's subtree, so a global install "succeeded" (exit 0) with an
 * empty harper dependency tree. That is the failure this script exists to make
 * loud — and it is why a bare `npm install` exit code is NOT the check.
 *
 * WHAT IT DOES. Packs nothing itself: it takes a tarball (or any npm spec) and
 * does a real `npm install -g --prefix <throwaway>` into it, then asserts the
 * four symptoms above are absent. The CI lane (test.yml → install-weight job)
 * passes the tarball it already built and packed for the weight budget, so this
 * costs one throwaway install (~10s), not another build.
 *
 * FAILS-FIRST, VERIFIED. Run against the published 0.54.1 tarball it fails on
 * all four checks; against a build with the descriptors vendored it passes.
 * Both transcripts are in the flair#1683 PR body.
 *
 * Usage:
 *   node scripts/check-global-install-lockfile.mjs --package <tarball|spec>
 *   node scripts/check-global-install-lockfile.mjs --package ./tpsdev-ai-flair-0.54.2.tgz --keep
 *   node scripts/check-global-install-lockfile.mjs --registry-version 0.54.2   # flair#1686 canary
 *
 * flair#1686: `--registry-version <ver>` installs the published
 * `@tpsdev-ai/flair@<ver>` from the public registry into a throwaway prefix and
 * runs the SAME four assertions. It is the canary half of this script family —
 * the PR lane installs the tarball packed at HEAD, the canary installs exactly
 * what the registry serves a user, and both go through `evaluateInstall` so the
 * contract cannot drift into two implementations.
 *
 * Exit codes:
 *   0 — every check passed
 *   1 — at least one check failed (the install is broken; details on stderr)
 *   2 — DID NOT RUN (no --package, npm could not install at all, no tree) —
 *       never silently green. Mirrors check-install-weight.mjs.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/** Repo-relative path of the reviewed weight/floor budget (see readMinPackages). */
export const BUDGET_REL = join(".github", "install-weight-budget.json");

/** The one package this regression lane knows how to install (flair#1683). */
export const FLAIR_PACKAGE = "@tpsdev-ai/flair";

/**
 * Exact-version registry spec for the canary (`--registry-version`). Never a
 * dist-tag: the canary must install the version it was dispatched for, not
 * whatever `latest`/`staged` happens to point at when the job runs (flair#1686).
 * Rejects anything that is not a plain semver so a malformed input fails closed
 * here rather than installing an unintended spec.
 */
export function registryInstallSpec(version) {
  const value = String(version ?? "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(value)) {
    throw new Error(`--registry-version must be a semver (e.g. 0.54.2), got '${version}'`);
  }
  return `${FLAIR_PACKAGE}@${value}`;
}

/** Repo root, resolved from this script's location (scripts/ → repo root). */
export function repoRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Floor for the measured installed-package count, read from the reviewed budget
 * file (`.github/install-weight-budget.json` → `minPackages`) rather than a
 * literal in this script, so the number is reviewed with the rest of the ratchet
 * instead of moving in a diff nobody reads.
 */
export function readMinPackages(root = repoRoot()) {
  const raw = JSON.parse(readFileSync(join(root, BUDGET_REL), "utf8"));
  const value = Number(raw.minPackages);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${BUDGET_REL} is missing a positive minPackages`);
  }
  return value;
}

/** Harness paths inside a `--prefix <p>` global install. */
export function treePaths(prefix) {
  const flair = join(prefix, "lib", "node_modules", "@tpsdev-ai", "flair");
  return {
    flair,
    globalNodeModules: join(prefix, "lib", "node_modules"),
    harperJs: join(flair, "node_modules", "harper", "dist", "bin", "harper.js"),
    harperLoggingDir: join(flair, "node_modules", "harper", "dist", "utility", "logging"),
  };
}

/**
 * Hard bounds for the tree walk. They do not depend on what is installed: a tree
 * that exceeds either is a corrupt install, and the walk throws rather than
 * reporting a lower count as a measurement.
 */
const MAX_TREE_DEPTH = 64;
const MAX_TREE_ENTRIES = 250_000;

/**
 * Read a directory's package identity: `{name, version}` when its package.json
 * parses and carries both, null otherwise. No existence check first — read and
 * classify the failure, so the result cannot race a concurrent writer.
 */
function readPackageIdentity(dir) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof raw?.name !== "string" || raw.name === "") return null;
  if (typeof raw?.version !== "string" || raw.version === "") return null;
  return { name: raw.name, version: raw.version };
}

function listDir(dir, required) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!required && err?.code === "ENOENT") return null;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read ${dir}: ${message}`);
  }
}

/**
 * Count the installed packages in a global `lib/node_modules` tree.
 *
 * A package is a directory holding a package.json with a non-empty name and
 * version; `@scope/pkg` counts once (the scope directory itself has no
 * package.json). Nested `node_modules` (regular hoisting) and a package's own
 * bundled `node_modules` (harper's bundleDependencies) are walked, so the count
 * reflects what is on disk rather than npm's "added N packages" summary, which
 * omits bundled copies. Symlinks are not followed, so a linked entry cannot be
 * counted twice.
 *
 * Throws on an unreadable directory or a tree past the bounds above. A failed
 * read is never reported as a smaller tree.
 */
export function countInstalledPackages(globalNodeModules) {
  let entries = 0;
  let packages = 0;

  const walk = (dir, depth, required) => {
    if (depth > MAX_TREE_DEPTH) {
      throw new Error(`package tree is deeper than ${MAX_TREE_DEPTH} node_modules levels at ${dir}`);
    }
    const children = listDir(dir, required);
    if (children === null) return;
    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (++entries > MAX_TREE_ENTRIES) {
        throw new Error(`package tree under ${globalNodeModules} has more than ${MAX_TREE_ENTRIES} directories`);
      }
      const path = join(dir, child.name);
      if (child.name === "node_modules") {
        walk(path, depth + 1, false);
        continue;
      }
      if (readPackageIdentity(path) !== null) {
        packages += 1;
        walk(join(path, "node_modules"), depth + 1, false);
      } else {
        // A scope directory (`@scope`) or a stray directory: its packages, if
        // any, are one level down.
        walk(path, depth + 1, false);
      }
    }
  };

  walk(globalNodeModules, 0, true);
  return packages;
}

/** "added 543 packages" → 543; null when npm printed no such line. */
export function parseAddedCount(log) {
  const m = /^added (\d+) packages?/m.exec(log);
  return m ? Number(m[1]) : null;
}

/** True when the install log carries npm's reify damage warning. */
export function hasDamagedLockfileWarning(log) {
  return /invalid or damaged lockfile/.test(log);
}

/**
 * Resolve `fs-extra` the way harper's logging dir would at runtime, and require
 * the hit to be INSIDE the installed tree.
 *
 * The in-tree assertion is the whole point: if harper's subtree was never built, a
 * developer box whose TMPDIR sits under a tree with a node_modules/fs-extra would
 * otherwise resolve the AMBIENT copy and report the broken install green (flaky-on-
 * developer, green-on-CI). A hoisted/ambient hit is a failure, not a pass.
 */
export function resolveFromLoggingDir(paths) {
  const require = createRequire(import.meta.url);
  let resolved;
  try {
    resolved = require.resolve("fs-extra", { paths: [paths.harperLoggingDir] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Drop node's "Require stack:" tail — it names this script, not the tree.
    return { ok: false, error: message.split("\n")[0].trim() };
  }
  if (!resolved.startsWith(paths.flair)) {
    return {
      ok: false,
      resolved,
      error:
        `resolved outside the installed tree (${resolved}) — an ambient/hoisted copy ` +
        "hides harper's missing dependency tree",
    };
  }
  return { ok: true, resolved };
}

/** Run the engine's own version probe. */
export function harperVersion(paths) {
  if (!existsSync(paths.harperJs)) {
    return { ok: false, error: `no harper entrypoint at ${paths.harperJs}` };
  }
  const run = spawnSync(process.execPath, [paths.harperJs, "version"], { encoding: "utf8" });
  if (run.status !== 0) {
    return {
      ok: false,
      error: `exit ${run.status}: ${(run.stderr || run.stdout || "").trim().split("\n").slice(-1)[0] ?? ""}`,
    };
  }
  return { ok: true, version: run.stdout.trim() };
}

/**
 * Apply the four checks to a finished install. Pure — takes the captured log
 * and the on-disk tree, returns findings. Unit-tested in
 * test/unit/global-install-lockfile.test.ts.
 *
 * `added` (npm's summary line) is returned for reporting only; the floor is
 * compared against `measured`, the count taken from the tree itself.
 */
export function evaluateInstall({ log, paths, minPackages }) {
  if (!Number.isFinite(minPackages) || minPackages <= 0) {
    throw new Error("evaluateInstall requires a positive minPackages (see readMinPackages)");
  }
  if (typeof paths.globalNodeModules !== "string" || paths.globalNodeModules === "") {
    throw new Error("evaluateInstall requires paths.globalNodeModules (see treePaths)");
  }
  const failures = [];

  if (hasDamagedLockfileWarning(log)) {
    failures.push(
      'install log contains "invalid or damaged lockfile" — npm reify could not resolve the tree ' +
        "(flair#1683: bundleDependencies vs. harper's npm-shrinkwrap.json)",
    );
  }

  const added = parseAddedCount(log);
  const measured = countInstalledPackages(paths.globalNodeModules);
  if (measured < minPackages) {
    const reported = added === null ? "" : ` (npm reported "added ${added}")`;
    failures.push(
      `installed tree has ${measured} packages (package.json with a name and version under lib/node_modules), ` +
        `below the ${minPackages} floor${reported} — dependency tree collapsed`,
    );
  }

  const fsExtra = resolveFromLoggingDir(paths);
  if (!fsExtra.ok) {
    failures.push(`require.resolve('fs-extra') from harper's logging dir failed: ${fsExtra.error}`);
  }

  const harper = harperVersion(paths);
  if (!harper.ok) {
    failures.push(`node harper.js version failed: ${harper.error}`);
  }

  return { added, measured, fsExtra, harper, failures, ok: failures.length === 0 };
}

function parseArgs(argv) {
  const opts = { pkg: null, registryVersion: null, keep: false, prefix: null, minPackages: null, countRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--package" || a === "--tarball") opts.pkg = argv[++i];
    else if (a === "--registry-version") opts.registryVersion = argv[++i];
    else if (a === "--prefix") opts.prefix = argv[++i];
    else if (a === "--min-packages") opts.minPackages = Number(argv[++i]);
    else if (a === "--count-root") opts.countRoot = argv[++i];
    else if (a === "--keep") opts.keep = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  if (opts.help) {
    console.error(
      "usage: node scripts/check-global-install-lockfile.mjs --package <tarball|spec> [--prefix <dir>] [--keep]\n" +
        "       node scripts/check-global-install-lockfile.mjs --registry-version <ver> [--prefix <dir>] [--keep]\n" +
        "       node scripts/check-global-install-lockfile.mjs --count-root <global lib/node_modules>",
    );
    process.exit(0);
  }
  if (opts.countRoot) {
    // Same measured count the floor compares, for callers that own an existing
    // global tree (scripts/ci/macos-launchd-upgrade-lane.sh).
    if (opts.pkg || opts.registryVersion) {
      console.error("DID NOT RUN: --count-root counts an existing tree; do not pass --package/--registry-version");
      process.exit(2);
    }
    try {
      console.log(countInstalledPackages(opts.countRoot));
    } catch (err) {
      console.error(`DID NOT RUN: ${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
    return;
  }
  if (opts.pkg && opts.registryVersion) {
    console.error("DID NOT RUN: pass exactly one of --package / --registry-version, not both");
    process.exit(2);
  }
  if (opts.registryVersion) {
    try {
      opts.pkg = registryInstallSpec(opts.registryVersion);
    } catch (err) {
      console.error(`DID NOT RUN: ${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  }
  if (!opts.pkg) {
    console.error("DID NOT RUN: --package <tarball|spec> or --registry-version <ver> is required (nothing to install)");
    process.exit(2);
  }
  if (opts.pkg.endsWith(".tgz") && !existsSync(opts.pkg)) {
    console.error(`DID NOT RUN: tarball not found: ${opts.pkg}`);
    process.exit(2);
  }

  const own = !opts.prefix;
  const prefix = opts.prefix ?? mkdtempSync(join(tmpdir(), "flair-global-install-"));
  const cleanup = () => {
    if (own && !opts.keep) rmSync(prefix, { recursive: true, force: true });
  };

  try {
    console.error(`[global-install] npm install -g --prefix ${prefix} ${opts.pkg}`);
    if (opts.registryVersion) console.error(`[global-install] source: public registry, exact version ${opts.registryVersion} (flair#1686 canary)`);
    const run = spawnSync("npm", ["install", "-g", "--prefix", prefix, opts.pkg], {
      encoding: "utf8",
      env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" },
    });
    const log = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;

    const paths = treePaths(prefix);
    if (!existsSync(paths.flair)) {
      console.error(`DID NOT RUN: no installed tree at ${paths.flair} (npm exit ${run.status})`);
      console.error(log.trim().split("\n").slice(-20).join("\n"));
      process.exit(2);
    }

    const result = evaluateInstall({
      log,
      paths,
      minPackages: opts.minPackages ?? readMinPackages(),
    });
    console.error(
      `[global-install] npm-added=${result.added ?? "(no summary line)"} measured=${result.measured} packages ` +
        `fs-extra=${result.fsExtra.ok ? "ok" : "FAIL"} harper version=${result.harper.ok ? result.harper.version : "FAIL"}`,
    );
    if (!result.ok) {
      console.error(`[global-install] FAILED ${result.failures.length} check(s):`);
      for (const f of result.failures) console.error(`  ✗ ${f}`);
      if (opts.keep) console.error(`[global-install] tree kept at ${prefix}`);
      process.exit(1);
    }
    console.error(`[global-install] OK — harper ${result.harper.version}, ${result.measured} measured packages`);
    if (opts.keep) console.error(`[global-install] tree kept at ${prefix}`);
  } finally {
    cleanup();
  }
}

const invoked = process.argv[1] ? process.argv[1] : "";
if (invoked.endsWith("check-global-install-lockfile.mjs")) {
  main();
}
