// check-cli-spawn-budgets-jsx-2808.test.ts — JSX text is masked before the gate
// matches spawns and reads deadlines (flair#2808). Each fixture is written to a
// real `test/` tree and scanned through `scanTree`, so the gate sees the same
// file name (and therefore the same TypeScript script kind) as a test file.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { findSpawnCalls, scanTree } from "../../scripts/ci/check-cli-spawn-budgets.mjs";

let dirs: string[] = [];

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

/** The fixture parses with the script kind its file name selects. */
function expectParses(source: string, fileName: string): void {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  expect((sf as any).parseDiagnostics.length).toBe(0);
}

/** Write one fixture under a fresh tree's `test/` and scan the tree. */
function scanFixture(fileName: string, source: string) {
  expectParses(source, fileName);
  const dir = mkdtempSync(join(tmpdir(), "spawn-jsx-2808-"));
  dirs.push(dir);
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test", fileName), source, "utf8");
  return scanTree(dir);
}

// JSX text with an apostrophe, a brace expression and a `timeout: 5000` string;
// the options object holds the same prose, so an unmasked apostrophe breaks the
// spawn's own argument walk.
const TSX_OPTIONS = `import { test, expect } from "bun:test";

test("jsx in options", () => {
  const label = <span title="it's a 'label' - timeout: 5000">It's {value} timeout: 5000</span>;
  const p = Bun.spawn(["bun", "src/cli.ts", "status"], {
    env: { LABEL: <span>it's {value} timeout: 5000</span> },
  });
  expect(label).toBeDefined();
});
`;

// The same prose in the case body, before the spawn; an unmasked apostrophe runs
// the case's bracket walk past its closing paren.
const JSX_CASE = `import { test, expect } from "bun:test";

test("jsx in case", () => {
  const el = <p title="it's a 'label' - timeout: 5000">It's {value} timeout: 5000</p>;
  const p = Bun.spawn(["bun", "src/cli.ts"], {});
  expect(el).toBeDefined();
});
`;

// A bounded spawn whose options hold the same JSX prose: the deadline is still
// read from the inline literal.
const TSX_BOUNDED = `import { test, expect } from "bun:test";

test("bounded beside jsx", () => {
  const p = Bun.spawn(["bun", "src/cli.ts"], {
    timeout: 5000,
    env: { LABEL: <span title="it's a 'label' - timeout: 5000">It's {value} timeout: 5000</span> },
  });
  expect(p).toBeDefined();
}, 30_000);
`;

describe("JSX text is masked before matching (flair#2808)", () => {
  it("an unbounded spawn whose options contain JSX text is reported", () => {
    const { spawnOffenders, caseOffenders } = scanFixture("jsx-options.test.tsx", TSX_OPTIONS);
    expect(spawnOffenders.map((o: any) => o.kind)).toEqual(["spawn-no-timeout"]);
    expect(caseOffenders.map((o: any) => o.kind)).toEqual(["case-no-budget"]);
  });

  it("an unbounded spawn whose case contains JSX text is reported", () => {
    const { spawnOffenders, caseOffenders } = scanFixture("jsx-case.test.jsx", JSX_CASE);
    expect(spawnOffenders.map((o: any) => o.kind)).toEqual(["spawn-no-timeout"]);
    expect(caseOffenders.map((o: any) => o.kind)).toEqual(["case-no-budget"]);
  });

  it("a bounded inline-literal spawn with JSX text in its options still reads its deadline", () => {
    const { spawnOffenders } = scanFixture("jsx-bounded.test.tsx", TSX_BOUNDED);
    expect(spawnOffenders).toEqual([]);
    const calls = findSpawnCalls(TSX_BOUNDED, "jsx-bounded.test.tsx").calls;
    expect(calls.length).toBe(1);
    expect(calls[0].timeoutMs).toBe(5000);
  });
});
