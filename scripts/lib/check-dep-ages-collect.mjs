/**
 * check-dep-ages-collect.mjs — pure functions for the supply-chain bake-time gate.
 *
 * These functions are exported for import by:
 * - scripts/check-dep-ages.mjs (the CLI entry point)
 * - test/unit/check-dep-ages.test.ts (the unit test suite)
 *
 * Internal `@tpsdev-ai/*` deps are exempt — we publish ourselves and the
 * 0.8.0 / 0.8.1 patch sequence already shipped same-day.
 *
 * This gate checks external entries in `dependencies`, `devDependencies`,
 * `optionalDependencies` AND `overrides` (root and every workspace
 * package.json), for exact pins and for ranges.
 * - `dependencies` / `optionalDependencies`: npm and bun install
 *   optionalDependencies by default (a failed install is non-fatal, not
 *   skipped), so they install just like any other dep and represent the same
 *   supply-chain risk. An entry is classified by the same classifier the
 *   override grammar uses (classifyRegistrySpec): an exact version is
 *   age-checked, a range is age-checked at the version bun.lock resolves it
 *   to, a form the classifier refuses fails the gate (collectUnsupportedDeps),
 *   and an `npm:` alias is checked against its target.
 * - `devDependencies`: ranges are age-checked at their lock resolution, like
 *   dependencies; exact pins are not age-checked, as before.
 * - `overrides`: exact declarations are age-checked, including conditional
 *   rules; range declarations are age-checked at every lockfile copy they
 *   cover. An `npm:` alias is checked against its target. Nested override
 *   objects are read too.
 *
 * Exemptions, in all three fields: `@tpsdev-ai/*`, the keep-current list,
 * `workspace:`, `file:`/`link:`, `git+`/`github:`.
 *
 * `peerDependencies` are NOT checked: peers are resolved from a range by the
 * consumer's install, so an exact-pin check of our declaration does not
 * describe what actually gets installed.
 */

/** Specifiers that name no registry version, so there is no publish date to check. */
function isNonRegistrySpecifier(spec) {
  return (
    spec.startsWith("workspace:") ||
    spec.startsWith("file:") ||
    spec.startsWith("link:") ||
    spec.startsWith("git+") ||
    spec.startsWith("github:")
  );
}

// ── Override grammar ───────────────────────────────────────────────────────
//
// npm's `overrides` grammar (@npmcli/arborist OverrideSet, npm-package-arg):
// - a key names a package, optionally with a version selector ("name@^1");
// - a value is a specifier string, or an object whose "." key overrides the
//   package itself and whose other keys override its dependencies (nested);
// - an object without a "." key overrides the package with its key's selector
//   ("*" when there is none, which overrides nothing).
// A value is classified into a supported subset of npm registry specs: an exact
// version, a range, or something else. Some spellings npm accepts as versions
// ("v1.0.0", build metadata) are deliberately not treated as exact here, so the
// gate refuses them rather than guessing. classifyOverrides refuses, with a
// reason, every rule it cannot classify as exact, range, exempt or none.
// test/unit/check-dep-ages-npm-conformance.test.ts checks this against a
// recording of npm's own parser.

/** A canonical exact version: MAJOR.MINOR.PATCH with an optional prerelease. */
const EXACT_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
/** A conservative regex for common loose version spellings ("v1.0.0", "=1.0.0", "1.0.0+build"); not a full copy of semver's loose grammar. */
const LOOSE_VERSION_RE =
  /^[v=\s]*\d+\.\d+\.\d+(?:-?[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const XR = "(?:\\d+|[xX*])";
const PARTIAL = `[v=]*${XR}(?:\\.${XR}(?:\\.${XR}(?:-?[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?)?)?`;
const COMPARATOR_RE = new RegExp(`^(?:<=?|>=?|=|~>?|\\^)?${PARTIAL}$`);
const HYPHEN_RANGE_RE = new RegExp(`^${PARTIAL}\\s+-\\s+${PARTIAL}$`);
/** npm package names, scoped or not (old-package names may use capitals). */
const PACKAGE_NAME_RE = /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;

/** A semver range ("^1", "1.x", "1 - 2", ">= 1.0.0 <2", "1.0.0 || 2.0.0"). */
function isRange(spec) {
  return spec.split("||").every((set) => {
    const s = set.trim();
    if (s === "" || HYPHEN_RANGE_RE.test(s)) return true;
    // semver lets an operator be separated from its version by spaces.
    return s
      .replace(/(<=?|>=?|=|~>?|\^)\s+/g, "$1")
      .split(/\s+/)
      .every((c) => COMPARATOR_RE.test(c));
  });
}

const refused = (reason) => ({ kind: "refused", reason });

/** Classify a registry specifier: exact, range, or refused. */
function classifyRegistrySpec(name, spec) {
  if (EXACT_VERSION_RE.test(spec)) return { kind: "exact", name, version: spec };
  if (LOOSE_VERSION_RE.test(spec)) {
    return refused(`"${spec}" is a version in a non-canonical form; write it as MAJOR.MINOR.PATCH`);
  }
  if (isRange(spec)) return { kind: "range", name, spec };
  return refused(`"${spec}" is not an exact version, a semver range or an npm: alias of one`);
}

/** Parse an override key into its package name and version selector, or null. */
function parseOverrideKey(key) {
  // npm reads these shapes as a URL, a git remote or a file, which name no package.
  if (/^(?:git[+])?[a-z]+:/i.test(key) || /^[^@]+@[^:.]+\.[^:]+:.+$/i.test(key)) return null;
  const at = key.indexOf("@", 1);
  const name = at > 0 ? key.slice(0, at) : key;
  const selector = at > 0 ? key.slice(at + 1) || "*" : "*";
  if (!PACKAGE_NAME_RE.test(name) || /[.](?:tgz|tar)$/i.test(name)) return null;
  return { name, selector };
}

/** Classify one override value (a string) for the package `name`. */
function classifyOverrideValue(name, spec) {
  // npm reads "" as "*", and a "*" value overrides nothing.
  if (spec === "" || spec === "*") return { kind: "none", name };
  if (spec !== spec.trim()) return refused(`"${spec}" has surrounding whitespace`);
  if (spec.startsWith("$")) return refused(`"${spec}" is a $ reference, which this gate does not resolve`);
  if (isNonRegistrySpecifier(spec)) return { kind: "exempt", name, spec };
  if (spec.startsWith("npm:")) {
    const rest = spec.slice("npm:".length);
    const at = rest.indexOf("@", 1);
    const target = at > 0 ? rest.slice(0, at) : rest;
    const sub = at > 0 ? rest.slice(at + 1) || "*" : "*";
    if (!PACKAGE_NAME_RE.test(target)) return refused(`"${spec}" does not alias a registry package`);
    const subClass = sub === "*" ? { kind: "range" } : classifyRegistrySpec(target, sub);
    if (subClass.kind === "exact") return subClass;
    if (subClass.kind === "range") return { kind: "range", name, spec, target };
    return refused(`"${spec}": ${subClass.reason}`);
  }
  return classifyRegistrySpec(name, spec);
}

/** Classify a `dependencies` / `optionalDependencies` specifier; there "" and "*" are ranges. */
function classifyDependencySpec(name, spec) {
  if (spec === "" || spec === "*") return { kind: "range", name, spec };
  return classifyOverrideValue(name, spec);
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const describeType = (v) => (v === null ? "null" : Array.isArray(v) ? "an array" : `a ${typeof v}`);

/**
 * Classify every rule in one manifest's `overrides` value, nested rules
 * included. Each rule is { path, kind, ... } where `path` is the list of keys
 * from the top of `overrides` and `kind` is one of:
 * - "exact": declares an exact target (an alias reports its target);
 * - "range": `name` is overridden with the range `spec` (an `npm:` alias
 *   carries its target package in `target`);
 * - "exempt": `spec` names no registry version (workspace:, file:, link:, git+, github:);
 * - "none": the rule overrides nothing (a "*" or "" value);
 * - "refused": a form this gate does not support, with a `reason`.
 */
export function classifyOverrides(overrides) {
  const rules = [];
  if (!isPlainObject(overrides)) {
    rules.push({ path: [], ...refused(`"overrides" must be an object, not ${describeType(overrides)}`) });
    return rules;
  }
  const walk = (obj, parentPath) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = [...parentPath, key];
      if (key === ".") {
        // The enclosing rule's own value; at the top level it names no package.
        if (parentPath.length === 0) rules.push({ path, ...refused(`a "." key at the top level names no package`) });
        continue;
      }
      const parsed = parseOverrideKey(key);
      if (!parsed) {
        rules.push({ path, ...refused(`the key "${key}" does not name a package`) });
        continue;
      }
      if (typeof value === "string") {
        rules.push({ path, ...classifyOverrideValue(parsed.name, value) });
      } else if (isPlainObject(value)) {
        const own = Object.hasOwn(value, ".") ? value["."] : parsed.selector;
        rules.push({
          path,
          ...(typeof own === "string"
            ? classifyOverrideValue(parsed.name, own)
            : refused(`its "." value must be a string, not ${describeType(own)}`)),
        });
        walk(value, path);
      } else {
        rules.push({ path, ...refused(`the value must be a string or an object, not ${describeType(value)}`) });
      }
    }
  };
  walk(overrides, []);
  return rules;
}

/** `overrides["a"]["b"]` — where a rule sits in its manifest. */
function formatOverridePath(path) {
  return `overrides${path.map((k) => `[${JSON.stringify(k)}]`).join("")}`;
}

/**
 * Collect external, exact-pinned dep pairs to age-check from a list of
 * package objects. Checks `dependencies`, `optionalDependencies` and
 * `overrides`, nested override rules included; refused override forms are
 * not collected here (collectUnsupportedOverrides lists them).
 *
 * Exemptions: `@tpsdev-ai/*`, keep-current list, `workspace:`, `file:`/`link:`,
 * `git+`/`github:`. A `dependencies` / `optionalDependencies` entry is
 * classified by classifyRegistrySpec; only an exact version is age-checked.
 *
 * `peerDependencies` are NOT checked: peers are resolved from a range by the
 * consumer's install, so an exact-pin check of our declaration does not
 * describe what actually gets installed.
 *
 * @param pkgs — package objects with paths
 * @param keepCurrent — the keep-current allow-list
 * @returns Map<"name@version", { name, version, declaredIn }>
 */
export function collectDeps(pkgs, keepCurrent) {
  const toCheck = new Map(); // key: "name@version", value: { name, version, declaredIn[] }

  function record(name, version, declaredIn) {
    if (name.startsWith("@tpsdev-ai/")) return; // workspace-internal — exempt
    if (keepCurrent.has(name)) return; // explicitly kept-current — exempt
    const key = `${name}@${version}`;
    if (!toCheck.has(key)) {
      toCheck.set(key, { name, version, declaredIn: [] });
    }
    const entry = toCheck.get(key);
    if (!entry.declaredIn.includes(declaredIn)) entry.declaredIn.push(declaredIn);
  }

  function recordDeps(deps, declaredIn) {
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string") continue;
      // Only exact versions are age-checked; the gate reads manifests, not the lockfile.
      const classified = classifyDependencySpec(name, spec);
      if (classified.kind === "exact") record(classified.name, classified.version, declaredIn);
    }
  }

  for (const { pkg, path } of pkgs) {
    if (pkg.dependencies) recordDeps(pkg.dependencies, path);
    if (pkg.optionalDependencies) recordDeps(pkg.optionalDependencies, path);
    if (pkg.overrides !== undefined) {
      for (const rule of classifyOverrides(pkg.overrides)) {
        if (rule.kind === "exact") record(rule.name, rule.version, path);
      }
    }
  }

  return toCheck;
}

/**
 * Every ranged declaration the bake-time gate age-checks through the lockfile:
 * `dependencies`, `devDependencies` and `optionalDependencies` of every
 * manifest, and every `overrides` rule, nested rules included. Each entry is
 * { kind, name, target, spec, declaredIn, workspaceDir } where `name` is the
 * declared key, `target` the registry package it installs (an `npm:` alias
 * differs) and `workspaceDir` the manifest's directory ("" for the root).
 *
 * Exemptions match collectDeps: `@tpsdev-ai/*` and the keep-current list.
 * `workspace:`, `file:`/`link:` and `git+`/`github:` specifiers are not ranges
 * and are not collected.
 */
export function collectRangedDeps(pkgs, keepCurrent) {
  const out = [];
  const seen = new Set();
  function add(entry) {
    if (entry.target.startsWith("@tpsdev-ai/")) return;
    if (keepCurrent.has(entry.target) || keepCurrent.has(entry.name)) return;
    const key = [entry.kind, entry.name, entry.target, entry.spec, entry.declaredIn, entry.parent ?? ""].join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  }
  const workspaceDirOf = (path) => (path === "package.json" ? "" : path.replace(/\/package\.json$/, ""));
  for (const { pkg, path } of pkgs) {
    const workspaceDir = workspaceDirOf(path);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = pkg[field];
      if (!isPlainObject(deps)) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== "string") continue;
        const classified = classifyDependencySpec(name, spec);
        if (classified.kind !== "range") continue;
        add({
          kind: "dependency",
          field,
          name,
          target: classified.target ?? name,
          spec,
          declaredIn: path,
          workspaceDir,
        });
      }
    }
    if (pkg.overrides === undefined) continue;
    for (const rule of classifyOverrides(pkg.overrides)) {
      if (rule.kind !== "range") continue;
      // A nested rule applies to copies under its enclosing package; the
      // parent key may carry a selector, so resolve it to the package name.
      const parentKey = rule.path.length > 1 ? rule.path[rule.path.length - 2] : null;
      const parent = parentKey === null ? null : parseOverrideKey(parentKey);
      add({
        kind: "override",
        name: rule.name,
        target: rule.target ?? rule.name,
        spec: rule.spec,
        declaredIn: path,
        workspaceDir,
        parent: parent ? parent.name : null,
      });
    }
  }
  return out;
}

/**
 * bun.lock is JSON with trailing commas (the text lockfile Bun writes). Parse
 * it; an unparsable lock is an error, never an empty tree.
 */
export function parseBunLockText(text) {
  try {
    return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
  } catch (err) {
    throw new Error(`bun.lock is not parsable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The package name a lock `packages` key resolves, and the path of parent
 * packages it is nested under. A key is a path of package names, so a scoped
 * package takes the last two segments (`@scope/name`) and its parents the
 * rest.
 */
function splitLockKey(key) {
  const parts = key.split("/");
  const last = parts[parts.length - 1];
  if (!last) return null;
  const scoped = parts.length >= 2 && parts[parts.length - 2].startsWith("@");
  const name = scoped ? `${parts[parts.length - 2]}/${last}` : last;
  const prefix = parts.slice(0, scoped ? parts.length - 2 : parts.length - 1).join("/");
  return { name, prefix };
}

/** The version in a lock entry's `name@version` spec, or null. */
function lockEntryVersion(entry) {
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return null;
  const at = entry[0].lastIndexOf("@");
  return at > 0 ? entry[0].slice(at + 1) || null : null;
}

/** Index a parsed lockfile's `packages` by key and by package name. */
export function lockCopies(lock) {
  const byKey = new Map();
  const byName = new Map();
  const packages = lock?.packages ?? {};
  if (!isPlainObject(packages)) return { byKey, byName };
  for (const [key, entry] of Object.entries(packages)) {
    const version = lockEntryVersion(entry);
    const split = splitLockKey(key);
    if (version === null || split === null) continue;
    const copy = { key, name: split.name, prefix: split.prefix, version };
    byKey.set(key, copy);
    if (!byName.has(copy.name)) byName.set(copy.name, []);
    byName.get(copy.name).push(copy);
  }
  return { byKey, byName };
}

/**
 * Resolve every ranged declaration to the lockfile entries it installs:
 * - a dependency range resolves through its workspace's own entry
 *   (`<workspace name>/<package>`) when the lock carries one, else the hoisted
 *   entry (`<package>`);
 * - an overrides range covers every copy of the package in the lock, since an
 *   override applies to each of them. A nested rule is limited to copies under
 *   its enclosing package when the lock has such copies.
 *
 * Every declaration with no entry is returned in `unresolved` (the CLI fails
 * closed on a dependency with none, and names an overrides rule whose package
 * is not installed), never silently skipped.
 *
 * @returns {{ resolved: Array<{name, version, spec, declaredIn}>, unresolved: Array<{name, spec, declaredIn, reason}> }}
 */
export function resolveRangedDeps(entries, lock) {
  const { byKey, byName } = lockCopies(lock);
  const workspaces = isPlainObject(lock?.workspaces) ? lock.workspaces : {};
  const resolved = [];
  const unresolved = [];
  const seen = new Set();
  for (const entry of entries) {
    let copies = [];
    if (entry.kind === "override") {
      const all = byName.get(entry.target) ?? [];
      if (entry.parent) {
        copies = all.filter((c) => c.prefix === entry.parent || c.prefix.endsWith(`/${entry.parent}`));
        if (copies.length === 0) copies = all;
      } else {
        copies = all;
      }
    } else {
      const workspaceName = workspaces[entry.workspaceDir]?.name;
      if (typeof workspaceName === "string" && workspaceName !== "") {
        const own = byKey.get(`${workspaceName}/${entry.target}`);
        if (own) copies = [own];
      }
      if (copies.length === 0) {
        const hoisted = byKey.get(entry.target);
        if (hoisted) copies = [hoisted];
      }
    }
    if (copies.length === 0) {
      unresolved.push({
        kind: entry.kind,
        name: entry.name,
        spec: entry.spec,
        declaredIn: entry.declaredIn,
        reason: `bun.lock has no entry for ${entry.target}`,
      });
      continue;
    }
    for (const copy of copies) {
      const key = [entry.target, copy.version, entry.spec, entry.declaredIn, entry.kind].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({
        name: entry.target,
        version: copy.version,
        spec: entry.spec,
        declaredIn: entry.declaredIn,
        kind: entry.kind,
      });
    }
  }
  return { resolved, unresolved };
}

/**
 * The override rules in a form this gate does not support. The CLI refuses to
 * run while any exist.
 *
 * @param pkgs — package objects with paths
 * @returns Array<{ declaredIn, at, reason }>
 */
export function collectUnsupportedOverrides(pkgs) {
  const unsupported = [];
  for (const { pkg, path } of pkgs) {
    if (pkg.overrides === undefined) continue;
    for (const rule of classifyOverrides(pkg.overrides)) {
      if (rule.kind === "refused") {
        unsupported.push({ declaredIn: path, at: formatOverridePath(rule.path), reason: rule.reason });
      }
    }
  }
  return unsupported;
}

/**
 * The dependencies and optionalDependencies entries in a form this gate does
 * not support. The CLI refuses to run while any exist.
 *
 * @param pkgs — package objects with paths
 * @returns Array<{ declaredIn, field, name, spec, reason }>
 */
export function collectUnsupportedDeps(pkgs) {
  const unsupported = [];
  for (const { pkg, path } of pkgs) {
    for (const field of ["dependencies", "optionalDependencies"]) {
      const deps = pkg[field];
      if (deps === undefined) continue;
      if (!isPlainObject(deps)) {
        unsupported.push({ declaredIn: path, field, name: field, spec: "", reason: `it must be an object, not ${describeType(deps)}` });
        continue;
      }
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== "string") {
          unsupported.push({ declaredIn: path, field, name, spec: String(spec), reason: `the specifier must be a string, not ${describeType(spec)}` });
          continue;
        }
        const classified = classifyDependencySpec(name, spec);
        if (classified.kind === "refused") unsupported.push({ declaredIn: path, field, name, spec, reason: classified.reason });
      }
    }
  }
  return unsupported;
}
