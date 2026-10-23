import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
// @ts-expect-error — plain .mjs helper, no type declarations by design.
import { harperSearchPaths, resolveHarperDependency, vendorPinnedNodeProblems } from "../../scripts/audit-gate.mjs";

/**
 * The audit gate's dependency lookup compared with Node's resolver on a tree of
 * real directories and package.json files. Node runs as a child process, so the
 * comparison is with `node`'s resolver rather than the test runner's. The gate
 * searches no higher than harper's directory, so a package Node resolves above
 * it is expected to resolve to nothing in the gate.
 */

const NODE_TIMEOUT_MS = 30_000;
const CASE_BUDGET_MS = 60_000;

type Manifest = { name: string; version: string; dependencies?: Record<string, string>; bundleDependencies?: string[] };

const HARPER = "node_modules/harper";
const deps = (...names: string[]) => Object.fromEntries(names.map((name) => [name, "*"]));

/** Package directory (relative to the prefix) -> its package.json. */
const PACKAGES: Record<string, Manifest> = {
  "node_modules/above-only": { name: "above-only", version: "1.0.0" },
  [HARPER]: {
    name: "harper",
    version: "1.0.0",
    dependencies: deps("pkg-a", "@scope-s/pkg-d", "above-only", "nm-only"),
    bundleDependencies: ["pkg-a"],
  },
  [`${HARPER}/node_modules/pkg-a`]: {
    name: "pkg-a",
    version: "1.0.0",
    dependencies: deps("pkg-b", "pkg-c", "@scope-s/pkg-d", "pkg-e", "nm-only", "above-only", "absent"),
  },
  [`${HARPER}/node_modules/pkg-a/node_modules/pkg-b`]: { name: "pkg-b", version: "2.0.0", dependencies: deps("pkg-c", "pkg-b") },
  [`${HARPER}/node_modules/pkg-b`]: { name: "pkg-b", version: "1.0.0", dependencies: deps("pkg-c") },
  [`${HARPER}/node_modules/pkg-c`]: { name: "pkg-c", version: "1.0.0", dependencies: deps("pkg-b", "pkg-e") },
  [`${HARPER}/node_modules/@scope-s/pkg-d`]: {
    name: "@scope-s/pkg-d",
    version: "1.0.0",
    dependencies: deps("pkg-e", "pkg-f", "pkg-b", "nm-only"),
  },
  [`${HARPER}/node_modules/@scope-s/pkg-d/node_modules/pkg-f`]: { name: "pkg-f", version: "1.0.0" },
  [`${HARPER}/node_modules/@scope-s/node_modules/pkg-e`]: { name: "pkg-e", version: "1.0.0" },
  // Only in harper's node_modules/node_modules, a directory Node's search lists leave out.
  [`${HARPER}/node_modules/node_modules/nm-only`]: { name: "nm-only", version: "1.0.0", dependencies: deps("pkg-c", "pkg-g") },
  // Required only by nm-only.
  [`${HARPER}/node_modules/pkg-g`]: { name: "pkg-g", version: "1.0.0" },
};

let root: string | undefined;

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Write the fixture once; returns the real paths of the prefix and harper's directory. */
function fixture(): { prefix: string; realHarper: string } {
  if (!root) {
    root = realpathSync(mkdtempSync(join(tmpdir(), "flair-audit-parity-")));
    for (const [dir, manifest] of Object.entries(PACKAGES)) {
      mkdirSync(join(root, "prefix", dir), { recursive: true });
      writeFileSync(join(root, "prefix", dir, "package.json"), JSON.stringify(manifest));
    }
    mkdirSync(join(root, "home"));
  }
  return { prefix: join(root, "prefix"), realHarper: join(root, "prefix", HARPER) };
}

type Edge = { requirer: string; dep: string };
type NodeAnswer = { resolved: string | null; paths: string[] };

/** Every dependency edge of every package at or below harper's directory. */
function edges(prefix: string): Edge[] {
  return Object.entries(PACKAGES)
    .filter(([dir]) => dir === HARPER || dir.startsWith(`${HARPER}/`))
    .flatMap(([dir, manifest]) =>
      Object.keys(manifest.dependencies ?? {}).map((dep) => ({ requirer: join(prefix, dir), dep })),
    );
}

/** Node's answer for each edge: `createRequire(<requirer>/package.json)`'s resolve and resolve.paths. */
function nodeAnswers(edgeList: Edge[]): NodeAnswer[] {
  const script = join(root!, "node-resolve.mjs");
  writeFileSync(
    script,
    [
      'import { createRequire } from "node:module";',
      'import { readFileSync } from "node:fs";',
      'const edges = JSON.parse(readFileSync(0, "utf8"));',
      "const answers = edges.map(({ requirer, dep }) => {",
      '  const req = createRequire(requirer + "/package.json");',
      "  let resolved = null;",
      '  try { resolved = req.resolve(dep + "/package.json"); } catch (e) { if (e.code !== "MODULE_NOT_FOUND") throw e; }',
      "  return { resolved, paths: req.resolve.paths(dep) };",
      "});",
      "process.stdout.write(JSON.stringify(answers));",
      "",
    ].join("\n"),
  );
  const run = spawnSync("node", [script], {
    input: JSON.stringify(edgeList),
    encoding: "utf8",
    timeout: NODE_TIMEOUT_MS,
    env: { PATH: process.env.PATH ?? "", HOME: join(root!, "home") },
  });
  if (run.error || run.status !== 0) {
    throw new Error(`node resolver script failed (status ${run.status}, ${run.error?.message ?? "no spawn error"}):\n${run.stderr}`);
  }
  return JSON.parse(run.stdout) as NodeAnswer[];
}

describe("the audit gate's dependency lookup matches Node's resolver", () => {
  it(
    "matches Node's resolution inside harper's directory, and Node's search directories up to it, for each edge of the fixture tree",
    () => {
      const { prefix, realHarper } = fixture();
      const edgeList = edges(prefix);
      const answers = nodeAnswers(edgeList);
      const insideHarper = (path: string) => path.startsWith(`${realHarper}${sep}`);
      const show = (path: string | null) => (path === null ? null : relative(prefix, path));
      const label = (edge: Edge) => `${relative(prefix, edge.requirer)} -> ${edge.dep}`;

      const gate = edgeList.map((edge) => ({
        edge: label(edge),
        resolved: show(resolveHarperDependency(edge.requirer, realHarper, edge.dep)?.manifest ?? null),
        paths: harperSearchPaths(edge.requirer, realHarper).map(show),
      }));
      const node = edgeList.map((edge, i) => ({
        edge: label(edge),
        resolved: show(answers[i]!.resolved !== null && insideHarper(answers[i]!.resolved!) ? answers[i]!.resolved : null),
        paths: answers[i]!.paths.filter(insideHarper).map(show),
      }));
      expect(gate).toEqual(node);

      // The fixture exercises the cases the comparison is for.
      const byEdge = new Map(edgeList.map((edge, i) => [label(edge), answers[i]!]));
      const pkgA = `${HARPER}/node_modules/pkg-a`;
      expect(edgeList.length).toBe(22);
      expect(byEdge.get(`${pkgA} -> nm-only`)!.resolved).toBeNull();
      expect(show(byEdge.get(`${pkgA} -> above-only`)!.resolved)).toBe("node_modules/above-only/package.json");
      expect(show(byEdge.get(`${pkgA} -> pkg-b`)!.resolved)).toBe(`${pkgA}/node_modules/pkg-b/package.json`);
      expect(show(byEdge.get(`${HARPER}/node_modules/@scope-s/pkg-d -> pkg-e`)!.resolved)).toBe(
        `${HARPER}/node_modules/@scope-s/node_modules/pkg-e/package.json`,
      );
      expect(byEdge.get(`${pkgA} -> pkg-c`)!.paths.filter(insideHarper).map(show)).toEqual([
        `${pkgA}/node_modules`,
        `${HARPER}/node_modules`,
      ]);
    },
    CASE_BUDGET_MS,
  );

  it(
    "certifies a package reached through edges Node resolves, but not one reached only through an edge Node refuses",
    () => {
      const { prefix } = fixture();
      const lock = {
        packages: {
          [`${HARPER}/node_modules/pkg-c`]: { version: "1.0.0", inBundle: true },
          [`${HARPER}/node_modules/pkg-g`]: { version: "1.0.0", inBundle: true },
        },
      };
      writeFileSync(join(prefix, "package-lock.json"), JSON.stringify(lock));
      const check = (pkg: string) =>
        vendorPinnedNodeProblems(
          { ghsa: "GHSA-0000-0000-0003", package: pkg, nodes: [`${HARPER}/node_modules/${pkg}`], nodeVersions: {} },
          prefix,
        );
      expect(check("pkg-c")).toEqual([]);
      const problems = check("pkg-g").join("\n");
      expect(problems).toContain(`${HARPER}/node_modules/pkg-g`);
      expect(problems).toContain(`"pkg-g" is not listed in harper's bundleDependencies and is not in a bundled package's dependency closure`);
    },
    CASE_BUDGET_MS,
  );
});
