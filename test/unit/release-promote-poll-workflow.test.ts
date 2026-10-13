/**
 * release-promote-poll-workflow.test.ts — flair#1928 slice 1.
 *
 * Shape tests for `.github/workflows/release-promote-poll.yml`, the UNPRIVILEGED
 * poll. It must hold no credential (no environment, no repo secret), must not
 * check out a tag's tree, must read the version from the marker payload, must use
 * an ALL-form readiness predicate, and must never let its outputs decide what gets
 * promoted.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
}
interface Job {
  name?: string;
  if?: string;
  permissions?: Record<string, string>;
  environment?: string;
  steps?: Step[];
}
interface Workflow {
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, Job>;
}

const REPO = join(import.meta.dir, "..", "..");
const PATH = join(REPO, ".github", "workflows", "release-promote-poll.yml");
const raw = readFileSync(PATH, "utf8");
const wf = yaml.load(raw) as unknown as Workflow;

function job(name: string): Job {
  const found = wf.jobs?.[name];
  expect(found, `job ${name} exists`).toBeDefined();
  return found as Job;
}

describe("release-promote-poll — no credential, trusted-main only", () => {
  test("permissions: {} at the top; the poll job holds actions: write + contents/deployments read only", () => {
    expect(wf.permissions).toEqual({});
    expect(job("poll").permissions).toEqual({
      "actions": "write",
      "contents": "read",
      "deployments": "read",
    });
  });

  test("NO environment, and NO repo secret anywhere in the workflow", () => {
    for (const [name, j] of Object.entries(wf.jobs ?? {})) {
      expect(j.environment, `job ${name} has no environment`).toBeUndefined();
    }
    // The only credential-shaped value allowed is the auto GITHUB_TOKEN.
    const secretRefs = [...raw.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect([...new Set(secretRefs)]).toEqual(["GITHUB_TOKEN"]);
    expect(raw).not.toContain("NPM_TOKEN");
    // No `environment:` KEY at all (the word in prose is fine).
    expect(/^\s*environment:/m.test(raw), "no environment: key").toBe(false);
  });

  test("it checks out scripts/ci from the DEFAULT BRANCH (github.sha), never a tag ref", () => {
    const checkout = job("poll").steps?.find((s) => (s.uses ?? "").startsWith("actions/checkout"));
    expect(checkout, "the poll checks out").toBeDefined();
    expect(String(checkout?.with?.ref)).toBe("${{ github.sha }}");
    expect(String(checkout?.with?.ref)).not.toContain("refs/tags");
    const sparse = String(checkout?.with?.["sparse-checkout"]);
    expect(sparse).toContain("scripts/ci");
    // The derivation reads the root package.json and packages/*/package.json, so
    // the sparse checkout must bring them — otherwise lockstep-packages.mjs sees
    // an empty tree and (before the fail-closed fix) an empty package list.
    expect(sparse).toContain("package.json");
    expect(sparse).toContain("packages/*/package.json");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  test("the version comes from the MARKER PAYLOAD, never from main's package.json", () => {
    const script = job("poll").steps?.map((s) => s.run ?? "").join("\n") ?? "";
    expect(script).toContain(".payload.package_set_digest");
    expect(script).toContain(".payload.version");
    expect(script).not.toContain("package.json");
    // Every lockstep package must be public and measurable — ALL-form.
    expect(script).toContain("registry-tarball-sha256.mjs");
    expect(script).toContain("lockstep-packages.mjs");
    expect(script).toContain("NOT READY");
  });

  test("on READY it dispatches release-promote.yml on the tag REF, and the dispatch is gated on the file existing", () => {
    const script = job("poll").steps?.map((s) => s.run ?? "").join("\n") ?? "";
    expect(script).toContain("gh workflow run release-promote.yml");
    expect(script).toContain("--ref");
    expect(script).toContain("release-promote.yml"); // the existence gate
    expect(script).toContain("would dispatch");
  });

  test("the header says the poll's outputs are never an input to what gets promoted", () => {
    expect(raw).toContain("NEVER an input to what gets promoted");
  });
});

describe("release-promote-poll — round 2: derivation, payload version, all pages, main-bound dispatch", () => {
  const runScript = () => (job("poll").steps ?? []).map((s) => s.run ?? "").join("\n");

  test("the package-list derivation FAILS CLOSED: status captured separately, empty is an error, no swallowing substitution", () => {
    const script = runScript();
    // The output and its exit status are captured SEPARATELY.
    expect(script).toContain("pkgs_status=$?");
    expect(script).toContain('if [ "${pkgs_status}" -ne 0 ]');
    expect(script).toContain('if [ ! -s "${PKGS}" ]');
    expect(script).toMatch(/exit 1/);
    // No `< <(node scripts/ci/lockstep-packages.mjs …)` that can swallow a non-zero exit.
    expect(script).not.toContain("< <(node scripts/ci/lockstep-packages.mjs");
  });

  test("the version is the PAYLOAD's and is validated against the ref (a mismatch refuses the marker)", () => {
    const script = runScript();
    expect(script).toContain("payload_version"); // assertion: the payload field is read
    expect(script).toContain('[ "${ref}" != "v${payload_version}" ]'); // assertion: ref must equal v<payload.version>
    expect(script).toContain("refusing this marker"); // assertion: mismatch skips
    expect(script).not.toMatch(/\bversion="\$\{ref#v\}"/); // assertion: never the ref alone
  });

  test("ALL deployment pages are read: the flatten uses add, not .[0]", () => {
    const script = runScript();
    expect(script).toContain("--paginate"); // assertion: every page is fetched
    expect(script).toContain("jq -s 'add"); // assertion: pages are flattened
    expect(script).not.toContain(".[0]"); // assertion: no first-page-only form
  });

  test("BEHAVIOURAL: a marker on page 2 is seen by the flatten (and .[0] would miss it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-pages-"));
    try {
      const p1 = join(dir, "p1.json");
      const p2 = join(dir, "p2.json");
      writeFileSync(p1, JSON.stringify([{ ref: "v0.1.0", payload: { version: "0.1.0" } }]));
      writeFileSync(p2, JSON.stringify([{ ref: "v0.2.0", payload: { version: "0.2.0" } }]));
      const flat = spawnSync("jq", ["-s", "add // [] | map(.ref)", p1, p2], { encoding: "utf8" });
      expect(flat.status, String(flat.stderr)).toBe(0);
      const refs = JSON.parse(flat.stdout) as string[];
      expect(refs).toContain("v0.2.0"); // assertion: the page-2 marker is seen
      const old = spawnSync("jq", ["-s", ".[0] | map(.ref)", p1, p2], { encoding: "utf8" });
      expect(JSON.parse(old.stdout) as string[]).not.toContain("v0.2.0"); // the old bug
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the poll runs ONLY on schedule — no manual trigger, so every run is the default branch's copy of the file", () => {
    // `gh workflow run --ref <branch>` runs THAT branch's version of the workflow file, so a guard
    // inside the file cannot bind a manual run to main (Gauge pass 2 on #1932). Schedule runs always
    // execute the default branch's copy.
    // js-yaml (YAML 1.1) reads the bare key `on` as boolean true, so accept either spelling.
    const parsed = wf as unknown as { on?: Record<string, unknown>; true?: Record<string, unknown> };
    const on = (parsed.on ?? parsed.true ?? {}) as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(["schedule"]); // assertion: schedule is the only trigger
    expect(raw).not.toMatch(/^\s*workflow_dispatch\s*:/m); // assertion: no manual trigger key anywhere in the file
  });
});

describe("release-promote-poll — dispatch at most once per version (#1928 slice 2)", () => {
  const runScript = () => (job("poll").steps ?? []).map((s) => s.run ?? "").join("\n");

  test("the READY dispatch is gated on a run already existing for the version, read fail-closed", () => {
    const script = runScript();
    expect(script).toContain("release-promote.yml/runs");
    expect(script).toContain("not dispatching again");
    // A failed (or uninterpretable) read is an error exit, never a dispatch on an unknown.
    expect(script).toContain("refusing to dispatch");
    expect(script).toMatch(/if ! gh api --paginate "repos\/\$\{REPO\}\/actions\/workflows\/release-promote\.yml\/runs/);
    // The auto-dispatch is a REAL promote (the workflow's dry_run defaults to true
    // for a manual run), so the npm approval really is the only human action.
    expect(script).toContain('gh workflow run release-promote.yml --ref "${ref}" -f dry_run=false');
  });

  /**
   * Run the poll's REAL `ALREADY="$(jq ...)"` line (extracted verbatim, flags and
   * all) against `--paginate`-shaped output: one JSON object PER PAGE, written
   * back to back, exactly as `gh api --paginate` prints a run list.
   */
  function already(pages: unknown[] | string): string {
    const line = runScript()
      .split("\n")
      .find((l) => /^\s*ALREADY="\$\(jq /.test(l));
    expect(line, "the poll's ALREADY= jq line is present").toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "poll-runs-"));
    try {
      const runs = join(dir, "runs.json");
      writeFileSync(runs, typeof pages === "string" ? pages : pages.map((p) => JSON.stringify(p)).join("\n"));
      const sh = join(dir, "already.sh");
      writeFileSync(sh, `set -euo pipefail\nversion=1.2.3\nRUNS=${JSON.stringify(runs)}\n${line!.trim()}\nprintf '%s' "$ALREADY"\n`);
      const r = spawnSync("bash", [sh], { encoding: "utf8" });
      return r.status === 0 ? r.stdout.trim() : `exit ${r.status}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const page = (...runs: unknown[]) => ({ total_count: 999, workflow_runs: runs });

  test("BEHAVIOURAL: the run-name / head-branch predicate identifies a version's run", () => {
    // A run for THIS version, by run-name or by head branch → true (do not dispatch again).
    expect(already([page({ display_title: "release-promote v1.2.3", head_branch: "v1.2.3" })])).toBe("true");
    expect(already([page({ display_title: "other", head_branch: "v1.2.3" })])).toBe("true");
    expect(already([page({ display_title: "release-promote v1.2.3", head_branch: null })])).toBe("true");
    // No run for this version → false (dispatch once).
    expect(already([page({ display_title: "release-promote v1.2.2", head_branch: "v1.2.2" })])).toBe("false");
    expect(already([page()])).toBe("false");
  });

  test("BEHAVIOURAL: every page is flattened into ONE decision — a match on page two is found", () => {
    const p1 = page(
      ...Array.from({ length: 100 }, (_, i) => ({ display_title: `release-promote v0.0.${i}`, head_branch: `v0.0.${i}` })),
    );
    const p2 = page({ display_title: "release-promote v1.2.3", head_branch: "v1.2.3" });
    expect(already([p1, p2])).toBe("true");
    // …and two pages with no match anywhere are ONE "false", not one value per page.
    expect(already([p1, page({ display_title: "release-promote v1.2.2", head_branch: "v1.2.2" })])).toBe("false");
  });

  test("BEHAVIOURAL: an uninterpretable run list is never read as 'no run'", () => {
    // A page without a workflow_runs array, or no page at all, yields neither
    // accepted value, so the poll's next check errors out instead of dispatching.
    expect(already([page(), { message: "Not Found" }])).toBe("invalid");
    expect(already("")).toBe("invalid");
    expect(already("{not json")).toMatch(/^exit [1-9]/);
  });
});
