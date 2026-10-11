#!/usr/bin/env node
/**
 * check-renovate-preset-rules.mjs — exercise the shared Renovate preset
 * (.github/renovate-preset.json) with Renovate's own code (flair#1937).
 *
 * WHY THIS EXISTS
 * ---------------
 * The preset's `packageRules` decide how Renovate groups updates, and every
 * repo that extends the preset inherits them. A rule that is too broad, too
 * narrow, or in the wrong order silently changes the pull requests Renovate
 * opens — for instance, a github/codeql-action major left ungrouped opens one
 * pull request per sub-action, and each of those fails CodeQL's mixed-version
 * check (flair#1937). Reviewing the JSON by eye does not catch an ordering
 * bug, because packageRules are order-sensitive: a later rule overrides an
 * earlier one for the same option. So this script runs the real preset through
 * Renovate's own validator and rule evaluator and asserts the grouping it
 * actually produces.
 *
 * HOW TO RUN
 * ----------
 *   npx --yes --package=renovate@<version> -- node scripts/check-renovate-preset-rules.mjs
 *
 * The CI job "Renovate preset rules" (.github/workflows/test.yml) runs exactly
 * that. Renovate is deliberately NOT a devDependency: it drags hundreds of
 * packages into bun.lock, which the blocking audit gate
 * (docs/supply-chain-policy.md §7) and the Socket scan would then have to
 * cover, and its near-daily releases would put it on the update treadmill this
 * preset exists to schedule. Installing it at CI time from an exact,
 * bake-time-cleared version (RENOVATE_VERSION) exercises the same code without
 * putting it in the repo's dependency graph.
 *
 * The script resolves an already-installed Renovate: `--renovate-dir <dir>` if
 * given, else the first `renovate-config-validator` (or `renovate`) on PATH —
 * which is what `npx --package=renovate` sets up. It runs the validator with
 * `--strict`, then imports `applyPackageRules` from the same install and drives
 * the preset's packageRules over synthetic updates. Finally it re-runs the key
 * assertion against two in-memory mutations of the preset (remove the
 * codeql-action rule; move it before the majors rule) and requires each
 * mutation to make the assertion fail — so the test proves it would catch the
 * bug, not just that the current file happens to pass.
 *
 * Exit codes:
 *   0 — validator passed and every assertion held
 *   1 — a check failed (the message names the case and what it saw)
 *   2 — DID NOT RUN (no Renovate found, wrong Renovate version, preset
 *       unreadable) — not 0
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Pinned Renovate version. 44.132.5 was published 2026-10-03T20:09:47Z and so
// clears the repo's 7-day bake-time policy (docs/supply-chain-policy.md §1)
// from 2026-10-10 onward; it only grows older, so it stays compliant. Keep in
// one place: the CI job installs exactly this via `--print-renovate-version`.
export const RENOVATE_VERSION = "44.132.5";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRESET_PATH = join(REPO_ROOT, ".github", "renovate-preset.json");

// The group a github/codeql-action major must land in, and the general group
// non-major GitHub Actions updates land in. Named here so a rename in the
// preset is caught rather than silently followed.
const CODEQL_GROUP = "github/codeql-action";
const ACTIONS_NONMAJOR_GROUP = "github-actions";

const ARGS = process.argv.slice(2);
const argValue = (name) => {
  const i = ARGS.indexOf(name);
  return i >= 0 ? ARGS[i + 1] : undefined;
};

let checks = 0;
let failures = 0;
function check(ok, message) {
  checks += 1;
  if (ok) {
    console.log(`ok   ${message}`);
  } else {
    failures += 1;
    console.error(`FAIL ${message}`);
  }
}
function eq(actual, expected, message) {
  check(
    actual === expected,
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

function findOnPath(name) {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Walk up from a resolved binary to the directory holding the `renovate` package. */
function renovatePackageFromBin(bin) {
  let real;
  try {
    real = realpathSync(bin);
  } catch {
    real = bin;
  }
  let cur = dirname(real);
  while (cur !== dirname(cur)) {
    const pkgPath = join(cur, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === "renovate") return { dir: cur, pkg };
      } catch {
        /* keep walking */
      }
    }
    cur = dirname(cur);
  }
  return null;
}

function resolveRenovate() {
  const explicitDir = argValue("--renovate-dir");
  const explicitBin = argValue("--renovate-bin");
  let bin = explicitBin ?? null;
  if (!bin && explicitDir) {
    const candidate = join(
      explicitDir,
      "node_modules",
      ".bin",
      "renovate-config-validator",
    );
    if (existsSync(candidate)) bin = candidate;
  }
  if (!bin) {
    bin = findOnPath("renovate-config-validator") ?? findOnPath("renovate");
  }
  if (!bin) return null;
  return renovatePackageFromBin(bin);
}

// ── The preset's rules, and the predicate the rules must satisfy ────────────

const isCodeqlRule = (rule) =>
  (rule.matchPackageNames || []).includes("github/codeql-action");
const isUngroupingMajorRule = (rule) =>
  Array.isArray(rule.matchUpdateTypes) &&
  rule.matchUpdateTypes.length === 1 &&
  rule.matchUpdateTypes[0] === "major" &&
  rule.groupName === null;

const CODEQL_MAJOR_DEPS = [
  "github/codeql-action", // the base action
  "github/codeql-action/init",
  "github/codeql-action/autobuild",
  "github/codeql-action/analyze",
];

const upd = (name, updateType, manager = "github-actions") => ({
  depName: name,
  packageName: name,
  manager,
  updateType,
  currentValue: "v1.0.0",
  newValue: "v2.0.0",
});

async function groupForRules(applyPackageRules, ruleset, dep) {
  const out = await applyPackageRules({ ...dep, packageRules: ruleset });
  return out.groupName ?? null;
}

/** The distinct groupNames the four codeql-action majors resolve to under `ruleset`. */
async function codeqlMajorGroups(applyPackageRules, ruleset) {
  const groups = new Set();
  for (const name of CODEQL_MAJOR_DEPS) {
    groups.add(await groupForRules(applyPackageRules, ruleset, upd(name, "major")));
  }
  return groups;
}

async function main() {
  const renovate = resolveRenovate();
  if (!renovate) {
    console.error(
      "exit 2: no installed Renovate found. Run with `npx --yes --package=renovate@" +
        RENOVATE_VERSION +
        " -- node scripts/check-renovate-preset-rules.mjs`, or pass --renovate-dir.",
    );
    process.exit(2);
  }
  const wantVersion = argValue("--renovate-version") ?? RENOVATE_VERSION;
  if (renovate.pkg.version !== wantVersion) {
    console.error(
      `exit 2: found Renovate ${renovate.pkg.version} at ${renovate.dir}, expected exactly ${wantVersion}.`,
    );
    process.exit(2);
  }
  console.log(`# Renovate ${renovate.pkg.version} at ${renovate.dir}`);

  const loggerEntry = join(renovate.dir, "dist", "logger", "index.js");
  const rulesEntry = join(
    renovate.dir,
    "dist",
    "util",
    "package-rules",
    "index.js",
  );
  const validatorEntry = join(renovate.dir, "dist", "config-validator.js");
  for (const [label, path] of [
    ["logger", loggerEntry],
    ["package-rules", rulesEntry],
    ["config-validator", validatorEntry],
  ]) {
    if (!existsSync(path)) {
      console.error(`exit 2: Renovate ${label} entry missing at ${path}`);
      process.exit(2);
    }
  }

  const { init } = await import(pathToFileURL(loggerEntry).href);
  await init(); // else applyPackageRules warns "logger has not yet been initialized"
  const { applyPackageRules } = await import(pathToFileURL(rulesEntry).href);

  let preset;
  try {
    preset = JSON.parse(readFileSync(PRESET_PATH, "utf8"));
  } catch (err) {
    console.error(`exit 2: cannot read/parse ${PRESET_PATH}: ${err.message}`);
    process.exit(2);
  }
  const rules = Array.isArray(preset.packageRules) ? preset.packageRules : null;
  if (!rules) {
    console.error("exit 2: preset has no packageRules array");
    process.exit(2);
  }

  // ── 1. Renovate's own validator, --strict ─────────────────────────────────
  console.log("# renovate-config-validator --strict .github/renovate-preset.json");
  const validated = spawnSync(
    process.execPath,
    [validatorEntry, "--strict", PRESET_PATH],
    { encoding: "utf8" },
  );
  if (validated.stdout) process.stdout.write(validated.stdout);
  if (validated.stderr) process.stderr.write(validated.stderr);
  check(
    validated.status === 0,
    `renovate-config-validator --strict exits 0 (got ${validated.status})`,
  );

  // ── 2. Structural checks on the codeql rule ───────────────────────────────
  const codeqlRuleIdx = rules.findIndex(isCodeqlRule);
  const majorRuleIdx = rules.findIndex(isUngroupingMajorRule);
  const codeqlRule = codeqlRuleIdx >= 0 ? rules[codeqlRuleIdx] : null;
  check(codeqlRule !== null, "preset has a github/codeql-action package rule");
  if (codeqlRule) {
    eq(
      (codeqlRule.matchUpdateTypes || []).join(","),
      "major",
      "the github/codeql-action rule is scoped to major updates (matchUpdateTypes)",
    );
    eq(
      codeqlRule.groupName,
      CODEQL_GROUP,
      "the github/codeql-action rule sets the dedicated groupName",
    );
    check(
      majorRuleIdx >= 0 && codeqlRuleIdx > majorRuleIdx,
      "the github/codeql-action rule is positioned after the ungrouping majors rule",
    );
  }

  // ── 3. Behaviour: what Renovate's rule evaluator produces ─────────────────
  const baseline = {};
  for (const name of CODEQL_MAJOR_DEPS) {
    baseline[name] = await groupForRules(applyPackageRules, rules, upd(name, "major"));
  }
  const codeqlMajors = new Set(Object.values(baseline));
  check(
    codeqlMajors.size === 1,
    `codeql-action base + sub-actions share ONE groupName on a major (saw ${JSON.stringify(baseline)})`,
  );
  eq(
    [...codeqlMajors][0],
    CODEQL_GROUP,
    "that shared codeql-action major group is the dedicated codeql group",
  );

  const checkoutMajor = await groupForRules(applyPackageRules, rules, upd("actions/checkout", "major"));
  check(
    checkoutMajor !== CODEQL_GROUP,
    `an unrelated Action major is NOT grouped with codeql-action (got ${JSON.stringify(checkoutMajor)})`,
  );
  eq(
    checkoutMajor,
    null,
    "an unrelated Action major stays ungrouped (the majors rule)",
  );

  const codeqlMinor = await groupForRules(applyPackageRules, rules, upd("github/codeql-action/init", "minor"));
  eq(
    codeqlMinor,
    ACTIONS_NONMAJOR_GROUP,
    "a codeql-action minor keeps the general github-actions group",
  );
  const codeqlPatch = await groupForRules(applyPackageRules, rules, upd("github/codeql-action", "patch"));
  eq(
    codeqlPatch,
    ACTIONS_NONMAJOR_GROUP,
    "a codeql-action patch keeps the general github-actions group",
  );

  const lodashMajor = await groupForRules(applyPackageRules, rules, upd("lodash", "major", "npm"));
  check(
    lodashMajor !== CODEQL_GROUP,
    `an npm major is NOT swept into the codeql group (got ${JSON.stringify(lodashMajor)})`,
  );
  eq(lodashMajor, null, "an npm major is unaffected (stays ungrouped)");

  // ── 4. Mutation self-check: the assertion must fail on the bug shapes ─────
  const withoutCodeqlRule = rules.filter((rule) => !isCodeqlRule(rule));
  const codeqlBeforeMajorRule = (() => {
    const out = rules.map((rule) => ({ ...rule }));
    const ci = out.findIndex(isCodeqlRule);
    if (ci < 0) return out;
    const [codeql] = out.splice(ci, 1);
    const mi = out.findIndex(isUngroupingMajorRule);
    out.splice(mi < 0 ? 0 : mi, 0, codeql);
    return out;
  })();

  const removedGroups = await codeqlMajorGroups(applyPackageRules, withoutCodeqlRule);
  check(
    !(removedGroups.size === 1 && removedGroups.has(CODEQL_GROUP)),
    `mutation "remove the codeql-action rule" FAILS the shared-group assertion (saw ${JSON.stringify([...removedGroups])})`,
  );
  const reorderedGroups = await codeqlMajorGroups(applyPackageRules, codeqlBeforeMajorRule);
  check(
    !(reorderedGroups.size === 1 && reorderedGroups.has(CODEQL_GROUP)),
    `mutation "move the codeql-action rule before the majors rule" FAILS the shared-group assertion (saw ${JSON.stringify([...reorderedGroups])})`,
  );

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("PASS");
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (invokedDirectly) {
  if (ARGS.includes("--print-renovate-version")) {
    console.log(RENOVATE_VERSION);
    process.exit(0);
  }
  await main();
}
