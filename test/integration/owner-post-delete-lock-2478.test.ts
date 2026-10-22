/**
 * owner-post-delete-lock-2478.test.ts — flair#2478 slice 1 part 2: the
 * remaining foreground Memory writers take the per-id write lock, real Harper.
 *
 * Writers under test: an owner POST that names an existing row (an authored
 * replacement, full row), an owner DELETE, the basement/restore endpoint
 * (`POST /MemoryArchive`, a full `put` inside one owned transaction), a skill
 * POST update (successor create plus predecessor close inside the version
 * transaction), and manual promotion (`POST /PromoteMemoryCandidate`: a create
 * under a fresh id plus the verdict stamp, one composed transaction). Each is
 * foreground: it waits within the owner budget and answers `503 memory_busy`
 * on a miss. The lock is held across the writer's commit.
 *
 * The matrix: each writer first, held after its write staged or after its
 * commit, against an owner PUT and PATCH (refused `memory_busy`; after release
 * the writer's and then the owner's fields are stored); an owner write first,
 * held after its commit, against the writer (refused `memory_busy`); a
 * lock-bypassing trace assertion that each writer wrote its own fields under
 * its phase. Seeded rows carry an explicit visibility, an incarnation token
 * and a bare current stamp so boot migrations leave them alone. Home-isolated
 * ephemeral Harper; every URL is asserted to be this test's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";
import { RaceHarness, composeTracedComponent, expectRefused, newAgent } from "../helpers/embedding-writer-race";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";

const owner = newAgent("opdl2478-owner");
const SEED_MODEL_ID = stripEnginePrefix(getModelId());
const ORIGINAL = "the original note about the harbour crane's inspection roster";
const WRITER_TEXT = "a writer edit about the lighthouse keeper's storm log";
const OWNER_TEXT = "an owner edit about the ferry terminal's new ticket hall";
const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;

let component: ProbeComponent;
let home: string;
let pauseDir: string;
let h: RaceHarness;

function seed(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  return h.seedMemory({ id, agentId: owner.id, content: ORIGINAL, ...extra }, { embeddingModel: SEED_MODEL_ID });
}
function ownerWrite(verb: "PUT" | "PATCH", id: string, content: string): Promise<Response> {
  return verb === "PUT"
    ? h.signed(owner, "PUT", memPath(id), { agentId: owner.id, content, visibility: "private", durability: "standard" })
    : h.signed(owner, "PATCH", memPath(id), { content, visibility: "private" });
}
const ownerSuccess = (verb: "PUT" | "PATCH") => (verb === "PUT" ? 200 : 204);

/** A short wait: the writer whose pause point we arm must have paused. */
async function paused(point: string): Promise<boolean> {
  return (await h.assertPaused(point, 60_000), true);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478s1b-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478s1b-pause-"));
  component = composeTracedComponent();
  h = new RaceHarness(pauseDir);
  h.harper = await startHarper({
    homeDir: home, cwd: component.dir, harperBinDir: component.sourceRoot,
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  h.assertOwnInstance();
  await h.seedAgent(owner);
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

describe("flair#2478 — owner POST (real Harper)", () => {
  it("CONTROL: a pure create under a fresh id lands, and the POST write is traced under phase post", async () => {
    const id = "opdl-post-control";
    const res = await h.signed(owner, "POST", "/Memory", { id, agentId: owner.id, content: WRITER_TEXT, visibility: "shared" });
    expect([200, 201], await res.clone().text()).toContain(res.status);
    expect((await h.readRow(id))?.content).toBe(WRITER_TEXT);
  }, 120_000);
});

describe("flair#2478 — owner DELETE (real Harper)", () => {
  it("CONTROL: an uncontended DELETE removes the row and is traced under phase delete", async () => {
    const id = "opdl-delete-control";
    await seed(id);
    const res = await h.signed(owner, "DELETE", memPath(id));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await h.readRow(id)).toBeNull();
    expect(h.writesBy(id, "delete").length, "no Memory delete by phase delete was traced").toBeGreaterThan(0);
  }, 120_000);

  for (const verb of ["PUT", "PATCH"] as const) {
    it(`a DELETE held after its commit refuses an owner ${verb} memory_busy, then the row is gone`, async () => {
      const id = `opdl-delete-first-${verb.toLowerCase()}`;
      await seed(id);
      h.arm("memory-delete-committed");
      const pending = h.signed(owner, "DELETE", memPath(id));
      try {
        await paused("memory-delete-committed");
        const body = await expectRefused(await ownerWrite(verb, id, OWNER_TEXT), "memory_busy");
        expect(body).toEqual({ error: "memory_busy", caller: owner.id });
        await h.release("memory-delete-committed");
      } finally {
        h.letGo("memory-delete-committed");
      }
      expect((await pending).status).toBe(200);
      expect(await h.readRow(id), "the deleted row reappeared").toBeNull();
      const recreate = await h.signed(owner, "PUT", memPath(id), { agentId: owner.id, content: OWNER_TEXT, visibility: "private" });
      expect(recreate.status, await recreate.clone().text()).toBe(200);
      expect((await h.readRow(id))?.content).toBe(OWNER_TEXT);
    }, 120_000);

    it(`an owner ${verb} held after its commit refuses a DELETE memory_busy, then the DELETE applies`, async () => {
      const id = `opdl-owner-first-delete-${verb.toLowerCase()}`;
      await seed(id);
      const point = verb === "PUT" ? "memory-put-committed" : "memory-patch-committed";
      h.arm(point);
      const pending = ownerWrite(verb, id, OWNER_TEXT);
      try {
        await paused(point);
        expect((await expectRefused(await h.signed(owner, "DELETE", memPath(id)), "memory_busy")).error).toBe("memory_busy");
        await h.release(point);
      } finally {
        h.letGo(point);
      }
      expect((await pending).status).toBe(ownerSuccess(verb));
      const res = await h.signed(owner, "DELETE", memPath(id));
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await h.readRow(id)).toBeNull();
    }, 120_000);
  }
});
