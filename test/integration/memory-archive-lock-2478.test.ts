/**
 * memory-archive-lock-2478.test.ts — flair#2478 part 3a, real Harper: the
 * archive (POST /MemoryArchive, basement and restore) writes through the
 * checked PUT under the per-id lock it holds, and the checked write refuses a
 * token that is not live for its store and ids.
 *
 * Cases:
 *  - basement and restore controls: the write is one Memory `put` traced under
 *    the archive's lock phase, with its archive fields; the vector is kept and
 *    no pointer field is written;
 *  - each action held at `memory-locked-staged` (staged, before the commit) and
 *    at `memory-locked-committed` (committed, before the confirmation), against
 *    an owner PUT and PATCH: the owner write is refused `503 memory_busy`, and
 *    the archive's fields are stored and confirmed;
 *  - through the built app (a test-only probe resource,
 *    test/fixtures/checked-write-probe-2478/probe.js): a checked write on a
 *    live token succeeds; one with a revoked token, one naming an id the token
 *    does not hold, and one with a token from a second copy of the lock module
 *    (another registry) are refused, and nothing is written.
 *
 * Seeded rows carry an explicit visibility, an incarnation token and a current
 * stamp, so boot migrations leave them alone. Home-isolated ephemeral Harper;
 * every URL is asserted to be this test's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";
import { RaceHarness, composeTracedComponent, expectRefused, newAgent } from "../helpers/embedding-writer-race";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";

const owner = newAgent("mal2478-owner");
const SEED_MODEL_ID = stripEnginePrefix(getModelId());
const ORIGINAL = "the original note about the harbour crane's inspection roster";
const OWNER_TEXT = "an owner edit about the ferry terminal's new ticket hall";
const PROBE_TEXT = "a probe edit about the lighthouse keeper's storm log";
const ARCHIVED_AT = "2026-01-02T03:04:05.000Z";
const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;
const POINTER_FIELDS = ["hostSource", "hostSourceScope", "hostSourceVisibility"];

let component: ProbeComponent;
let home: string;
let pauseDir: string;
let h: RaceHarness;
let vector: number[];

type Action = "basement" | "restore";

function seed(id: string, action: Action): Promise<void> {
  const archived = action === "restore" ? { archived: true, archivedAt: ARCHIVED_AT, archivedBy: owner.id } : { archived: false };
  return h.seedMemory({ id, agentId: owner.id, content: ORIGINAL, embedding: vector, ...archived }, { embeddingModel: SEED_MODEL_ID });
}
function archive(id: string, action: Action): Promise<Response> {
  return h.signed(owner, "POST", "/MemoryArchive", { id, action });
}
function ownerWrite(verb: "PUT" | "PATCH", id: string): Promise<Response> {
  return verb === "PUT"
    ? h.signed(owner, "PUT", memPath(id), { agentId: owner.id, content: OWNER_TEXT, visibility: "shared", durability: "standard" })
    : h.signed(owner, "PATCH", memPath(id), { content: OWNER_TEXT });
}
function probe(body: Record<string, unknown>): Promise<any> {
  return h.admin("POST", "/CheckedWriteProbe2478", body).then(async (res) => {
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    return JSON.parse(text);
  });
}

/** The archive answered 200 with the PUT's own answer, and the row holds the action's archive fields. */
async function expectArchived(res: Response, id: string, action: Action): Promise<any> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  expect(JSON.parse(text)).toEqual({ id, written: true, deduplicated: false, visibility: "shared" });
  const row = await h.readRow(id);
  expect(row?.content, "the archive's row lost its content").toBe(ORIGINAL);
  if (action === "basement") {
    expect(row.archived).toBe(true);
    expect(row.archivedBy).toBe(owner.id);
    expect(typeof row.archivedAt).toBe("string");
  } else {
    expect(row.archived).toBe(false);
    expect(row.archivedAt ?? null).toBeNull();
    expect(row.archivedBy ?? null).toBeNull();
  }
  return row;
}

/** The traced Memory writes of `id` made under a lock are one `put` by the
 *  archive's lock phase. (An owner HTTP PUT is also traced, as `unattributed`,
 *  where Harper dispatches it, before the verb takes the lock.) */
function expectArchiveWrite(id: string, action: Action): string[] {
  const writes = h.trace(id).filter((w) => w.writer !== "unattributed");
  expect(writes.map((w) => `${w.writer}:${w.method}`)).toEqual([`archive-${action}:put`]);
  return writes[0].fields;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478s1c-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478s1c-pause-"));
  component = composeTracedComponent();
  const resources = join(component.dir, "dist", "resources");
  copyFileSync(join(import.meta.dir, "..", "fixtures", "checked-write-probe-2478", "probe.js"), join(resources, "zz-checked-write-probe-2478.js"));
  copyFileSync(join(resources, "memory-write-lock.js"), join(resources, "zz-memory-write-lock-copy-2478.js"));
  h = new RaceHarness(pauseDir);
  h.harper = await startHarper({
    homeDir: home, cwd: component.dir, harperBinDir: component.sourceRoot,
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  h.assertOwnInstance();
  await h.seedAgent(owner);
  vector = await h.serverEmbedding(ORIGINAL);
}, 240_000);

afterAll(async () => {
  if (h?.harper) {
    const installDir = h.harper.installDir;
    await stopHarper(h.harper).catch(() => {});
    rmSync(installDir, { recursive: true, force: true, maxRetries: 4 });
  }
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  component?.cleanup();
}, HARPER_STOP_BUDGET_MS);

describe("flair#2478 part 3a — the archive writes under its held lock (real Harper)", () => {
  for (const action of ["basement", "restore"] as const) {
    it(`CONTROL ${action}: one checked put of the archive fields under phase archive-${action}; vector kept, no pointer field`, async () => {
      const id = `mal-control-${action}`;
      await seed(id, action);
      const row = await expectArchived(await archive(id, action), id, action);
      expect(row.embedding, "the archive changed the stored vector").toEqual(vector);
      const fields = expectArchiveWrite(id, action);
      expect(fields).toContain("archived");
      expect(fields).toContain("embedding");
      for (const field of ["archivedAt", "archivedBy"]) {
        if (action === "basement") expect(fields).toContain(field);
        else expect(fields).not.toContain(field);
      }
      for (const field of POINTER_FIELDS) expect(fields).not.toContain(field);
      // The lock is released: the owner writes again.
      expect((await ownerWrite("PATCH", id)).status).toBe(204);
    }, 120_000);

    for (const point of ["memory-locked-staged", "memory-locked-committed"]) {
      for (const verb of ["PUT", "PATCH"] as const) {
        it(`${action} held at ${point} refuses an owner ${verb} memory_busy; the archive's fields are stored and confirmed`, async () => {
          const id = `mal-${action}-${point}-${verb.toLowerCase()}`;
          await seed(id, action);
          h.arm(point);
          const pending = archive(id, action);
          try {
            await h.assertPaused(point);
            const body = await expectRefused(await ownerWrite(verb, id), "memory_busy");
            expect(body).toEqual({ error: "memory_busy", caller: owner.id });
            await h.release(point);
          } finally {
            h.letGo(point);
          }
          await expectArchived(await pending, id, action);
          expectArchiveWrite(id, action);
        }, 120_000);
      }
    }
  }
});

describe("flair#2478 part 3a — checked writes through the built app (real Harper)", () => {
  it("CONTROL: a checked put on a live token for its id commits and is confirmed", async () => {
    const id = "mal-probe-control";
    await seed(id, "basement");
    const result = await probe({ op: "control", id, text: PROBE_TEXT });
    expect(result.lock).toBe("done");
    expect(result.scope).toBe("committed");
    expect(result.confirmed).toEqual([{ id, written: true, deduplicated: false, visibility: "shared" }]);
    expect((await h.readRow(id))?.content).toBe(PROBE_TEXT);
    expect(h.writesBy(id, "checked-write-probe").map((w) => w.method)).toEqual(["put"]);
  }, 120_000);

  it("a revoked token (its acquisition settled) is refused and nothing is written", async () => {
    const id = "mal-probe-revoked";
    await seed(id, "basement");
    expect(await probe({ op: "revoked", id, text: PROBE_TEXT })).toEqual({ refused: "revoked" });
    expect((await h.readRow(id))?.content).toBe(ORIGINAL);
    expect(h.trace(id)).toEqual([]);
  }, 120_000);

  it("a token for another id is refused, the scope aborts, and neither row is written", async () => {
    const id = "mal-probe-held";
    const otherId = "mal-probe-other";
    await seed(id, "basement");
    await seed(otherId, "basement");
    expect(await probe({ op: "wrong-id", id, otherId, text: PROBE_TEXT })).toEqual({
      write: { refused: "id_not_covered" },
      scope: { refused: "id_not_covered" },
    });
    expect((await h.readRow(otherId))?.content).toBe(ORIGINAL);
    expect(h.trace(otherId)).toEqual([]);
    expect(h.trace(id)).toEqual([]);
  }, 120_000);

  it("a token from a second copy of the lock module (another registry) is refused", async () => {
    const id = "mal-probe-foreign";
    await seed(id, "basement");
    expect(await probe({ op: "foreign-registry", id, text: PROBE_TEXT })).toEqual({
      scope: { refused: "not_a_token" },
      write: { refused: "not_a_token" },
    });
    expect((await h.readRow(id))?.content).toBe(ORIGINAL);
    expect(h.trace(id)).toEqual([]);
  }, 120_000);
});
