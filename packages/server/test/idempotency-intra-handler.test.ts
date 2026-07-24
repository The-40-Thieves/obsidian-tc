// THE-572 — the intra-handler residual #13 documented but could not close at the dispatch layer.
//
// #13 marks the idempotency claim `effect_committed` only when the WHOLE handler returns. A
// multi-step handler that commits effect #1 and then does more fallible work therefore had a real
// window: a throw before the return deleted the claim, and a retry with the same key RE-RAN the
// handler and double-applied effect #1.
//
// The fix has two halves, and each is asserted here:
//   1. `ctx.markEffectCommitted()` — a mid-execution signal that moves the marker to the handler's
//      own first durable effect (suite 1).
//   2. Per-handler ordering/atomicity — the idempotent effect runs first, and where both effects
//      are ctx.db writes the marker joins them in one transaction, so a rollback leaves the claim
//      legitimately re-runnable instead of falsely indeterminate (suites 2-4).
//
// Every handler assertion is written as the FAULT the old code mishandled, followed by the retry,
// and asserts the effect count — the property that actually broke.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { getEntityById, parseObservations } from "../src/memory/entities";
import { openMemoryDb } from "./helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeM5Vault } from "./m5-helpers";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}
function ctx(db: Database, over: Partial<CallerContext> = {}): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db,
    ...over,
  };
}
function idemState(db: Database, key: string): string | undefined {
  return (
    db.prepare("SELECT state FROM idempotency_keys WHERE vault_id='v1' AND key=?").get(key) as
      | { state: string }
      | undefined
  )?.state;
}

// ── 1. the dispatch primitive ────────────────────────────────────────────────

describe("ctx.markEffectCommitted (THE-572 primitive)", () => {
  it("a throw AFTER the signal but BEFORE the handler returns records indeterminate, never re-runs", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    const eff = { n: 0 };
    reg.register({
      name: "two_step",
      description: "commits effect #1, signals, then fails on later work",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: (_i, c) => {
        c.markEffectCommitted?.(); // write-ahead of the durable effect
        eff.n += 1; // effect #1 — durably committed
        throw new Error("the second step blew up"); // ...and we never reach the return
      },
    });

    const a = await reg.dispatch("two_step", { idempotency_key: "K" }, ctx(db));
    expect(a.ok).toBe(false);
    expect(eff.n).toBe(1);
    // Before THE-572 this row was DELETED here, because handlerReturned was still false.
    expect(idemState(db, "K")).toBe("indeterminate");

    const b = await reg.dispatch("two_step", { idempotency_key: "K" }, ctx(db));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.code).toBe("indeterminate_outcome");
    expect(eff.n).toBe(1); // the whole point: no double-apply
  });

  it("a signal ROLLED BACK with the handler's transaction releases the claim (no false indeterminate)", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    const eff = { n: 0 };
    let failFirst = true;
    reg.register({
      name: "txn_step",
      description: "signals inside its own transaction, which then rolls back",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: (_i, c) => {
        c.db.exec("BEGIN");
        try {
          c.markEffectCommitted?.();
          if (failFirst) throw new Error("the effect itself failed");
          eff.n += 1;
          c.db.exec("COMMIT");
          return { ok: true };
        } catch (e) {
          c.db.exec("ROLLBACK");
          throw e;
        }
      },
    });

    const a = await reg.dispatch("txn_step", { idempotency_key: "K" }, ctx(db));
    expect(a.ok).toBe(false);
    expect(eff.n).toBe(0); // nothing was applied...
    // ...so the claim must be RELEASED, not stranded indeterminate. The in-memory signal fired,
    // but the durable marker rolled back with the transaction, and the durable state is what wins.
    expect(idemState(db, "K")).toBeUndefined();

    failFirst = false;
    const b = await reg.dispatch("txn_step", { idempotency_key: "K" }, ctx(db));
    expect(b.ok).toBe(true); // a legitimate retry re-runs
    expect(eff.n).toBe(1);
  });

  it("is undefined on a keyless call, so `?.()` is the required call shape", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    let seen: unknown = "unset";
    reg.register({
      name: "peek",
      description: "reports whether the signal was installed",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: (_i, c) => {
        seen = c.markEffectCommitted;
        return { ok: true };
      },
    });
    await reg.dispatch("peek", {}, ctx(db)); // no idempotency_key
    expect(seen).toBeUndefined();
    await reg.dispatch("peek", { idempotency_key: "K" }, ctx(db));
    expect(typeof seen).toBe("function");
  });

  it("signalling and then returning normally still completes (the marker is idempotent)", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    reg.register({
      name: "signals_then_succeeds",
      description: "signals, then returns normally so #13's call site marks again",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: (_i, c) => {
        c.markEffectCommitted?.();
        return { ok: true };
      },
    });
    const a = await reg.dispatch("signals_then_succeeds", { idempotency_key: "K" }, ctx(db));
    expect(a.ok).toBe(true);
    expect(idemState(db, "K")).toBe("completed");
    const b = await reg.dispatch("signals_then_succeeds", { idempotency_key: "K" }, ctx(db));
    expect(b.ok).toBe(true); // replayed from cache
  });
});

// ── 2. add_observation ───────────────────────────────────────────────────────

async function makeEntity(v: ReturnType<typeof makeM5Vault>): Promise<string> {
  const r = await v.call(
    "create_entity",
    { vault: "test", type: "person", name: "Ada", observations: ["first"] },
    { now: () => 100 },
  );
  if (!r.ok) throw new Error("setup failed");
  return (r.data as { entity_id: string }).entity_id;
}
function observations(v: ReturnType<typeof makeM5Vault>, id: string): string[] {
  const row = getEntityById(v.db, id);
  return row ? parseObservations(row.observations) : [];
}

describe("add_observation is atomic across its SQLite append + note write (THE-572)", () => {
  it("a note-write fault leaves the observation UNAPPENDED, so the retry applies it exactly once", async () => {
    const v = makeM5Vault();
    try {
      const id = await makeEntity(v);
      expect(observations(v, id)).toEqual(["first"]);

      // Fault injection: replace the entity's note with a DIRECTORY, so the note write throws
      // EISDIR. Under the old ordering the SQLite append had ALREADY committed by this point.
      const notePath = join(v.root, "memory/person/Ada.md");
      rmSync(notePath);
      mkdirSync(notePath);

      const a = await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "second", idempotency_key: "K" },
        { now: () => 200 },
      );
      expect(a.ok).toBe(false);
      // The note write is now FIRST, so the append never happened...
      expect(observations(v, id)).toEqual(["first"]);
      // ...which makes this a pre-effect failure: the claim is released for a real retry.
      expect(
        v.db.prepare("SELECT state FROM idempotency_keys WHERE key='K'").get(),
      ).toBeUndefined();

      rmSync(notePath, { recursive: true }); // clear the fault
      const b = await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "second", idempotency_key: "K" },
        { now: () => 300 },
      );
      expect(b.ok).toBe(true);
      // The property the old code broke: "second" appears ONCE, not twice.
      expect(observations(v, id)).toEqual(["first", "second"]);
      expect(v.read("memory/person/Ada.md")).toContain("- second");
    } finally {
      v.cleanup();
    }
  });

  it("a SQLite-append fault rolls the marker back with it, so the retry re-runs cleanly", async () => {
    const v = makeM5Vault();
    try {
      const id = await makeEntity(v);

      // Fault injection: make the observations UPDATE throw, from inside the handler's transaction.
      const realPrepare = v.db.prepare.bind(v.db);
      let faulting = true;
      (v.db as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        if (faulting && /UPDATE memory_entities SET observations/.test(sql))
          throw new Error("db boom");
        return realPrepare(sql);
      };

      const a = await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "second", idempotency_key: "K" },
        { now: () => 200 },
      );
      expect(a.ok).toBe(false);

      faulting = false;
      expect(observations(v, id)).toEqual(["first"]); // rolled back
      // The marker was set INSIDE that transaction, so it rolled back too — no false indeterminate.
      expect(
        v.db.prepare("SELECT state FROM idempotency_keys WHERE key='K'").get(),
      ).toBeUndefined();

      const b = await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "second", idempotency_key: "K" },
        { now: () => 300 },
      );
      expect(b.ok).toBe(true);
      expect(observations(v, id)).toEqual(["first", "second"]);
    } finally {
      v.cleanup();
    }
  });
});

// ── 3. start_session ─────────────────────────────────────────────────────────

describe("start_session is atomic across its row insert + trace write (THE-572)", () => {
  it("a trace-write fault leaves NO session row, so the retry creates exactly one", async () => {
    const v = makeM5Vault({ traceFolder: "traces" });
    try {
      // Fault injection: occupy the trace FOLDER path with a regular file, so the trace write's
      // mkdirSync throws ENOTDIR. Under the old ordering the session row was already inserted.
      writeFileSync(join(v.root, "traces"), "not a folder");

      const a = await v.call(
        "start_session",
        { vault: "test", caller: "agent-1", idempotency_key: "K" },
        { now: () => 100 },
      );
      expect(a.ok).toBe(false);
      const after = v.db.prepare("SELECT COUNT(*) AS n FROM workspace_sessions").get() as {
        n: number;
      };
      expect(after.n).toBe(0);
      expect(
        v.db.prepare("SELECT state FROM idempotency_keys WHERE key='K'").get(),
      ).toBeUndefined();

      rmSync(join(v.root, "traces")); // clear the fault
      const b = await v.call(
        "start_session",
        { vault: "test", caller: "agent-1", idempotency_key: "K" },
        { now: () => 200 },
      );
      expect(b.ok).toBe(true);
      // The property the old code broke: one attempt + one retry produced TWO rows.
      const final = v.db.prepare("SELECT COUNT(*) AS n FROM workspace_sessions").get() as {
        n: number;
      };
      expect(final.n).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});

// ── 4. append_to_periodic_note ───────────────────────────────────────────────

describe("append_to_periodic_note never double-appends after a reindex fault (THE-572)", () => {
  it("a post-write reindex throw yields indeterminate_outcome, not a second append", async () => {
    const v = makeM3Vault({
      reindex: () => {
        throw new Error("index coordinator rejected the write");
      },
    });
    try {
      const args = {
        vault: "test",
        period: "daily",
        date: "2026-07-24",
        content: "- a line",
        idempotency_key: "K",
      };
      const a = await v.call("append_to_periodic_note", args, { now: () => 100 });
      expect(a.ok).toBe(false); // the reindex fault surfaces...

      // ...but the note WAS written, exactly once. (Default periodic resolver: <date>.md at root.)
      const path = "2026-07-24.md";
      expect(v.read(path).match(/- a line/g)?.length).toBe(1);

      // Appending is inherently non-idempotent, so the ONLY safe answer to a retry is a definite
      // "this may have applied" — never a re-run that appends the line a second time.
      const b = await v.call("append_to_periodic_note", args, { now: () => 200 });
      expect(b.ok).toBe(false);
      if (!b.ok) expect(b.error.code).toBe("indeterminate_outcome");
      expect(v.read(path).match(/- a line/g)?.length).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});
