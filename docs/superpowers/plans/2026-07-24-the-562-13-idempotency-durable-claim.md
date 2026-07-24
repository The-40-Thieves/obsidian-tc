# Durable Idempotency Claim State-Machine (THE-562 #13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a post-effect idempotency failure record a durable "this may have run" outcome instead of deleting the claim, so a retry gets a definite `indeterminate_outcome` answer rather than re-executing a committed side effect — covering both in-process post-effect throws and the crash-after-effect window.

**Architecture:** Add an explicit `state` column to `idempotency_keys` (`in_flight → effect_committed → completed | indeterminate`). In `registry.ts` dispatch: durably mark `effect_committed` right after the handler returns; on a post-effect fault record `indeterminate` (never delete); exclude `effect_committed` from crash-reclaim; add replay branches that return `indeterminate_outcome` for `indeterminate`/`effect_committed` rows.

**Tech Stack:** TypeScript, Bun, Vitest, SQLite `Database`, monorepo package `@the-40-thieves/obsidian-tc-server`.

## Global Constraints

- **Commits:** DCO-signed (`git commit -s`); every message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Migration is additive:** a brand-new file `packages/server/src/migrations/20260724_002_idempotency_state.sql`. Do NOT edit any existing (applied, checksum-verified) migration. It MUST be appended to `CACHE_MIGRATION_FILES` in `packages/server/src/db/migration-manifest.ts` (the `idempotency_keys` table lives in the **cache.db** chain — `20260519_001_initial.sql`) or the #9 completeness test fails.
- **Idempotency invariant:** a keyed handler that returns is treated as "effect may be committed" (keys attach to mutating tools only). A retry against an `indeterminate` or orphaned `effect_committed` row must NEVER re-run the handler; it returns `indeterminate_outcome`. A *pre*-handler failure still deletes the claim (legitimate retry re-runs).
- **These existing tests must stay green** (behavior-preserving): `test/idempotency.test.ts` — the cached-replay (`:79`), overflow-replay (`:293`), crash-reclaim (`:138`, `:321`), failed-handler-releases-slot (`:153`), expired-completed-miss (`:238`), and no-key (`:175`) cases.
- **Verification before any push:** root `bun run typecheck` (all packages — vitest strips types), `bun run lint`, full server suite (`cd packages/server && bun run test`), and `node scripts/check-boundaries.mjs`.
- Public repo: no secrets/vault data in code or tests.

## Key existing code (read before editing)

`packages/server/src/mcp/registry.ts`:
- Claim helpers: `tryClaimIdempotency` (`:371`, INSERT at `:380-383`), `readIdempotency` (`:391`), `finalizeIdempotency` (`:422`), `deleteIdempotency` (`:436`).
- Dispatch idempotency gate/reclaim: `:744-840` (claim `:747`; reclaim predicate `:754-758`; replay block `:769-838`; overflow-replay re-check `:786`; cached-result replay `:810`).
- Handler call: inside `runAudited`, `const r = await def.handler(parsed.data, ctx)` at `:935`; `out` returned at `:939`.
- Post-effect points: strict-schema throw `:958-962`; `JSON.stringify(out ?? null)` `:966`; overflow branch + its finalize `:970-1012` (finalize at `:982`, nested fault catch `:983-991`); success finalize `:1014-1015`.
- The bug: generic catch `:1030-1037` unconditionally `deleteIdempotency`.
- `now` is a dispatch-local clock (`ctx.now ?? Date.now`), used as `now()`; `start` is the dispatch start ms; `audit(...)` is a dispatch-local closure; `this.meter(...)`, `this.maxResponseBytes`, `this.idempotencyReclaimMs`, `this.strictOutputSchema`, `this.onInternalError`.

`packages/server/test/idempotency.test.ts` harness: `freshDb()` = `openMemoryDb()` + `provisionCacheDb(db)`; `counterReg(opts)` registers a keyed `kv_put` counting handler; `ctx(db, { now })` injects the clock; `idemRow(db, key)` reads the row (`SELECT *`); raw `INSERT` (9 cols, no `state`).

---

## Task 1: `state` column — migration, manifest, read path

**Files:**
- Create: `packages/server/src/migrations/20260724_002_idempotency_state.sql`
- Modify: `packages/server/src/db/migration-manifest.ts` (append to `CACHE_MIGRATION_FILES`)
- Modify: `packages/server/src/mcp/registry.ts` — `readIdempotency` selects `state`
- Test: `packages/server/test/idempotency-state-column.test.ts`

**Interfaces:**
- Produces: `idempotency_keys.state TEXT NOT NULL DEFAULT 'in_flight'`; `readIdempotency` return type gains `state: string`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/idempotency-state-column.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";

describe("idempotency_keys.state column (THE-562 #13)", () => {
  it("adds a state column defaulting to 'in_flight'", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const cols = db.prepare("PRAGMA table_info(idempotency_keys)").all() as {
      name: string;
      dflt_value: string | null;
      notnull: number;
    }[];
    const state = cols.find((c) => c.name === "state");
    expect(state, "state column exists").toBeDefined();
    expect(state?.notnull).toBe(1);
    // A row inserted without state gets the default.
    db.prepare(
      "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at) VALUES ('v','k','t','h',1,NULL,NULL,NULL,999)",
    ).run();
    const row = db.prepare("SELECT state FROM idempotency_keys WHERE key='k'").get() as {
      state: string;
    };
    expect(row.state).toBe("in_flight");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/server && bunx vitest run test/idempotency-state-column.test.ts`
Expected: FAIL — no `state` column.

- [ ] **Step 3: Create the migration**

Create `packages/server/src/migrations/20260724_002_idempotency_state.sql`:

```sql
-- THE-562 #13 (THE-413 residual): make the idempotency claim state machine explicit. Prior code
-- inferred state from completed_at (+ an overflow sentinel), so a post-effect fault could not be
-- distinguished from a pre-effect one and the claim was deleted → a retry re-ran a committed effect.
-- states: in_flight (claimed) -> effect_committed (handler returned, effect may be durable, response
-- not recorded) -> completed (response/overflow recorded) | indeterminate (post-effect fault).
ALTER TABLE idempotency_keys ADD COLUMN state TEXT NOT NULL DEFAULT 'in_flight';

-- Back-fill: any pre-existing finished row is 'completed'. In-flight rows stay 'in_flight'
-- (they predate the marker; reclaim treats them as before — acceptable, they are near-expiry).
UPDATE idempotency_keys SET state = 'completed' WHERE completed_at IS NOT NULL;
```

- [ ] **Step 4: Register in the manifest**

In `packages/server/src/db/migration-manifest.ts`, append to `CACHE_MIGRATION_FILES` (after `"20260724_001_plane_vault_id.sql"`):

```ts
  "20260724_002_idempotency_state.sql",
```

- [ ] **Step 5: Select `state` in `readIdempotency`**

In `registry.ts`, `readIdempotency` (`:391`): add `state` to the SELECT column list and to BOTH the return-type annotation and the `as {...}` cast:

```ts
    return cachedPrepare(
      db,
      "SELECT tool_name, args_hash, started_at, completed_at, result, result_size, expires_at, state FROM idempotency_keys WHERE vault_id = ? AND key = ?",
    ).get(vaultId, key) as
      | { tool_name: string; args_hash: string; started_at: number; completed_at: number | null; result: unknown; result_size: number | null; expires_at: number; state: string }
      | undefined;
```

(Update the interface return type above the function body identically — add `state: string`.)

- [ ] **Step 6: Run the test + the #9 completeness test**

Run: `cd packages/server && bunx vitest run test/idempotency-state-column.test.ts`
Expected: PASS.
Run: `cd packages/server && bunx vitest run test/migration-manifest.test.ts` (or the file matching `grep -rl "migration.*manifest\|CACHE_MIGRATION_FILES" test`)
Expected: PASS — every `migrations/*.sql` is registered in exactly one chain.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/migrations/20260724_002_idempotency_state.sql packages/server/src/db/migration-manifest.ts packages/server/src/mcp/registry.ts packages/server/test/idempotency-state-column.test.ts
git commit -s -m "feat(THE-562 #13): add idempotency_keys.state column + read path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Record `indeterminate` on in-process post-effect faults (the catch-delete bug)

**Files:**
- Modify: `packages/server/src/mcp/registry.ts` — add `markEffectCommitted` + `finalizeIndeterminate` helpers; `finalizeIdempotency` sets `state='completed'`; set `handlerReturned` + marker after the handler; catch records indeterminate vs delete; add an `indeterminateResponse` local + the `state==='indeterminate'` replay branch.
- Test: `packages/server/test/idempotency-post-effect.test.ts`

**Interfaces:**
- Consumes: the `state` column (Task 1).
- Produces: a post-handler throw leaves `state='indeterminate'` (not deleted); a retry against an `indeterminate` row returns `ok:false` error code `indeterminate_outcome` without re-running.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/idempotency-post-effect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { openMemoryDb } from "./helpers";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}
function ctx(db: Database, over: Partial<CallerContext> = {}): CallerContext {
  return { caller: "t", authenticated: true, grantedScopes: new Set(["*"]), vaultId: "v1", db, ...over };
}
function idemRow(db: Database, key: string) {
  return db.prepare("SELECT * FROM idempotency_keys WHERE vault_id='v1' AND key=?").get(key) as
    | { completed_at: number | null; state: string }
    | undefined;
}

describe("idempotency post-effect fault (THE-562 #13)", () => {
  it("a strict-output-schema violation AFTER the effect records indeterminate, not delete", async () => {
    const db = freshDb();
    const reg = new ToolRegistry(); // NODE_ENV=test => strictOutputSchema on
    const eff = { n: 0 };
    reg.register({
      name: "bad_out",
      description: "commits then violates its output schema",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      outputSchema: z.object({ ok: z.literal(true) }),
      requiredScopes: ["write:notes"],
      handler: () => {
        eff.n += 1; // the committed effect
        return { ok: false } as unknown as { ok: true }; // violates outputSchema
      },
    });
    const a = await reg.dispatch("bad_out", { idempotency_key: "K" }, ctx(db));
    expect(a.ok).toBe(false); // the CURRENT caller sees the real failure
    expect(eff.n).toBe(1);
    expect(idemRow(db, "K")?.state).toBe("indeterminate"); // claim NOT deleted
    // retry: must NOT re-run; returns indeterminate_outcome
    const b = await reg.dispatch("bad_out", { idempotency_key: "K" }, ctx(db));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.code).toBe("indeterminate_outcome");
    expect(eff.n).toBe(1); // effect did not double
  });

  it("a JSON.stringify failure AFTER the effect records indeterminate", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    const eff = { n: 0 };
    reg.register({
      name: "unserializable",
      description: "commits then returns a BigInt payload",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => {
        eff.n += 1;
        return { bad: 10n } as unknown as Record<string, unknown>; // JSON.stringify throws on BigInt
      },
    });
    const a = await reg.dispatch("unserializable", { idempotency_key: "K" }, ctx(db));
    expect(a.ok).toBe(false);
    expect(eff.n).toBe(1);
    expect(idemRow(db, "K")?.state).toBe("indeterminate");
    const b = await reg.dispatch("unserializable", { idempotency_key: "K" }, ctx(db));
    if (!b.ok) expect(b.error.code).toBe("indeterminate_outcome");
    expect(eff.n).toBe(1);
  });

  it("a PRE-handler failure still deletes the claim (legitimate retry re-runs)", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    let n = 0;
    reg.register({
      name: "flaky",
      description: "throws before any effect",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => {
        n += 1;
        if (n === 1) throw new Error("boom"); // throws BEFORE committing anything observable
        return { ok: true };
      },
    });
    const a = await reg.dispatch("flaky", { idempotency_key: "K" }, ctx(db));
    expect(a.ok).toBe(false);
    expect(idemRow(db, "K")).toBeUndefined(); // deleted — no effect committed
    const b = await reg.dispatch("flaky", { idempotency_key: "K" }, ctx(db));
    expect(b.ok).toBe(true); // retry re-runs
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/server && bunx vitest run test/idempotency-post-effect.test.ts`
Expected: FAIL — the first two currently delete the claim (`idemRow` undefined) and a retry re-runs (`eff.n === 2`), and there is no `indeterminate_outcome` code.

- [ ] **Step 3: Add the write helpers**

In `registry.ts`, modify `finalizeIdempotency` (`:422`) to also set `state='completed'`:

```ts
    cachedPrepare(
      db,
      "UPDATE idempotency_keys SET completed_at = ?, result = ?, result_size = ?, state = 'completed' WHERE vault_id = ? AND key = ?",
    ).run(nowMs, json, size, vaultId, key);
```

Add two helpers next to it:

```ts
  /** #13: durable marker set the instant the handler returns — the effect may now be committed.
   *  A crash after this leaves a durable 'effect_committed' row that reclaim honors (never re-runs). */
  private markEffectCommitted(db: Database, vaultId: string, key: string, nowMs: number): void {
    cachedPrepare(
      db,
      "UPDATE idempotency_keys SET state = 'effect_committed' WHERE vault_id = ? AND key = ? AND completed_at IS NULL",
    ).run(vaultId, key);
  }

  /** #13: a post-effect fault finalizes the claim as indeterminate (never deletes it), so a retry
   *  returns indeterminate_outcome instead of re-executing. result_size stays NULL so the overflow
   *  re-check never fires; the state='indeterminate' branch answers first. */
  private finalizeIndeterminate(db: Database, vaultId: string, key: string, nowMs: number): void {
    cachedPrepare(
      db,
      "UPDATE idempotency_keys SET completed_at = ?, result = 'null', result_size = NULL, state = 'indeterminate' WHERE vault_id = ? AND key = ?",
    ).run(nowMs, vaultId, key);
  }
```

- [ ] **Step 4: Set the marker + `handlerReturned` after the handler**

In `dispatch`, near where `idemClaimed`/`idemKey` are declared, add a flag:

```ts
      let handlerReturned = false;
```

Inside the `runAudited` callback, immediately after `const r = await def.handler(parsed.data, ctx);` (`:935`) and before `return r;`:

```ts
          handlerReturned = true;
          if (idemClaimed && idemKey) this.markEffectCommitted(ctx.db, ctx.vaultId, idemKey, now());
```

- [ ] **Step 5: Fix the catch — record indeterminate vs delete**

Replace the delete block in the catch (`:1031-1037`):

```ts
      if (idemClaimed && idemKey) {
        if (handlerReturned) {
          // #13: post-effect fault — NEVER delete; record indeterminate so a retry gets a definite
          // answer instead of re-executing the committed effect.
          try {
            this.finalizeIndeterminate(ctx.db, ctx.vaultId, idemKey, now());
          } catch (finErr) {
            try {
              this.onInternalError?.(`idempotency_indeterminate:${name}`, ctx.vaultId, finErr);
            } catch {
              /* diagnostics sink must never break dispatch */
            }
          }
        } else {
          // pre-handler failure: safe to release the slot so a legitimate retry re-runs.
          try {
            this.deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
          } catch {
            /* cleanup best-effort; must not mask the original error */
          }
        }
      }
```

- [ ] **Step 6: Add the `indeterminate_outcome` replay branch**

In the replay block, first define a local response builder just after the dispatch-local `audit` closure is in scope (so it can call `audit`/`this.meter`). Place it once, before the `if (idemKey)` gate or near the other replay logic:

```ts
      const indeterminateReplay = (key: string) => {
        const duration = Math.max(0, now() - start);
        const e = new ObsidianTcError(
          "indeterminate_outcome",
          "a prior attempt with this idempotency key may have applied its effect but did not record a result; verify state before retrying",
          { key },
        );
        audit("error", duration, 0, e.code);
        this.meter((m) => {
          m.incIdempotencyHit(ctx.vaultId, name);
          m.observeToolCall(ctx.vaultId, name, "error", duration / 1000, 0);
        });
        return { ok: false as const, error: e.toJSON(), meta: { duration_ms: duration } };
      };
```

Then in the not-`idemClaimed` block, AFTER the mismatch check (`:774-779`) and BEFORE the `if (row.completed_at != null)` check (`:780`):

```ts
            if (row.state === "indeterminate") return indeterminateReplay(idemKey);
```

(The `effect_committed` branch is added in Task 3.)

- [ ] **Step 7: Run the tests + the existing idempotency suite**

Run: `cd packages/server && bunx vitest run test/idempotency-post-effect.test.ts test/idempotency.test.ts`
Expected: PASS — new post-effect tests pass; every existing idempotency test still green (overflow-replay unaffected: `finalizeIdempotency` now also sets `state='completed'`, retry still hits the overflow re-check).

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/mcp/registry.ts packages/server/test/idempotency-post-effect.test.ts
git commit -s -m "feat(THE-562 #13): record indeterminate on post-effect faults instead of deleting the claim

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Honor `effect_committed` on reclaim (the crash-after-effect half)

**Files:**
- Modify: `packages/server/src/mcp/registry.ts` — reclaim predicate guards on `state='in_flight'`; add the `state==='effect_committed'` replay branch.
- Test: extend `packages/server/test/idempotency-post-effect.test.ts`

**Interfaces:**
- Consumes: `markEffectCommitted` (Task 2), the reclaim/replay blocks.
- Produces: an orphaned `effect_committed` row (crash after effect) within TTL returns `indeterminate_outcome` and is never re-run; past TTL it is GC'd + re-runnable.

- [ ] **Step 1: Write the failing tests**

Add to `test/idempotency-post-effect.test.ts` (reuse its helpers). Include an INSERT that sets `state`:

```ts
const INSERT_STATE =
  "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at, state) VALUES (?,?,?,?,?,?,?,?,?,?)";

describe("idempotency crash-after-effect (THE-562 #13)", () => {
  it("an orphaned effect_committed row (crash before finalize) replays indeterminate, never re-runs", async () => {
    const db = freshDb();
    const { reg, calls } = (() => {
      const reg = new ToolRegistry();
      const calls = { n: 0 };
      reg.register({
        name: "kv_put",
        description: "keyed write",
        inputSchema: z.object({ k: z.string().optional(), idempotency_key: z.string().optional() }),
        requiredScopes: ["write:notes"],
        handler: () => {
          calls.n += 1;
          return { ok: true };
        },
      });
      return { reg, calls };
    })();
    const now = 3_000_000;
    // simulate a process that set the marker then died before finalize: state='effect_committed',
    // completed_at NULL, well within TTL, and PAST the 60s reclaim window.
    db.prepare(INSERT_STATE).run(
      "v1", "K", "kv_put",
      // args_hash must match the retry's args so it is not a mismatch:
      (await import("../src/hash")).argsHash("kv_put", { idempotency_key: "K" }),
      now, null, null, null, now + 86_400_000, "effect_committed",
    );
    const r = await reg.dispatch("kv_put", { idempotency_key: "K" }, ctx(db, { now: () => now + 61_000 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("indeterminate_outcome");
    expect(calls.n).toBe(0); // handler never re-ran
  });

  it("past its TTL, an effect_committed orphan is GC'd and re-runs (bounded at-most-once)", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    let n = 0;
    reg.register({
      name: "kv_put",
      description: "keyed write",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => {
        n += 1;
        return { ok: true };
      },
    });
    const { argsHash } = await import("../src/hash");
    const now = 4_000_000;
    db.prepare(INSERT_STATE).run(
      "v1", "K", "kv_put", argsHash("kv_put", { idempotency_key: "K" }),
      now, null, null, null, now + 1_000, "effect_committed", // expires_at = now+1s
    );
    const r = await reg.dispatch("kv_put", { idempotency_key: "K" }, ctx(db, { now: () => now + 5_000 })); // past TTL
    expect(r.ok).toBe(true);
    expect(n).toBe(1);
  });

  it("an overflow whose finalize faults leaves effect_committed, so a retry is indeterminate", async () => {
    // Prove the marker is set BEFORE the overflow finalize: if finalize throws, durability survives.
    const base = freshDb();
    let runs = 0;
    const reg = new ToolRegistry({ maxResponseBytes: 10 });
    reg.register({
      name: "big_keyed",
      description: "big keyed write",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => {
        runs += 1;
        return { blob: "x".repeat(1000) };
      },
    });
    // db wrapper that throws on the finalize UPDATE (SET completed_at ... state='completed'),
    // delegating everything else to the real db. cachedPrepare (db/types.ts) uses `prepareCached`
    // when the adapter has it, else `prepare` — intercept BOTH so the throw fires regardless of
    // which the memory adapter exposes.
    const FINALIZE_RE =
      /UPDATE idempotency_keys SET completed_at = \?, result = \?, result_size = \?, state = 'completed'/;
    const wrap = (fn: ((sql: string) => Statement) | undefined) =>
      fn
        ? (sql: string) => {
            const stmt = fn.call(base, sql);
            if (FINALIZE_RE.test(sql)) {
              return { ...stmt, run: () => { throw new Error("finalize fault"); } } as Statement;
            }
            return stmt;
          }
        : undefined;
    const throwingDb = new Proxy(base, {
      get(target, prop, recv) {
        if (prop === "prepare") return wrap(target.prepare?.bind(target));
        if (prop === "prepareCached") return wrap(target.prepareCached?.bind(target));
        return Reflect.get(target, prop, recv);
      },
    }) as unknown as Database;
    const first = await reg.dispatch("big_keyed", { idempotency_key: "K" }, ctx(throwingDb));
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("overflow"); // overflow still returned
    expect(runs).toBe(1);
    expect(idemRow(base, "K")?.state).toBe("effect_committed"); // durable marker survived the fault
    // retry on the real db: indeterminate, not re-run.
    const second = await reg.dispatch("big_keyed", { idempotency_key: "K" }, ctx(base));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("indeterminate_outcome");
    expect(runs).toBe(1);
  });
});
```

> Note: `cachedPrepare` (`packages/server/src/db/types.ts:29`) is `db.prepareCached ? db.prepareCached(sql) : db.prepare(sql)`, so the Proxy above intercepts both. Add `import type { Statement } from "../src/db/types"` to the test. If `openMemoryDb()`'s adapter turns out to expose neither method as spread-able (the `{ ...stmt, run }` clone), fall back to returning a plain object implementing the `Statement` methods the finalize path calls (`run`). Keep the wrapper minimal and local to this test; if it proves brittle, an acceptable alternative is to assert the same outcome by seeding an `effect_committed` row (as the crash test does) — but prefer the Proxy since it proves the marker is set *before* the overflow finalize.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/server && bunx vitest run test/idempotency-post-effect.test.ts`
Expected: FAIL — the orphan currently reclaims + re-runs (`calls.n === 1`, no `indeterminate_outcome`); the overflow-finalize-fault currently leaves the row reclaimable.

- [ ] **Step 3: Guard the reclaim predicate on `state='in_flight'`**

In the reclaim predicate (`:754-758`), restrict the in-flight-crash branch to `in_flight` rows (TTL expiry still GCs any state):

```ts
          if (
            row &&
            (row.expires_at <= now() ||
              (row.state === "in_flight" &&
                row.completed_at == null &&
                row.started_at + this.idempotencyReclaimMs <= now()))
          ) {
```

- [ ] **Step 4: Add the `effect_committed` replay branch**

In the not-`idemClaimed` block, right after the `state === "indeterminate"` branch (Task 2, Step 6):

```ts
            if (row.state === "effect_committed") return indeterminateReplay(idemKey);
```

(An `effect_committed` orphan within TTL never reaches the crash-reclaim branch — Step 3 excluded it — so it lands here.)

- [ ] **Step 5: Run the tests + the full idempotency suite**

Run: `cd packages/server && bunx vitest run test/idempotency-post-effect.test.ts test/idempotency.test.ts`
Expected: PASS — new crash/overflow-fault tests pass; existing crash-reclaim tests (`:138`, `:321`, which seed `state='in_flight'` via the default) still reclaim; overflow-replay (`:293`) still replays.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/mcp/registry.ts packages/server/test/idempotency-post-effect.test.ts
git commit -s -m "feat(THE-562 #13): honor effect_committed on reclaim — crash after effect is indeterminate, not re-run

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Document the residual + CHANGELOG; full gate + PR

**Files:**
- Modify: `packages/server/src/mcp/registry.ts` — a short comment at the marker site noting the irreducible two-generals residual (the microsecond between the external fs write and the marker UPDATE).
- Modify: `CHANGELOG.md` — a `### Fixed` (or `### Changed`) entry under `[Unreleased]`.

- [ ] **Step 1: Add the residual comment**

At the `markEffectCommitted` call site (Task 2, Step 4), add:

```ts
          // #13 residual (documented): a crash in the microsecond between the handler's external
          // write and this marker UPDATE still leaves 'in_flight' (reclaimable) — the two-generals
          // limit, unclosable without co-transactional effects. Strictly narrower than the prior
          // window (which spanned the whole handler-return -> finalize interval).
```

- [ ] **Step 2: CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]` `### Fixed` (create the subsection if absent, ordered after `### Added`/`### Security`/before `### Changed` per the file's existing order), add:

```markdown
- **At-most-once idempotency under post-effect faults** (THE-562 #13, closing the THE-413 residual):
  the dispatch pipeline deleted an idempotency claim on any failure *after* the handler had already
  committed its side effect (a strict-output-schema violation, a `JSON.stringify` failure on the
  payload, or an overflow-finalize fault), so a retry with the same key re-ran the handler and
  double-committed. The claim now advances through an explicit `state`
  (`in_flight → effect_committed → completed | indeterminate`): a post-effect fault records
  `indeterminate` instead of deleting, and a retry returns a typed `indeterminate_outcome` error
  rather than re-executing. A process crash after the effect is likewise honored on reclaim. The one
  irreducible residual — a crash in the window between the external write and the marker — is
  documented at the call site.
```

- [ ] **Step 3: Full gate**

Run from repo root: `bun run lint`, `bun run typecheck`, `cd packages/server && bun run test`, `node scripts/check-boundaries.mjs`.
Expected: all green.

- [ ] **Step 4: Commit + PR**

```bash
git add packages/server/src/mcp/registry.ts CHANGELOG.md
git commit -s -m "docs(THE-562 #13): document the two-generals residual + CHANGELOG

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push -u origin mislam2/the-562-13-idempotency-durable-claim
gh pr create --base main --title "feat(THE-562 #13): durable idempotency claim state-machine (at-most-once under post-effect faults)" --body "<summary — see spec>"
```

- [ ] **Step 5: Confirm CI triggered with a non-zero check count; merge on green** — after an adversarial whole-branch review (this changes the dispatch hot-path idempotency contract for every mutating tool).

---

## Self-Review

**Spec coverage:** explicit `state` column + migration + manifest (T1) ✓; durable marker after handler (T2 Step 4) ✓; catch records indeterminate vs delete (T2 Step 5) ✓; `finalizeIdempotency`→completed + `finalizeIndeterminate` (T2 Step 3) ✓; `indeterminate_outcome` replay contract (T2 Step 6) ✓; reclaim excludes `effect_committed` (T3 Step 3) ✓; `effect_committed` replay branch (T3 Step 4) ✓; fault-injection tests — schema-strict (T2), JSON.stringify (T2), pre-handler no-regression (T2), simulated crash (T3), overflow-finalize fault (T3), past-TTL GC (T3) ✓; documented residual + CHANGELOG (T4) ✓.

**Placeholder scan:** the migration numeric prefix is resolved (`20260724_002`, the next cache number after `20260724_001`). The health/manifest test file name in T1 Step 6 is located by `grep` because its exact name isn't pinned. The `throwingDb` Proxy (T3 Step 1) carries a verification note because `cachedPrepare`'s caching shape must be confirmed. The PR body is `<summary — see spec>` — fill from the spec at PR time.

**Type consistency:** `readIdempotency` return type gains `state: string` (T1 Step 5) and every replay/reclaim site reads `row.state` (T2/T3); `markEffectCommitted`/`finalizeIndeterminate`/`finalizeIdempotency` share the `(db, vaultId, key, nowMs)` shape; `indeterminateReplay(key)` returns the `{ ok:false, error, meta }` DispatchResult shape mirroring the overflow inline block; error code string `indeterminate_outcome` used identically in the helper and asserted in every test.

**Note:** T2 and T3 both edit the reclaim/replay region and the catch of `dispatch` — T2 establishes the `indeterminateReplay` local + the `indeterminate` branch + the marker + catch; T3 adds the reclaim `state` guard + the `effect_committed` branch on top. Execute in order.
