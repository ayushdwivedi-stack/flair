/**
 * release-promote-workflow.test.ts — flair#1928 slice 2.
 *
 * Shape tests for `.github/workflows/release-promote.yml`, the PRIVILEGED
 * promote, and for the `workflow_call` trigger it adds to `canary.yml`.
 *
 * The control this file exists to guard: a step that can see `NPM_TOKEN` must
 * NEVER execute a path from the tag's checkout, and every fact the job acts on
 * must be re-derived from an immutable input and fail closed when it cannot be.
 * The static tests pin the shape; the behavioural tests extract the real `run:`
 * scripts from the YAML and drive them with fixtures, so each named refusal is
 * exercised, not merely spelled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  permissions?: Record<string, string>;
  environment?: string;
  env?: Record<string, unknown>;
  steps?: Step[];
}
interface Workflow {
  "run-name"?: string;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  on?: Record<string, unknown>;
  true?: Record<string, unknown>;
  jobs?: Record<string, Job>;
}

const REPO = join(import.meta.dir, "..", "..");
const WF_PATH = join(REPO, ".github", "workflows", "release-promote.yml");
const CANARY_PATH = join(REPO, ".github", "workflows", "canary.yml");
const raw = readFileSync(WF_PATH, "utf8");
const wf = yaml.load(raw) as unknown as Workflow;
const canaryRaw = readFileSync(CANARY_PATH, "utf8");
const canaryWf = yaml.load(canaryRaw) as unknown as Workflow;

function job(name: string): Job {
  const found = wf.jobs?.[name];
  expect(found, `job ${name} exists`).toBeDefined();
  return found as Job;
}
function runOf(name: string, stepId: string): string {
  const step = (job(name).steps ?? []).find((s) => s.id === stepId);
  expect(step, `step #${stepId} in job ${name} exists`).toBeDefined();
  return step?.run ?? "";
}
/** The workflow triggers, whichever spelling js-yaml produced for the bare `on` key. */
function triggers(doc: Workflow): Record<string, unknown> {
  return (doc.on ?? doc.true ?? {}) as Record<string, unknown>;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "promote-wf-"));
  tmpDirs.push(dir);
  return dir;
}

describe("release-promote — the privileged job's credential and boundary", () => {
  test("permissions: {} at the top; each job opts into read-only grants", () => {
    expect(wf.permissions).toEqual({});
    expect(job("prepare").permissions).toEqual({ contents: "read", deployments: "read" });
    expect(job("promote").permissions).toEqual({ contents: "read", deployments: "read" });
  });

  test("only the promote job takes the release-promote environment", () => {
    expect(job("promote").environment).toBe("release-promote");
    expect(job("prepare").environment).toBeUndefined();
    expect(job("canary").environment).toBeUndefined();
    expect((canaryWf.jobs?.canary as Job | undefined)?.environment).toBeUndefined();
  });

  test("NPM_TOKEN is referenced in exactly ONE step, and no job-level env carries it", () => {
    for (const [name, j] of Object.entries(wf.jobs ?? {})) {
      const jobEnv = JSON.stringify(j.env ?? {});
      expect(jobEnv, `job ${name} has no job-level NPM_TOKEN`).not.toContain("NPM_TOKEN");
    }
    // The secret reference appears once in the whole file, in the promote job's
    // final step, whose env is the only one that names NPM_TOKEN.
    const secretRefs = [...raw.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(secretRefs).toEqual(["NPM_TOKEN"]);
    const steps = job("promote").steps ?? [];
    const withToken = steps.filter((s) => JSON.stringify(s.env ?? {}).includes("NPM_TOKEN"));
    expect(withToken.length).toBe(1);
    expect(withToken[0], "the token step is the LAST step of the promote job").toBe(steps[steps.length - 1]);
    expect(withToken[0]?.name).toContain("NPM_TOKEN");
    // The token reaches npm only through the throwaway .npmrc indirection, never
    // as a command argument.
    expect(withToken[0]?.run ?? "").toContain("_authToken=${NPM_TOKEN}");
    expect(withToken[0]?.run ?? "").not.toContain("--otp");
  });

  test("no step that can see the token runs a path from the tag checkout", () => {
    // The token step runs only the trusted block, from the trusted tree.
    const tokenRun = (job("promote").steps ?? [])
      .filter((s) => JSON.stringify(s.env ?? {}).includes("NPM_TOKEN"))
      .map((s) => s.run ?? "")
      .join("\n");
    expect(tokenRun).toContain('cd "$TRUSTED"');
    expect(tokenRun).not.toContain("$GITHUB_WORKSPACE");
    // The trusted tree is materialised from the pinned origin/main sha, not from
    // the tag's checkout.
    const materialise = (job("promote").steps ?? []).find((s) => s.name?.includes("trusted tree"));
    expect(materialise, "the trusted tree step exists").toBeDefined();
    expect(materialise?.run ?? "").toContain("git archive");
    expect(materialise?.run ?? "").toContain("MAIN_SHA");
    expect(materialise?.run ?? "").toContain("TRUSTED=${TRUSTED}");
  });

  test("the machinery-recency guard runs first and pins origin/main", () => {
    const steps = job("promote").steps ?? [];
    const guard = steps.find((s) => s.id === "guard");
    expect(guard, "the guard step exists").toBeDefined();
    expect(guard?.run ?? "").toContain("git fetch --no-tags origin main");
    expect(guard?.run ?? "").toContain("merge-base --is-ancestor");
    // Every file the job executes is compared byte-for-byte against origin/main.
    for (const f of [
      ".github/workflows/release-promote.yml",
      ".github/workflows/canary.yml",
      "scripts/ci/canary-verdict.sh",
      "scripts/ci/lockstep-packages.mjs",
      "scripts/ci/registry-tarball-sha256.mjs",
      "scripts/ci/registry-latest-skew.mjs",
      "scripts/ci/package-set-digest.mjs",
    ]) {
      expect(guard?.run ?? "", `the guard covers ${f}`).toContain(f);
    }
  });
});

describe("release-promote — the machine surface and the canary order", () => {
  test("the canary is called (workflow_call) and the promote needs it", () => {
    expect(job("canary").uses).toBe("./.github/workflows/canary.yml");
    expect(job("canary").needs).toBe("prepare");
    expect(job("promote").needs).toBe("canary");
    // The called workflow takes the three inputs the manual dispatch takes.
    const call = triggers(canaryWf)["workflow_call"] as { inputs?: Record<string, unknown> } | undefined;
    expect(call, "canary.yml accepts a workflow_call").toBeDefined();
    expect(Object.keys(call?.inputs ?? {}).sort()).toEqual([
      "expected_sha256",
      "package_set_digest",
      "version",
    ]);
    expect(triggers(canaryWf)["workflow_dispatch"]).toBeDefined();
  });

  test("the promote block comes from `--emit bash`, never from scraping the markdown", () => {
    const emit = runOf("promote", "emit");
    expect(emit).toContain("canary-verdict.sh");
    expect(emit).toContain("--emit bash");
    expect(emit).toContain('cd "$TRUSTED"');
    // No fence-scraping: the block is not extracted from the human verdict text.
    expect(raw).not.toContain("sed -n");
  });
});

describe("release-promote — every re-derivation fails closed", () => {
  test("static shape: the version, ancestry, marker and digest checks each exist with a named refusal", () => {
    const derive = runOf("promote", "derive");
    expect(derive).toContain("GITHUB_REF_NAME");
    expect(derive).toContain("is not an exact v<major>.<minor>.<patch> release tag");
    expect(derive).toContain("no release-attempt marker for v");
    expect(derive).toContain("does not match the ref's");
    expect(derive).toContain("no valid package_set_digest");
    expect(derive).toContain("not the certified set");
    // The lockstep derivation is captured with its exit status separately.
    expect(derive).toContain('if ! node scripts/ci/lockstep-packages.mjs > "$PKGS"');
    expect(derive).not.toContain("< <(node scripts/ci/lockstep-packages.mjs");
  });

  test("the dry-run input defaults to true and gates only the dist-tag step", () => {
    const on = triggers(wf) as { workflow_dispatch?: { inputs?: Record<string, { default?: unknown; type?: string }> } };
    const dry = on.workflow_dispatch?.inputs?.dry_run;
    expect(dry?.type).toBe("boolean");
    expect(dry?.default).toBe(true);
    const steps = job("promote").steps ?? [];
    const tokenStep = steps[steps.length - 1];
    expect(tokenStep?.if).toContain("inputs.dry_run == false");
    const dryStep = steps.find((s) => s.name?.includes("Dry run"));
    expect(dryStep?.if).toContain("inputs.dry_run == true");
  });

  test("the run-name lets the poll identify a version's run", () => {
    expect(wf["run-name"]).toBe("release-promote ${{ github.ref_name }}");
  });
});

// ── Behavioural: drive the real `derive` step with fixtures ──────────────────
//
// The step's `run:` is extracted verbatim and executed, with a FAKE `gh` (an
// external network service, exempt from the real-component rule) and a fixture
// trusted tree. The registry hasher is stubbed (it would hit the network), but
// the lockstep-package and package-set-digest scripts are the REAL repo files, so
// the digest comparison is exercised end to end.

/** sha256 over `<name>@<version> <sha>\n` lines, byte-sorted — the canonical form. */
function canonicalDigest(version: string, lines: Record<string, string>): string {
  const rows = Object.entries(lines)
    .map(([pkg, sha]) => `${pkg}@${version} ${sha}\n`)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return createHash("sha256").update(rows.join("")).digest("hex");
}

interface DeriveFixture {
  refName: string;
  deployments: unknown[];
  stubFailPkg?: string;
  /** `ok` (the real script) | `empty` (exit 0, no output) | `fail` (exit 2). */
  lockstep?: "ok" | "empty" | "fail";
}

function runDerive(fx: DeriveFixture) {
  const dir = scratch();
  const trusted = join(dir, "trusted");
  mkdirSync(join(trusted, "scripts", "ci"), { recursive: true });
  copyFileSync(
    join(REPO, "scripts", "ci", "lockstep-packages.mjs"),
    join(trusted, "scripts", "ci", "lockstep-packages.mjs"),
  );
  copyFileSync(
    join(REPO, "scripts", "ci", "package-set-digest.mjs"),
    join(trusted, "scripts", "ci", "package-set-digest.mjs"),
  );
  writeFileSync(
    join(trusted, "package.json"),
    JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.0.0" }),
  );
  mkdirSync(join(trusted, "packages", "client"), { recursive: true });
  writeFileSync(
    join(trusted, "packages", "client", "package.json"),
    JSON.stringify({ name: "@tpsdev-ai/client", version: "0.0.0" }),
  );
  if (fx.lockstep && fx.lockstep !== "ok") {
    // Replace the real derivation so the step's own fail-closed branch is driven
    // without depending on a malformed-manifest fixture.
    const exit = fx.lockstep === "fail" ? 2 : 0;
    writeFileSync(
      join(trusted, "scripts", "ci", "lockstep-packages.mjs"),
      `#!/usr/bin/env node\nif (${exit} !== 0) console.error("DID NOT RUN");\nprocess.exit(${exit});\n`,
    );
  }
  // Stub registry hasher: a deterministic sha per <version> <pkg>, with the
  // failure modes the step must refuse on.
  writeFileSync(
    join(trusted, "scripts", "ci", "registry-tarball-sha256.mjs"),
    `#!/usr/bin/env node
import { createHash } from "node:crypto";
const [version, pkg] = process.argv.slice(2);
if (process.env.STUB_FAIL_PKG && pkg === process.env.STUB_FAIL_PKG) process.exit(3);
process.stdout.write(createHash("sha256").update(version + "\\n" + pkg).digest("hex") + "\\n");
`,
  );

  const ghDir = join(dir, "bin");
  mkdirSync(ghDir, { recursive: true });
  const deploymentsFile = join(dir, "deployments.json");
  writeFileSync(deploymentsFile, JSON.stringify(fx.deployments));
  const ghPath = join(ghDir, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
if [[ "$*" == *deployments* ]]; then cat "$FAKE_DEPLOYMENTS"; exit 0; fi
echo "fake gh: unhandled $*" >&2; exit 1
`,
  );
  chmodSync(ghPath, 0o755);
  const runnerTemp = join(dir, "runner");
  mkdirSync(runnerTemp, { recursive: true });
  const outFile = join(dir, "github-output");
  writeFileSync(outFile, "");

  const script = join(dir, "derive.sh");
  writeFileSync(script, runOf("promote", "derive"));

  const r = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${ghDir}:${process.env.PATH}`,
      GITHUB_REF_NAME: fx.refName,
      GITHUB_REPOSITORY: "octo/repo",
      GITHUB_OUTPUT: outFile,
      RUNNER_TEMP: runnerTemp,
      TRUSTED: trusted,
      GH_TOKEN: "x",
      FAKE_DEPLOYMENTS: deploymentsFile,
      ...(fx.stubFailPkg ? { STUB_FAIL_PKG: fx.stubFailPkg } : {}),
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", log: (r.stdout ?? "") + (r.stderr ?? ""), out: readFileSync(outFile, "utf8") };
}

describe("release-promote — the derive step refuses on every unmeasurable input (behavioural)", () => {
  const sha = (pkg: string) => createHex("1.2.3\n" + pkg);
  function createHex(s: string): string {
    return createHash("sha256").update(s).digest("hex");
  }
  const goodDigest = () =>
    canonicalDigest("1.2.3", {
      "@tpsdev-ai/client": sha("@tpsdev-ai/client"),
      "@tpsdev-ai/flair": sha("@tpsdev-ai/flair"),
    });
  const marker = (psd: string, version = "1.2.3") => [
    { ref: "v1.2.3", payload: { version, package_set_digest: psd } },
  ];

  test("a prerelease ref is refused before anything else", () => {
    const r = runDerive({ refName: "v1.2.3-rc.1", deployments: marker(goodDigest()) });
    expect(r.status).toBe(1);
    expect(r.log).toContain("is not an exact v<major>.<minor>.<patch> release tag");
  });

  test("a missing release-attempt marker is refused", () => {
    const r = runDerive({ refName: "v1.2.3", deployments: [] });
    expect(r.status).toBe(1);
    expect(r.log).toContain("no release-attempt marker for v1.2.3");
  });

  test("a marker whose payload version disagrees with the ref is refused", () => {
    const r = runDerive({ refName: "v1.2.3", deployments: marker(goodDigest(), "9.9.9") });
    expect(r.status).toBe(1);
    expect(r.log).toContain("does not match the ref's");
  });

  test("a non-hex marker digest is refused", () => {
    const r = runDerive({ refName: "v1.2.3", deployments: marker("not-a-digest") });
    expect(r.status).toBe(1);
    expect(r.log).toContain("no valid package_set_digest");
  });

  test("an unmeasurable tarball is refused, never hashed into a match", () => {
    const r = runDerive({
      refName: "v1.2.3",
      deployments: marker("a".repeat(64)),
      stubFailPkg: "@tpsdev-ai/client",
    });
    expect(r.status).toBe(1);
    expect(r.log).toContain("unmeasurable is not a pass");
  });

  test("an empty lockstep list is refused", () => {
    const r = runDerive({ refName: "v1.2.3", deployments: marker(goodDigest()), lockstep: "empty" });
    expect(r.status).toBe(1);
    expect(r.log).toContain("lockstep package list is empty");
  });

  test("a failed lockstep derivation is refused, never read as an empty set", () => {
    const r = runDerive({ refName: "v1.2.3", deployments: marker(goodDigest()), lockstep: "fail" });
    expect(r.status).toBe(1);
    expect(r.log).toContain("lockstep package-list derivation failed");
  });

  test("a digest that is not the certified set is refused", () => {
    const r = runDerive({ refName: "v1.2.3", deployments: marker("b".repeat(64)) });
    expect(r.status).toBe(1);
    expect(r.log).toContain("not the certified set");
  });

  test("the certified set passes and the outputs carry the version and digest", () => {
    const psd = goodDigest();
    const r = runDerive({ refName: "v1.2.3", deployments: marker(psd) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toContain("version=1.2.3");
    expect(r.out).toContain(`certified_digest=${psd}`);
  });
});
