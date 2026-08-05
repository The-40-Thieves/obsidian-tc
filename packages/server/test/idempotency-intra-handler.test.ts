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
//   2. Per-handler ordering/atomicity — where both effects are ctx.db writes the marker joins them
//      in one transaction, so a rollback leaves the claim legitimately re-runnable instead of
//      falsely indeterminate; where the second effect is a filesystem write, the idempotent effect
//      runs first instead (suites 2-6).
//
// Every handler assertion is written as the FAULT the old code mishandled, followed by the retry,
// and asserts the effect count — the property that actually broke.
//
// Coverage note: the keyed set is larger than the handlers exercised here. `write_note`,
// `move_note`, `copy_note`, `move_attachment`, `create_canvas` and `create_base` are keyed through
// the NESTED `options.idempotency_key` that WriteOptions carries and now signal too, but their
// writes are either self-protecting or idempotent, so their exposure was duplicated bookkeeping
// (an extra snapshot row, an extra .trash entry) or a misleading retry answer rather than
// duplicated user content. `append_note` — covered below — is the member of that group whose write
// is genuinely non-idempotent.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { openNodeSqlite } from "../src/db/node-node-sqlite";
import { provisionCacheDb } from "../src/db/provision";
import { busyReason, inSavepoint, inTransaction } from "../src/db/txn";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { getEntityById, parseObservations } from "../src/memory/entities";
import { parseEntityNote } from "../src/memory/materialize";
import { registerM5Tools } from "../src/tools/m5";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTestVault } from "./m1-helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeM5Vault } from "./m5-helpers";
import { rmTemp } from "./tmp";

// THE-573 #2 interleave test below needs to observe a real BEGIN IMMEDIATE landing (or not)
// exactly while add_observation is rendering its note projection. materializeEntity is the only
// seam that call sits behind (memory-tools.ts imports it directly, not via an injectable dep), so
// it is wrapped here to fire a test-controlled hook around the real implementation. Every other
// test in this file leaves `onMaterialize` unset, so the wrapper is a pure passthrough for them.
let onMaterialize: (() => void) | undefined;
vi.mock("../src/memory/materialize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/memory/materialize")>();
  return {
    ...actual,
    materializeEntity: (input: Parameters<typeof actual.materializeEntity>[0]) => {
      onMaterialize?.();
      return actual.materializeEntity(input);
    },
  };
});

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

// `deps.reindex` is the injection point these handlers call after their durable write. In the
// production wiring it is IndexCoordinator.submitWrite, which is fire-and-forget and does not
// throw — so the throwing hook below is not a reproduction of a live coordinator failure. It is a
// stand-in for "any fallible step between the durable write and the handler's return", which is
// the class of fault the marker exists to classify correctly, and which the injection point admits
// by contract (deps.reindex is typed as an arbitrary caller-supplied function).
describe("append_to_periodic_note never double-appends after a post-write fault (THE-572)", () => {
  it("a post-write throw yields indeterminate_outcome, not a second append", async () => {
    const v = makeM3Vault({
      reindex: () => {
        throw new Error("post-write step failed");
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

// ── 5. append_note ───────────────────────────────────────────────────────────
//
// The keyed-tool set is NOT just the tools whose schema spells out `idempotency_key` at the top
// level: extractIdempotencyKey also reads a NESTED `options.idempotency_key`, and every tool taking
// `WriteOptions` carries one. append_note is the member of that set whose write is non-idempotent,
// so it is the one that could actually double-apply.

describe("append_note never double-appends after a post-write fault (THE-572)", () => {
  it("a post-write throw yields indeterminate_outcome, not a second append", async () => {
    const v = makeTestVault({
      files: { "note.md": "base" },
      reindex: () => {
        throw new Error("post-write step failed");
      },
    });
    try {
      const args = {
        vault: "test",
        path: "note.md",
        content: "APPENDED",
        options: { idempotency_key: "K" },
      };
      const a = await v.call("append_note", args);
      expect(a.ok).toBe(false);
      // The append landed exactly once...
      expect(v.read("note.md").match(/APPENDED/g)?.length).toBe(1);

      // ...and the retry must NOT concatenate it again. Before THE-572 the claim was deleted here
      // and this second call appended a second copy.
      const b = await v.call("append_note", args);
      expect(b.ok).toBe(false);
      if (!b.ok) expect(b.error.code).toBe("indeterminate_outcome");
      expect(v.read("note.md").match(/APPENDED/g)?.length).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  it("a keyless append is unaffected — it still appends on every call", async () => {
    const v = makeTestVault({ files: { "note.md": "base" } });
    try {
      const args = { vault: "test", path: "note.md", content: "X" };
      expect((await v.call("append_note", args)).ok).toBe(true);
      expect((await v.call("append_note", args)).ok).toBe(true);
      // No key means no claim and no marker; two calls are two appends, exactly as before.
      expect(v.read("note.md").match(/X/g)?.length).toBe(2);
    } finally {
      v.cleanup();
    }
  });
});

// ── 6. enqueue_capture ───────────────────────────────────────────────────────

describe("enqueue_capture is atomic across its INSERT + read-back (THE-572)", () => {
  it("a read-back fault rolls the INSERT back, so the retry enqueues exactly one capture", async () => {
    const v = makeM5Vault();
    try {
      // enqueueCapture INSERTs, then SELECTs the row back. Fault the read-back.
      const realPrepare = v.db.prepare.bind(v.db);
      let faulting = true;
      (v.db as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        if (faulting && /SELECT .* FROM capture_queue WHERE id = \?/.test(sql))
          throw new Error("read-back boom");
        return realPrepare(sql);
      };

      const args = { vault: "test", content: "captured thought", idempotency_key: "K" };
      const a = await v.call("enqueue_capture", args, { now: () => 100 });
      expect(a.ok).toBe(false);

      faulting = false;
      // The INSERT was rolled back with the marker, so nothing is stranded and nothing is claimed.
      expect(
        (v.db.prepare("SELECT COUNT(*) AS n FROM capture_queue").get() as { n: number }).n,
      ).toBe(0);
      expect(
        v.db.prepare("SELECT state FROM idempotency_keys WHERE key='K'").get(),
      ).toBeUndefined();

      const b = await v.call("enqueue_capture", args, { now: () => 200 });
      expect(b.ok).toBe(true);
      // Before THE-572 the first attempt's row survived and this produced TWO captures.
      expect(
        (v.db.prepare("SELECT COUNT(*) AS n FROM capture_queue").get() as { n: number }).n,
      ).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});

// ── 7. inTransaction rollback semantics ──────────────────────────────────────
//
// The re-review's remaining concern about this helper: swallowing EVERY rollback error hides a real
// hazard (a failed ROLLBACK leaves the connection inside an abandoned transaction), but throwing
// from the rollback path would replace the error that actually explains the failure.

describe("inTransaction rollback semantics (THE-572)", () => {
  it("propagates the primary error unchanged when rollback succeeds normally", () => {
    const db = freshDb();
    const primary = new Error("the real failure");
    expect(() =>
      inTransaction(db, () => {
        throw primary;
      }),
    ).toThrow(primary);
    // Benign path: nothing attached, connection is clean enough for the next transaction.
    expect((primary as { rollbackError?: unknown }).rollbackError).toBeUndefined();
    expect(() => inTransaction(db, () => 1)).not.toThrow();
  });

  it("a COMMIT that throws still surfaces the COMMIT error, not a rollback error", () => {
    const db = freshDb();
    const realExec = db.exec.bind(db);
    (db as { exec: (s: string) => void }).exec = (sql: string) => {
      if (/^COMMIT/i.test(sql)) throw new Error("commit boom");
      return realExec(sql);
    };
    expect(() => inTransaction(db, () => 1)).toThrow(/commit boom/);
  });

  it("a GENUINE rollback failure is attached to the primary error, never thrown in its place", () => {
    const db = freshDb();
    const realExec = db.exec.bind(db);
    (db as { exec: (s: string) => void }).exec = (sql: string) => {
      if (/^ROLLBACK/i.test(sql)) throw new Error("disk I/O error");
      return realExec(sql);
    };
    const primary = new Error("the real failure");
    expect(() =>
      inTransaction(db, () => {
        throw primary;
      }),
    ).toThrow(primary); // the caller still sees the error that explains the failure...
    // ...with the rollback fault preserved for diagnostics rather than discarded.
    expect((primary as { rollbackError?: Error }).rollbackError?.message).toMatch(/disk I\/O/);
    // Non-enumerable, so it cannot leak into a JSON-serialized client response.
    expect(Object.keys(primary)).not.toContain("rollbackError");
  });

  it("SQLite's own 'no transaction is active' is treated as benign and NOT attached", () => {
    const db = freshDb();
    const realExec = db.exec.bind(db);
    (db as { exec: (s: string) => void }).exec = (sql: string) => {
      if (/^ROLLBACK/i.test(sql)) throw new Error("cannot rollback - no transaction is active");
      return realExec(sql);
    };
    const primary = new Error("the real failure");
    expect(() =>
      inTransaction(db, () => {
        throw primary;
      }),
    ).toThrow(primary);
    expect((primary as { rollbackError?: unknown }).rollbackError).toBeUndefined();
  });
});

// ── THE-573: the three residuals Codex round-two documented rather than fixed ─────────────────

describe("THE-573 #1: one CallerContext reused across CONCURRENT dispatches", () => {
  // registry.ts installs markEffectCommitted by MUTATING the per-dispatch ctx. If one context were
  // shared by two in-flight dispatches, the second would overwrite the first's callback — the outer
  // handler would then mark the INNER claim, its own effectCommitted would stay false, and the catch
  // would DELETE its claim, leaving a retry free to double-apply.
  //
  // Verified unreachable through the server (both context factories build a fresh object per MCP
  // call, and no handler re-enters dispatch), so this is a library-API misuse rather than a live
  // defect. The fix is therefore to make the misuse LOUD rather than to make sharing work: silently
  // corrupting an idempotency claim is far worse than refusing the second dispatch.
  it("detects the overwrite instead of silently corrupting the first claim", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    const shared = ctx(db);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const eff = { n: 0 };
    reg.register({
      name: "slow_step",
      description: "signals, then awaits so a second dispatch can overlap it",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: async (_i, c) => {
        c.markEffectCommitted?.();
        eff.n += 1;
        // Only the FIRST call parks. If both awaited the same gate the test would deadlock on its
        // own construction rather than on the behaviour under test.
        if (eff.n === 1) await gate;
        return { ok: true as const, data: { done: true } };
      },
    });

    const first = reg.dispatch("slow_step", { idempotency_key: "A" }, shared);
    // Second dispatch on the SAME context object while the first is still in flight.
    const second = await reg.dispatch("slow_step", { idempotency_key: "B" }, shared);
    expect(second.ok).toBe(false);

    release?.();
    const a = await first;
    // The first claim is untouched by the overlap: it completed on its OWN key.
    expect(a.ok).toBe(true);
    expect(eff.n).toBe(1);
    expect(idemState(db, "A")).toBe("completed");
  });

  it("SEQUENTIAL reuse of the same context object still works (the callback is cleaned up)", async () => {
    // The detection must key on a LIVE overlapping dispatch, not on "this ctx was used before" —
    // otherwise a caller reusing one context serially breaks for no reason.
    const db = freshDb();
    const reg = new ToolRegistry();
    const shared = ctx(db);
    reg.register({
      name: "seq_step",
      description: "ordinary keyed tool",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: (_i, c) => {
        c.markEffectCommitted?.();
        return { ok: true as const, data: { done: true } };
      },
    });
    expect((await reg.dispatch("seq_step", { idempotency_key: "S1" }, shared)).ok).toBe(true);
    expect((await reg.dispatch("seq_step", { idempotency_key: "S2" }, shared)).ok).toBe(true);
    expect(idemState(db, "S1")).toBe("completed");
    expect(idemState(db, "S2")).toBe("completed");
  });
});

describe("THE-573 #3: inSavepoint (nested-safe) and rollback-failure reporting", () => {
  it("an inner failure rolls back ONLY the inner work; the outer transaction still commits", () => {
    // inTransaction is non-reentrant by construction — SQLite has no nested transactions, only
    // SAVEPOINTs — so a handler already inside a transaction had no helper at all and had to
    // hand-roll one, which is exactly what inTransaction exists to prevent.
    const db = freshDb();
    db.exec("CREATE TABLE t (v TEXT)");
    inTransaction(db, () => {
      db.prepare("INSERT INTO t (v) VALUES ('outer')").run();
      expect(() =>
        inSavepoint(db, () => {
          db.prepare("INSERT INTO t (v) VALUES ('inner')").run();
          throw new Error("inner blew up");
        }),
      ).toThrow(/inner blew up/);
      return 0;
    });
    expect(db.prepare("SELECT v FROM t").all()).toEqual([{ v: "outer" }]);
  });

  it("a successful savepoint keeps its work when the outer transaction commits", () => {
    const db = freshDb();
    db.exec("CREATE TABLE t (v TEXT)");
    inTransaction(db, () => {
      db.prepare("INSERT INTO t (v) VALUES ('outer')").run();
      inSavepoint(db, () => db.prepare("INSERT INTO t (v) VALUES ('inner')").run());
      return 0;
    });
    expect(db.prepare("SELECT v FROM t ORDER BY v").all()).toEqual([
      { v: "inner" },
      { v: "outer" },
    ]);
  });

  it("works standalone too (no outer transaction)", () => {
    const db = freshDb();
    db.exec("CREATE TABLE t (v TEXT)");
    inSavepoint(db, () => db.prepare("INSERT INTO t (v) VALUES ('solo')").run());
    expect(db.prepare("SELECT v FROM t").all()).toEqual([{ v: "solo" }]);
  });

  it("routes a GENUINE rollback failure to onInternalError, not only to the caller", async () => {
    // An abandoned transaction is an operator-grade fault: the connection may still be INSIDE a
    // transaction, so later reads can observe uncommitted rows. Attaching it to the thrown error
    // (THE-572) reaches the caller; it must also reach the diagnostics sink, or it is invisible to
    // anyone who logs only err.message.
    const db = freshDb();
    const realExec = db.exec.bind(db);
    (db as { exec: (s: string) => void }).exec = (sql: string) => {
      if (/^ROLLBACK/i.test(sql)) throw new Error("disk I/O error");
      return realExec(sql);
    };
    const seen: Array<{ tool: string; err: unknown }> = [];
    const reg = new ToolRegistry({ onInternalError: (tool, _v, err) => seen.push({ tool, err }) });
    reg.register({
      name: "rollback_fault",
      description: "fails inside a transaction whose ROLLBACK then also fails",
      inputSchema: z.object({}),
      requiredScopes: ["write:notes"],
      handler: (_i, c) =>
        inTransaction(c.db, () => {
          throw new Error("the real failure");
        }),
    });
    const r = await reg.dispatch("rollback_fault", {}, ctx(db));
    expect(r.ok).toBe(false);
    const rollbackReport = seen.find((s) => s.tool.startsWith("txn_rollback:"));
    expect(rollbackReport).toBeDefined();
    expect((rollbackReport?.err as Error)?.message).toMatch(/disk I\/O/);
  });
});

// ── THE-573 #2: the LIVE residual — add_observation's read + render + append used to be split
// around its write lock, not covered by it ──────────────────────────────────────────────────────
//
// #1 and #3 above were already closed by bb4e776 (PR #445). #2 was not: `existing` was read, the
// next-observations list derived, and the note rendered to disk ALL BEFORE `inWriteTransaction`
// ever opened (memory-tools.ts:288-323, pre-fix). Two real failure modes fell out of that split:
//   1. A contended `BEGIN IMMEDIATE` can fail with plain SQLITE_BUSY after exhausting
//      busy_timeout (txn.ts:119-127) — by then the note had ALREADY been rendered, so the file
//      gains an observation that never reaches SQLite.
//   2. A second connection's commit can land between our read and our write — SQLite ends up
//      correct (appendObservation re-reads inside its own transaction), but the note we already
//      rendered from a stale snapshot is missing the interleaved observation.
// The ticket's own "two concurrent calls" framing is unreachable in-process (memory-tools.ts has
// zero `await`s), so both tests below drive the failure through REAL SQLite mechanics — a stubbed
// busy error for #1, and a second real connection to the same file for #2 — rather than simulated
// concurrency.
describe("THE-573 #2: add_observation's read + render + append now share ONE write lock", () => {
  it("a BEGIN IMMEDIATE busy failure leaves the note file byte-for-byte UNCHANGED", async () => {
    const v = makeM5Vault();
    try {
      const id = await makeEntity(v);
      const before = v.read("memory/person/Ada.md");

      // Fault injection: BEGIN IMMEDIATE itself throws SQLITE_BUSY (the shape busyReason.ts:195-205
      // reads), reproducing a contended write lock without waiting out busy_timeout. Under the
      // pre-fix ordering the note was already rendered to disk BEFORE this statement ever ran, so a
      // busy lock still left "second" on disk with nothing committed to SQLite.
      const realExec = v.db.exec.bind(v.db);
      (v.db as { exec: (s: string) => void }).exec = (sql: string) => {
        if (/^BEGIN IMMEDIATE/.test(sql)) {
          const e = new Error("database is locked") as Error & { code: string };
          e.code = "SQLITE_BUSY";
          throw e;
        }
        return realExec(sql);
      };

      const a = await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "second", idempotency_key: "K" },
        { now: () => 200 },
      );
      expect(a.ok).toBe(false);
      // The read, the render, and the append are now ALL inside the callback that
      // inWriteTransaction never invokes when BEGIN IMMEDIATE itself throws — so the note is
      // untouched...
      expect(v.read("memory/person/Ada.md")).toBe(before);
      expect(observations(v, id)).toEqual(["first"]);
      // ...which makes this a pre-effect failure: the claim is released for a real retry.
      expect(
        v.db.prepare("SELECT state FROM idempotency_keys WHERE key='K'").get(),
      ).toBeUndefined();

      (v.db as { exec: (s: string) => void }).exec = realExec; // clear the fault
      const b = await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "second", idempotency_key: "K" },
        { now: () => 300 },
      );
      expect(b.ok).toBe(true);
      expect(observations(v, id)).toEqual(["first", "second"]);
      expect(v.read("memory/person/Ada.md")).toContain("- second");
    } finally {
      v.cleanup();
    }
  });

  it("a real second connection cannot begin a write while ours is rendering, so the note never diverges from SQLite", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "obtc-interleave-db-"));
    const root = mkdtempSync(join(tmpdir(), "obtc-interleave-vault-"));
    let dbA: Database | undefined;
    let dbB: Database | undefined;
    try {
      dbA = await openNodeSqlite(join(dbDir, "cache.db"));
      provisionCacheDb(dbA);
      dbB = await openNodeSqlite(join(dbDir, "cache.db"));
      // Short-circuit dbB's wait so a genuinely-blocked probe fails fast instead of eating the
      // adapter's 5000ms default (set by openNodeSqlite for every connection).
      dbB.exec("PRAGMA busy_timeout = 150");

      const vaultRegistry = new VaultRegistry([{ id: "test", path: root }]);
      const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
      const regA = new ToolRegistry();
      registerM5Tools(regA, { vaultRegistry, cacheDir: "" });
      const regB = new ToolRegistry();
      registerM5Tools(regB, { vaultRegistry, cacheDir: "" });
      const base = {
        caller: "test",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "test",
        acl,
      };
      const ctxA: CallerContext = { ...base, db: dbA };
      const ctxB: CallerContext = { ...base, db: dbB };

      const created = await regA.dispatch(
        "create_entity",
        { vault: "test", type: "person", name: "Ada", observations: ["first"] },
        ctxA,
      );
      if (!created.ok) throw new Error("setup failed");
      const id = (created.data as { entity_id: string }).entity_id;

      // Fires from INSIDE regA's add_observation, exactly where the note projection is rendered.
      // A genuine second connection tries to begin its OWN write right there. Pre-fix, A had not
      // yet opened its transaction at this point (the render ran before inWriteTransaction), so
      // this probe would acquire the lock immediately — reproducing the interleave. Post-fix, A's
      // transaction has been open since BEFORE the read, so the probe must find the lock held.
      let probed: unknown;
      onMaterialize = () => {
        try {
          (dbB as Database).exec("BEGIN IMMEDIATE");
          (dbB as Database).exec("ROLLBACK");
          probed = "acquired"; // the bug: A's lock did not cover the render
        } catch (e) {
          probed = e; // expected: a real SQLITE_BUSY from dbA's held lock
        }
      };
      let a: Awaited<ReturnType<typeof regA.dispatch>>;
      try {
        a = await regA.dispatch(
          "add_observation",
          { vault: "test", entity_id: id, observation: "from-A" },
          ctxA,
        );
      } finally {
        onMaterialize = undefined;
      }
      expect(a.ok).toBe(true);
      expect(busyReason(probed)).not.toBeNull();

      // Once A has released the lock, a real second-connection add_observation lands cleanly.
      const b = await regB.dispatch(
        "add_observation",
        { vault: "test", entity_id: id, observation: "from-B" },
        ctxB,
      );
      expect(b.ok).toBe(true);

      const row = getEntityById(dbA, id);
      const dbObs = row ? parseObservations(row.observations) : [];
      const noteText = readFileSync(join(root, "memory/person/Ada.md"), "utf8");
      const fileObs = parseEntityNote(noteText).observations;
      expect(dbObs).toEqual(["first", "from-A", "from-B"]);
      expect(fileObs).toEqual(dbObs);
    } finally {
      dbA?.close?.();
      dbB?.close?.();
      rmTemp(dbDir);
      rmTemp(root);
    }
  });
});
