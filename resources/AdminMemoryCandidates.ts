/**
 * AdminMemoryCandidates.ts — an operator listing of one agent's MemoryCandidate
 * rows, served on the HTTP endpoint restore writes to.
 *
 * GET /AdminMemoryCandidates/{agentId}?limit=N
 *
 * Returns `{ candidates: [{ id }], hasMore }`. Only the id is returned:
 * restore uses the id to delete the row through the same endpoint.
 * `limit` defaults to 200 and is capped at 500; `hasMore` reports whether the
 * agent holds more rows than this response carries.
 *
 * Admin-only: allowRead() is allowAdmin(), so an unauthenticated caller is
 * refused by the `/Admin*` path gate (401) and a verified non-admin agent is
 * refused with Harper's AccessViolation (403). The handler is read-only.
 */
import { Resource, databases } from "harper";
import { allowAdmin } from "./agent-auth.js";

export const ADMIN_MEMORY_CANDIDATES_DEFAULT_LIMIT = 200;
export const ADMIN_MEMORY_CANDIDATES_MAX_LIMIT = 500;

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function badRequest(error: string): Response {
  return new Response(JSON.stringify({ error }), { status: 400, headers: JSON_HEADERS });
}

function requestUrl(self: any): URL | null {
  const ctx = self.getContext?.();
  const request = ctx?.request ?? ctx;
  if (!request?.url) return null;
  try {
    return new URL(request.url, "http://localhost");
  } catch {
    return null;
  }
}

function pathAgentId(pathInfo: any, resource: { getId?: () => string }): string | null {
  const fromPath =
    typeof pathInfo === "object" && pathInfo !== null
      ? (pathInfo as any).id
      : typeof pathInfo === "string"
        ? pathInfo
        : null;
  const id = fromPath ?? resource.getId?.() ?? null;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export class AdminMemoryCandidates extends Resource {
  async allowRead(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async get(pathInfo?: any) {
    const agentId = pathAgentId(pathInfo, this as any);
    if (!agentId) {
      return badRequest("agentId required in path: GET /AdminMemoryCandidates/{agentId}");
    }

    const rawLimit = requestUrl(this)?.searchParams.get("limit") ?? null;
    const parsedLimit = rawLimit === null ? ADMIN_MEMORY_CANDIDATES_DEFAULT_LIMIT : Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      return badRequest(`limit must be a positive integer, at most ${ADMIN_MEMORY_CANDIDATES_MAX_LIMIT}`);
    }
    const limit = Math.min(parsedLimit, ADMIN_MEMORY_CANDIDATES_MAX_LIMIT);

    const candidates: Array<{ id: string }> = [];
    let hasMore = false;
    try {
      for await (const row of (databases as any).flair.MemoryCandidate.search({
        conditions: [{ attribute: "agentId", comparator: "equals", value: agentId }],
        limit: limit + 1,
      })) {
        if (typeof row?.id !== "string" || row.id.length === 0) continue;
        if (candidates.length === limit) {
          hasMore = true;
          break;
        }
        candidates.push({ id: row.id });
      }
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: "memory_candidate_query_failed", message: err?.message ?? String(err) }),
        { status: 500, headers: JSON_HEADERS },
      );
    }

    return new Response(JSON.stringify({ candidates, hasMore }), { status: 200, headers: JSON_HEADERS });
  }
}
