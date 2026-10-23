/**
 * federation-retry-key.ts — the tuple key of one federation retry row.
 *
 * Pure and DB-free: the receiver resource (resources/FederationRetry.ts), its
 * shared vocabulary (resources/federation-retry-lib.ts) and the sender
 * (src/commands/federation.ts) all encode the same key, so it lives here where
 * both build graphs can reach it.
 */

/**
 * Encode the (peerId, table, recordId) tuple as the row's primary key.
 *
 * A JSON array join, never a bare concatenation: a naive `${peerId}${table}
 * ${recordId}` collides (peer `a` + table `bc` is peer `ab` + table `c`), and
 * peer and record ids are arbitrary strings off the wire, including legacy
 * `.content`-suffixed ids. JSON quotes and escapes each component, so distinct
 * tuples encode to distinct strings and the components round-trip exactly.
 *
 * Every component must be a non-empty string; a missing component is a caller
 * bug, not a row to write, so this THROWS rather than mint a malformed key.
 */
export function retryEntryKey(peerId: string, table: string, recordId: string): string {
  for (const [name, value] of [
    ["peerId", peerId],
    ["table", table],
    ["recordId", recordId],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`federation retry: ${name} must be a non-empty string`);
    }
  }
  return JSON.stringify([peerId, table, recordId]);
}

/** Decode {@link retryEntryKey}'s output, or null when `id` is not a retry key. */
export function parseRetryEntryKey(id: string): { peerId: string; table: string; recordId: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(id);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [peerId, table, recordId] = parsed;
  if (typeof peerId !== "string" || typeof table !== "string" || typeof recordId !== "string") return null;
  if (peerId.length === 0 || table.length === 0 || recordId.length === 0) return null;
  return { peerId, table, recordId };
}
