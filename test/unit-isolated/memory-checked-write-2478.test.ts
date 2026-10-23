// flair#2478 part 3a — the checked Memory writes (resources/Memory.ts
// putMemoryWithLock / patchMemoryWithLock) against the shared Memory harness:
// they stage inside a locked transaction scope and are answered after its
// commit and confirmation; without a live token for the store and every id
// they write, they are refused and nothing is written; and the public PUT/PATCH
// acquire the lock whatever they are handed. The real-Harper cases are in
// test/integration/memory-archive-lock-2478.test.ts.
import { beforeEach, describe, expect, it } from "bun:test";
import { databasesMock, harnessState, installMemoryHarperMock, resetHarnessState } from "../helpers/memory-search-harness";
import { memoryLockDouble } from "../helpers/memory-lock-double";

const { Memory } = await installMemoryHarperMock();
const { patchMemoryWithLock, putMemoryWithLock } = await import("../../resources/Memory.ts");
const { MemoryWriteCapabilityError, withMemoryWriteLock } = await import("../../resources/memory-write-lock.ts");
const { lockedTransactionContext, withLockedMemoryTransaction } = await import("../../resources/memory-write-transaction.ts");

const store = (databasesMock.flair as any).Memory.primaryStore;
const ctx = () => ({ request: { tpsAgent: "agent-a", tpsAgentIsAdmin: true } });
const ROW = { id: "m1", agentId: "agent-a", content: "the original note", createdAt: "2026-01-01T00:00:00.000Z", visibility: "shared", durability: "standard", archived: false, instanceToken: "token-m1" };

type Verb = "put" | "patch";
const checked = { put: putMemoryWithLock, patch: patchMemoryWithLock };
// The harness's table patch writes the body's own id (real Harper's writes the bound id).
const body = (verb: Verb, text: string) => (verb === "put" ? { ...ROW, content: text } : { id: "m1", content: text });

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "none";
  } catch (err) {
    if (err instanceof MemoryWriteCapabilityError) return err.reason;
    throw err;
  }
}

beforeEach(() => {
  resetHarnessState();
  harnessState.memoryStore.set("m1", { ...ROW });
  harnessState.memoryStore.set("m2", { ...ROW, id: "m2", instanceToken: "token-m2" });
});

describe("checked Memory writes under a held lock (flair#2478 part 3a)", () => {
  for (const verb of ["put", "patch"] as const) {
    it(`${verb}: returns staged inside the scope; committed and confirmed after it`, async () => {
      const outcome = await withMemoryWriteLock(store, ["m1"], (held) =>
        withLockedMemoryTransaction(held, ctx(), async (tx) => {
          const receipt = await checked[verb](held, tx, { id: "m1", content: body(verb, "the checked edit") });
          expect(receipt).toEqual({ status: "staged", id: "m1" });
          // The harness stages a table put in the mock transaction (its patch writes through).
          if (verb === "put") expect(harnessState.memoryStore.get("m1").content).toBe(ROW.content);
          return receipt;
        }));
      expect(outcome.kind).toBe("done");
      const written = (outcome as any).value;
      expect(written.kind).toBe("committed");
      expect(written.confirmed).toHaveLength(1);
      if (verb === "put") expect(written.confirmed[0]).toMatchObject({ id: "m1", written: true });
      expect(harnessState.memoryStore.get("m1").content).toBe("the checked edit");
      expect(harnessState.memoryStore.get("m1").instanceToken).toBe("token-m1");
    });

    // After the staged write, every read of the row returns `committed` with
    // `change` applied: the confirmation's read included.
    for (const [label, change, confirmFields] of [
      ["a field the write did not stage, stored with a value", { archivedBy: "agent-z" }, ["archivedBy"]],
      ["a field the write did not stage, stored as null", { archivedBy: null }, ["archivedBy"]],
      ["another row id, with no confirmFields", { id: "m-other" }, []],
    ] as const) {
      it(`${verb}: a confirmation that reads ${label} refuses instead of answering success`, async () => {
        const outcome = await withMemoryWriteLock(store, ["m1"], (held) =>
          withLockedMemoryTransaction(held, ctx(), async (tx) => {
            const receipt = await checked[verb](held, tx, { id: "m1", content: body(verb, "the checked edit"), confirmFields });
            harnessState.getOverride = (id) => (id === "m1" ? { ...harnessState.memoryStore.get("m1"), ...change } : undefined);
            return receipt;
          }));
        const written = (outcome as any).value;
        expect(written.kind).toBe("refused");
        expect(written.response.status).toBe(409);
        expect((await written.response.json()).error).toBe("stored_row_changed");
      });
    }

    it(`${verb}: a confirmed field the staged write holds as undefined confirms against a row without it`, async () => {
      const content = { ...body(verb, "the checked edit"), archivedBy: undefined };
      const outcome = await withMemoryWriteLock(store, ["m1"], (held) =>
        withLockedMemoryTransaction(held, ctx(), (tx) => checked[verb](held, tx, { id: "m1", content, confirmFields: ["archivedBy"] })));
      expect((outcome as any).value.kind).toBe("committed");
      expect(harnessState.memoryStore.get("m1").archivedBy).toBeUndefined();
    });

    it(`${verb}: refused with no token, another id set's token, a revoked token, or another store's token; nothing is written`, async () => {
      const content = () => ({ id: "m1", content: body(verb, "an unauthorized edit") });
      // No token, inside a live scope for the id.
      await withMemoryWriteLock(store, ["m1"], async (held) => {
        const run = withLockedMemoryTransaction(held, ctx(), (tx) => checked[verb](undefined as any, tx, content()));
        expect(await reason(run)).toBe("not_a_token");
      });
      // A token for a different id set.
      await withMemoryWriteLock(store, ["m2"], async (held) => {
        const run = withLockedMemoryTransaction(held, ctx(), (tx) => checked[verb](held, tx, content()));
        expect(await reason(run)).toBe("id_not_covered");
      });
      // A token (and its scope) after the acquisition settled.
      let saved: any;
      await withMemoryWriteLock(store, ["m1"], (held) =>
        withLockedMemoryTransaction(held, ctx(), async (tx) => { saved = { held, tx }; return "kept"; }));
      expect(await reason(checked[verb](saved.held, saved.tx, content()))).toBe("revoked");
      // A token acquired on another store.
      const other = memoryLockDouble();
      await withMemoryWriteLock(other, ["m1"], async (held) => {
        const run = withLockedMemoryTransaction(held, ctx(), (tx) => checked[verb](held, tx, content()));
        expect(await reason(run)).toBe("wrong_store");
      });
      expect(harnessState.memoryStore.get("m1")).toEqual(ROW);
      expect(store.held.size).toBe(0);
    });
  }

  it("a checked PUT refuses a skill body and an _reindex body; a checked PATCH refuses a re-embed", async () => {
    const cases: Array<[Verb, Record<string, unknown>]> = [
      ["put", { ...ROW, tags: ["skill"], content: "a skill body" }],
      ["put", { ...ROW, _reindex: true }],
      ["patch", { embedding: null, embeddingModel: null }],
    ];
    for (const [verb, content] of cases) {
      const run = withMemoryWriteLock(store, ["m1"], (held) =>
        withLockedMemoryTransaction(held, ctx(), (tx) => checked[verb](held, tx, { id: "m1", content })));
      expect(await reason(run)).toBe("transaction_mismatch");
    }
    expect(harnessState.memoryStore.get("m1")).toEqual(ROW);
  });

  it("the write body refuses an entry it did not mint", async () => {
    const resource: any = (Memory as any).getResource({ id: "m1" }, ctx());
    expect(await reason(resource.putLocked({ ...ROW, content: "forged" }, undefined, [], Object.freeze({})))).toBe("not_a_transaction");
    expect(await reason(resource.patchLocked({ content: "forged" }, undefined, {}))).toBe("not_a_transaction");
    expect(harnessState.memoryStore.get("m1")).toEqual(ROW);
  });

  it("the public PUT and PATCH take the lock when handed a live token, its scope and bypass markers", async () => {
    const answers: number[] = [];
    await withMemoryWriteLock(store, ["m1"], (held) =>
      withLockedMemoryTransaction(held, ctx(), async (tx) => {
        const scopeContext = lockedTransactionContext(tx);
        const markers = { held, tx, entry: {}, locked: true, lockHeld: true, _lockHeld: true, capability: held };
        for (const verb of ["put", "patch"] as const) {
          const resource: any = (Memory as any).getResource({ id: "m1" }, { ...scopeContext, held, tx, lockToken: held });
          resource[`${verb}Locked`] = () => { throw new Error(`the public ${verb} entered its write body without the lock`); };
          const res = await resource[verb]({ ...body(verb, "a bypass attempt"), ...markers }, held, tx, Object.freeze({}));
          answers.push(res.status);
          expect(await res.json()).toEqual({ error: "memory_busy", caller: "agent-a" });
        }
        return "probe";
      }));
    expect(answers).toEqual([503, 503]);
    expect(harnessState.memoryStore.get("m1")).toEqual(ROW);
  }, 20_000);
});
