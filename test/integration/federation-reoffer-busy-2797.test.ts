/**
 * federation-reoffer-busy-2797.test.ts — flair#2797 (real Harper, two instances).
 *
 * A generic Memory row the receiver refused `merge_target_busy` (its id's write
 * lock was held) is kept in the sender's FederationRetry table and offered
 * again on a later cycle, even though the sender's cursor has already advanced
 * past the row's own `updatedAt`. A non-retryable refusal is never re-offered.
 *
 * The receiver holds the id's lock through the merge's existing pause point
 * (`federation-merge`): a second signed push from the same peer pauses there,
 * the sender syncs and is refused, the receiver's row is deleted, and the
 * paused merge then finds it gone (writes nothing). The retry row is the only
 * reason the next sync offers the row again.
 *
 * Two real, ephemeral, loopback, HOME-isolated Harpers. Fixtures are neutral
 * (`agent-a`, `flair_spoke_a`, `flair_hub_a`).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { keystore } from "../../src/keystore";
import { retryEntryKey } from "../../src/lib/federation-retry-key";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const SENDER_ID = "flair_spoke_a";
const HUB_ID = "flair_hub_a";
const AGENT = "agent-a";
const PEER = SENDER_ID;

const senderSeed = new Uint8Array(randomBytes(32));
const senderKp = nacl.sign.keyPair.fromSeed(senderSeed);
const hubKp = nacl.sign.keyPair();
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

let sender: HarperInstance;
let receiver: HarperInstance;
let pauseDir: string;

function assertOwnInstance(h: HarperInstance, what: string): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], `${what} ${url} must be loopback`).toContain(u.hostname);
    expect(["9925", "9926"], `${what} ${url} must avoid ports 9925/9926`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

const basic = (h: HarperInstance) => "Basic " + Buffer.from(`${h.admin.username}:${h.admin.password}`).toString("base64");

async function ops(h: HarperInstance, operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic(h) },
    body: JSON.stringify({ database: "flair", ...operation }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation} on ${h.httpURL}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

const insertRow = (h: HarperInstance, table: string, row: Record<string, unknown>) =>
  ops(h, { operation: "insert", table, records: [row] });

async function readRow(h: HarperInstance, table: string, id: string): Promise<any> {
  const rows = await ops(h, { operation: "search_by_hash", table, hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

async function deleteRow(h: HarperInstance, table: string, id: string): Promise<void> {
  await ops(h, { operation: "delete", table, hash_values: [id] });
}

async function sync(): Promise<{ pushed: number; skipped: number; error?: Error }> {
  const { runFederationSyncOnce } = await import("../../src/cli");
  return runFederationSyncOnce({
    target: sender.httpURL,
    opsTarget: sender.opsURL,
    adminUser: sender.admin.username,
    adminPass: sender.admin.password,
  });
}

/** One signed push of one Memory row, as the spoke. */
function push(memory: Record<string, unknown>): Promise<Response> {
  const body = signBodyFresh(
    {
      instanceId: PEER,
      records: [{
        originatorInstanceId: PEER,
        table: "Memory",
        id: memory.id,
        updatedAt: memory.updatedAt,
        data: memory,
      }],
      lamportClock: Date.now(),
    },
    senderKp.secretKey,
  );
  return fetch(`${receiver.httpURL}/FederationSync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function memoryRow(id: string, content: string, updatedAt: string): Record<string, unknown> {
  return {
    id,
    agentId: AGENT,
    content,
    contentHash: `hash-${content}`,
    durability: "standard",
    visibility: "shared",
    archived: false,
    // The sender signs v2 records and includes principalId only for a row that
    // carries a verified provenance stamp; the receiver requires the two to
    // agree on a Memory row.
    provenance: JSON.stringify({ verified: { agentId: AGENT } }),
    createdAt: updatedAt,
    updatedAt,
  };
}

const retryKey = (id: string) => retryEntryKey(HUB_ID, "Memory", id);


beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2797-pause-"));
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  keystore.setPrivateKeySeed(SENDER_ID, senderSeed);

  receiver = await startHarper({
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  sender = await startHarper({
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  assertOwnInstance(receiver, "receiver");
  assertOwnInstance(sender, "sender");

  const now = new Date().toISOString();
  await insertRow(receiver, "Instance", { id: HUB_ID, publicKey: b64url(hubKp.publicKey), role: "hub", createdAt: now });
  await insertRow(receiver, "Peer", { id: SENDER_ID, publicKey: b64url(senderKp.publicKey), role: "spoke", status: "paired", createdAt: now });
  await insertRow(sender, "Instance", { id: SENDER_ID, publicKey: b64url(senderKp.publicKey), role: "spoke", createdAt: now });
  await insertRow(sender, "Peer", { id: HUB_ID, publicKey: b64url(hubKp.publicKey), role: "hub", status: "paired", endpoint: receiver.httpURL, createdAt: now });
}, 480_000);

afterAll(async () => {
  if (sender) await stopHarper(sender);
  if (receiver) await stopHarper(receiver);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS * 2 + 60_000);

describe("flair#2797 — a merge_target_busy refusal is re-offered after the lock clears", () => {
  it("re-offers the refused row on the next sync, past the sender's cursor", async () => {
    const id = "memory-reoffer-a";
    const updatedAt = new Date(Date.now() - 120_000).toISOString();
    const fromSpoke = memoryRow(id, "from-spoke", updatedAt);
    await insertRow(sender, "Memory", fromSpoke);
    await insertRow(receiver, "Memory", memoryRow(id, "on-hub", new Date(Date.now() - 180_000).toISOString()));

    // Hold the id's lock through the merge's own pause point with a second
    // signed push, then sync the sender: its offer is refused merge_target_busy.
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.federation-merge`), { force: true });
    writeFileSync(join(pauseDir, "arm.federation-merge"), "");
    const holder = push(memoryRow(id, "holder", new Date(Date.now() - 60_000).toISOString()));
    expect(await waitFor(join(pauseDir, "paused.federation-merge"), 120_000), "the merge never paused").toBe(true);

    const first = await sync();
    expect(first.error, String(first.error)).toBeUndefined();
    expect(first.skipped, JSON.stringify(first)).toBe(1);

    // The cursor advanced past the row's own updatedAt after the refusal; the
    // refusal is not lost because the sender recorded it.
    const hubPeer = await readRow(sender, "Peer", HUB_ID);
    expect(Date.parse(hubPeer.lastSyncAt), "the cursor did not advance past the row").toBeGreaterThan(Date.parse(updatedAt));
    const pending = await readRow(sender, "FederationRetry", retryKey(id));
    expect(pending, "the retryable refusal was not recorded").not.toBeNull();
    expect(pending.state).toBe("pending");
    expect(pending.lastReason).toBe("merge_target_busy");

    // The holder's merge finds its row deleted and writes nothing.
    await deleteRow(receiver, "Memory", id);
    writeFileSync(join(pauseDir, "go.federation-merge"), "");
    const holderBody = await (await holder).json() as any;
    expect(holderBody.skippedReasons?.merge_target_changed ?? 0, JSON.stringify(holderBody)).toBe(1);

    // Sync #2: only the retry row selects the row (its updatedAt is behind the
    // cursor). It lands and the obligation becomes terminal.
    const second = await sync();
    expect(second.error, String(second.error)).toBeUndefined();
    expect(second.pushed, `the retry row was not re-offered: ${JSON.stringify(second)}`).toBe(1);
    const landed = await readRow(receiver, "Memory", id);
    expect(landed).not.toBeNull();
    expect(landed.content).toBe("from-spoke");
    const done = await readRow(sender, "FederationRetry", retryKey(id));
    expect(done.state).toBe("terminal");
    expect(done.resolution).toBe("merged");
  }, 420_000);

  it("a non-retryable refusal is not recorded and is not re-offered", async () => {
    const id = `memory.${randomBytes(3).toString("hex")}.content`;
    // These cases share one sender; a row written now is past its cursor.
    const updatedAt = new Date().toISOString();
    await insertRow(sender, "Memory", memoryRow(id, "not-federated", updatedAt));

    const first = await sync();
    expect(first.error, String(first.error)).toBeUndefined();
    expect(first.skipped, JSON.stringify(first)).toBe(1);
    expect(await readRow(sender, "FederationRetry", retryKey(id)), "a non-retryable refusal was recorded").toBeNull();

    const second = await sync();
    expect(second.error, String(second.error)).toBeUndefined();
    expect(second.pushed, `the refused row was re-offered: ${JSON.stringify(second)}`).toBe(0);
    expect(await readRow(receiver, "Memory", id)).toBeNull();
  }, 240_000);

  it("the busy skip writes a SyncLog row naming its skippedReasons", async () => {
    const id = "memory-synclog-a";
    const updatedAt = new Date().toISOString();
    await insertRow(sender, "Memory", memoryRow(id, "logged", updatedAt));

    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.federation-merge`), { force: true });
    writeFileSync(join(pauseDir, "arm.federation-merge"), "");
    const holder = push(memoryRow(id, "holder-log", new Date(Date.now() - 60_000).toISOString()));
    expect(await waitFor(join(pauseDir, "paused.federation-merge"), 120_000), "the merge never paused").toBe(true);
    const result = await sync();
    expect(result.error, String(result.error)).toBeUndefined();
    expect(result.skipped, JSON.stringify(result)).toBe(1);
    writeFileSync(join(pauseDir, "go.federation-merge"), "");
    await holder;

    const rows = await ops(receiver, { operation: "sql", sql: "SELECT * FROM flair.SyncLog" });
    const list = Array.isArray(rows) ? rows : (rows?.results ?? []);
    const forPeer = (list as any[]).filter((r) => r.peerId === SENDER_ID);
    expect(forPeer.length).toBeGreaterThan(0);
    const busy = forPeer
      .map((row) => ({ row, reasons: JSON.parse(row.skippedReasons) }))
      .find((entry) => entry.reasons.merge_target_busy === 1);
    expect(busy, "no SyncLog row names the busy skip").toBeDefined();
    expect(busy!.row.skippedCount, JSON.stringify(busy!.row)).toBe(1);
    expect(busy!.row.status, JSON.stringify(busy!.row)).toBe("partial");
  }, 300_000);

  it("a failed SyncLog write is reported in the response, not only logged", async () => {
    const id = "memory-synclog-unwritten";
    const updatedAt = new Date(Date.now() - 20_000).toISOString();
    const row = memoryRow(id, "unlogged", updatedAt);

    writeFileSync(join(pauseDir, "fail.federation-synclog"), "");
    const failed = await push(row);
    expect(failed.status).toBe(200);
    const failedBody = await failed.json() as any;
    expect(failedBody.merged, JSON.stringify(failedBody)).toBe(1);
    expect(failedBody.syncLogWritten, JSON.stringify(failedBody)).toBe(false);

    const retryId = "memory-synclog-written";
    const written = await push(memoryRow(retryId, "logged", updatedAt));
    expect(written.status).toBe(200);
    const writtenBody = await written.json() as any;
    expect(writtenBody.merged, JSON.stringify(writtenBody)).toBe(1);
    expect(writtenBody.syncLogWritten, JSON.stringify(writtenBody)).toBe(true);
  }, 120_000);
});
