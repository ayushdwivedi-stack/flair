/**
 * federation-retry-queue.ts — the generic-Memory sender's retry bookkeeping.
 *
 * Pure and DB-free, so the backoff and the row transitions are unit-testable.
 * `runFederationSyncOnce` (src/commands/federation.ts) reads and writes the
 * `FederationRetry` table through its local operations endpoint; this module
 * decides what a refusal means for one row.
 *
 * The receiver's response names each refused record and its reason
 * (`refused`). A reason in {@link MEMORY_RETRY_REASONS} may clear on a later
 * offer, so the sender keeps one pending row for that (hub, Memory, record)
 * tuple and offers the record again on a later cycle, independent of its own
 * cursor. Any other reason is final: an existing pending row becomes
 * `refused_terminal` and is never offered again.
 */
import { retryEntryKey } from "./federation-retry-key.js";

/**
 * The retryable SkipReason names a generic Memory record can be refused with.
 * Mirrors the `retryable` entries of SKIP_REASON_CLASS in
 * resources/federation-classify.ts; test/unit/federation-retry-queue.test.ts
 * fails when the two lists differ.
 */
export const MEMORY_RETRY_REASONS: ReadonlySet<string> = new Set([
  "future_timestamp",
  "unknown_originator_key",
  "merge_target_changed",
  "merge_target_busy",
  "merge_error",
  "presence_agent_not_replicated",
]);

/** Every field the FederationRetry schema declares, in schema order. */
export const RETRY_ROW_FIELDS = [
  "id",
  "peerId",
  "table",
  "recordId",
  "state",
  "firstRefusedAt",
  "attempts",
  "episodeId",
  "recordFingerprint",
  "lastReason",
  "lastAttemptSyncId",
  "lastAttemptAt",
  "completedAt",
  "resolution",
  "bound",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Wait before offering a pending row again, by the number of refusals it has
 * collected. The first re-offer is immediate (the lock or change that refused
 * it may already be gone); later ones back off. The last entry repeats.
 */
export const MEMORY_RETRY_BACKOFF_MS = [0, 30_000, 300_000, 1_800_000] as const;

export function retryBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), MEMORY_RETRY_BACKOFF_MS.length) - 1;
  return MEMORY_RETRY_BACKOFF_MS[index];
}

export interface RetryQueueRow {
  id: string;
  peerId: string;
  table: string;
  recordId: string;
  state: string;
  attempts?: number;
  lastReason?: string | null;
  lastAttemptAt?: string | null;
  firstRefusedAt?: string;
  createdAt?: string;
  [field: string]: unknown;
}

/** The pending rows whose backoff has elapsed at `nowMs`. A malformed row is never offered. */
export function dueRetryRows(rows: readonly RetryQueueRow[], nowMs: number, table = "Memory"): RetryQueueRow[] {
  return rows.filter((row) => {
    if (row.state !== "pending" || row.table !== table) return false;
    if (typeof row.peerId !== "string" || typeof row.recordId !== "string") return false;
    try {
      if (retryEntryKey(row.peerId, row.table, row.recordId) !== row.id) return false;
    } catch {
      return false;
    }
    const attempts = typeof row.attempts === "number" && Number.isSafeInteger(row.attempts) && row.attempts > 0 ? row.attempts : 1;
    const last = Date.parse(row.lastAttemptAt ?? "");
    // A pending row with no readable last attempt is due: the alternative is
    // never offering it again.
    if (!Number.isFinite(last)) return true;
    return nowMs >= last + retryBackoffMs(attempts);
  });
}

export interface RefusalRowInput {
  peerId: string;
  recordId: string;
  reason: string;
  nowIso: string;
  existing?: RetryQueueRow | null;
}

/**
 * The row to write for a retryable refusal. A first refusal creates a pending
 * row with `attempts: 1`; a later one keeps `firstRefusedAt` and `createdAt`,
 * increments `attempts` and moves `lastAttemptAt`. `attempts` counts offers,
 * so the sender's own age bound and attempt bound have a number to read.
 */
export function retryRowForRefusal(input: RefusalRowInput): Record<string, unknown> {
  const id = retryEntryKey(input.peerId, "Memory", input.recordId);
  const prior = input.existing ?? null;
  const priorAttempts = prior && typeof prior.attempts === "number" && Number.isSafeInteger(prior.attempts) && prior.attempts > 0
    ? prior.attempts
    : 0;
  const row: Record<string, unknown> = {
    id,
    peerId: input.peerId,
    table: "Memory",
    recordId: input.recordId,
    state: "pending",
    firstRefusedAt: prior?.firstRefusedAt ?? input.nowIso,
    attempts: priorAttempts + 1,
    lastReason: input.reason,
    lastAttemptAt: input.nowIso,
    createdAt: prior?.createdAt ?? input.nowIso,
    updatedAt: input.nowIso,
  };
  return row;
}

/** A pending row's terminal transition, carrying only declared fields. */
export function terminalRetryRow(
  row: RetryQueueRow,
  resolution: string,
  nowIso: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { id: row.id };
  for (const field of RETRY_ROW_FIELDS) {
    const value = row[field];
    if (value !== undefined) out[field] = value;
  }
  out.state = "terminal";
  out.resolution = resolution;
  out.bound = null;
  out.completedAt = nowIso;
  out.updatedAt = nowIso;
  return out;
}
