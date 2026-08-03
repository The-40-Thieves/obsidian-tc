// THE-229 — M8 experiential domain. Proves the reader contract at the retrieval boundary:
// work_search returns eligible-only by default (honest-empty pre-evaluator), never surfaces
// tombstoned/expired rows, partitions by caller, enforces the trust floor; work_episodes is
// the inspection surface; work_forget flips the control-1 tombstone; record_retrieval_feedback
// stamps the THE-230 outcome axis onto the latest retrieval event(s).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { verifyForgetLog } from "../src/experiential/forget";
import { detectGaps, persistGapReport, singleQuerySearch } from "../src/experiential/gaps";
import { createRetrievalLogger } from "../src/experiential/log";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM8Tools } from "../src/tools/m8";
import { openMemoryDb } from "./helpers";

interface ForgetLogRow {
  seq: number;
  kind: string;
  target: string;
  mode: string;
  details: string | null;
  prev_hash: string;
  hash: string;
}

function forgetLogRows(db: Database): ForgetLogRow[] {
  return db
    .prepare(
      "SELECT seq, kind, target, mode, details, prev_hash, hash FROM forget_log ORDER BY seq",
    )
    .all() as ForgetLogRow[];
}

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
// THE-538: derived from the manifest, not hand-listed. The hand-kept copy named 4 of the chain's
// files, so a new migration that adds a column the retrieval logger writes broke this file for a
// reason that reads as unrelated.
const EXP_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: read(file),
}));
const NOW = 1_700_000_000_000;

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

interface Ep {
  id: string;
  ts?: number;
  caller?: string | null;
  tool?: string;
  status?: string;
  eligibility?: string;
  trust?: number;
  blocked?: number;
  valid_until?: number | null;
  session_id?: string | null;
  summary?: string | null;
  prev_id?: string | null;
}

function seed(db: Database, e: Ep) {
  db.prepare(
    `INSERT INTO agent_episodes (id, ts, vault_id, session_id, caller, channel, episode_type,
       tool, status, eligibility, trust, blocked, valid_from, valid_until, summary, prev_id)
     VALUES (?, ?, 'main', ?, ?, 'dispatch', 'tool_call', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.ts ?? NOW,
    e.session_id ?? null,
    e.caller === undefined ? "tester" : e.caller,
    e.tool ?? "read_note",
    e.status ?? "ok",
    e.eligibility ?? "eligible",
    e.trust ?? 0.6,
    e.blocked ?? 0,
    e.ts ?? NOW,
    e.valid_until ?? null,
    e.summary ?? null,
    e.prev_id ?? null,
  );
}

// cache.db side stub for the dispatch pipeline's audit write.
function cacheDb0() {
  const db = openMemoryDb();
  db.exec(
    "CREATE TABLE event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, vault_id TEXT, tool_name TEXT, caller TEXT, duration_ms INTEGER, result_size INTEGER, status TEXT NOT NULL, error_code TEXT, args_hash TEXT, event_type TEXT);",
  );
  return db;
}

/** Unwrap the dispatch envelope ({ ok, data, meta }) to the handler payload. */
function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

function harness(edb?: Database) {
  const registry = new ToolRegistry({});
  registerM8Tools(registry, { ...(edb ? { edb } : {}), now: () => NOW });
  const cache = cacheDb0();
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["read:workspace", "write:workspace"]),
    vaultId: "main",
    db: cache,
    ...over,
  });
  return { registry, ctx };
}

describe("M8 experiential tools (THE-229)", () => {
  it("reports unavailable without an open experiential handle", async () => {
    const { registry, ctx } = harness(undefined);
    const res = un<{ available: boolean }>(await registry.dispatch("work_search", {}, ctx()));
    expect(res.available).toBe(false);
  });

  it("work_search: eligible-only default, tombstone/expiry/trust/caller contract", async () => {
    const db = edb0();
    seed(db, { id: "e-eligible", eligibility: "eligible", trust: 0.6 });
    seed(db, { id: "e-pending", eligibility: "pending", trust: 0.6 });
    seed(db, { id: "e-ineligible", eligibility: "ineligible", trust: 0.06 });
    seed(db, { id: "e-blocked", eligibility: "eligible", blocked: 1 });
    seed(db, { id: "e-expired", eligibility: "eligible", valid_until: NOW - 1 });
    seed(db, { id: "e-lowtrust-pending", eligibility: "pending", trust: 0.06 });
    seed(db, { id: "e-other-caller", eligibility: "eligible", caller: "someone-else" });

    const { registry, ctx } = harness(db);
    const asIds = (r: unknown) =>
      un<{ results: Array<{ id: string }> }>(r)
        .results.map((x) => x.id)
        .sort();

    // default: eligible only, own caller, no blocked/expired
    const base = await registry.dispatch("work_search", {}, ctx());
    expect(asIds(base)).toEqual(["e-eligible"]);

    // include_pending surfaces pending but the trust floor still excludes high-risk
    const pending = await registry.dispatch("work_search", { include_pending: true }, ctx());
    expect(asIds(pending)).toEqual(["e-eligible", "e-pending"]);

    // any_caller crosses the partition, but ONLY with the elevated admin:workspace scope (P1.7)
    const cross = await registry.dispatch(
      "work_search",
      { any_caller: true },
      ctx({ grantedScopes: new Set(["read:workspace", "admin:workspace"]) }),
    );
    expect(asIds(cross)).toEqual(["e-eligible", "e-other-caller"]);

    // provenance rides every result
    const one = un<{ results: Array<Record<string, unknown>> }>(base).results[0];
    expect(one).toMatchObject({ caller: "tester", channel: "dispatch", eligibility: "eligible" });
    expect(one?.trust).toBe(0.6);
  });

  it("work_episodes inspects pending/ineligible; blocked only with include_blocked", async () => {
    const db = edb0();
    seed(db, { id: "p1", eligibility: "pending" });
    seed(db, { id: "i1", eligibility: "ineligible", trust: 0.06 });
    seed(db, { id: "b1", eligibility: "eligible", blocked: 1 });
    const { registry, ctx } = harness(db);
    const list = un<{ episodes: Array<{ id: string }> }>(
      await registry.dispatch("work_episodes", {}, ctx()),
    );
    expect(list.episodes.map((e) => e.id).sort()).toEqual(["i1", "p1"]);
    const withBlocked = un<{ episodes: Array<{ id: string }> }>(
      await registry.dispatch("work_episodes", { include_blocked: true }, ctx()),
    );
    expect(withBlocked.episodes.map((e) => e.id).sort()).toEqual(["b1", "i1", "p1"]);
  });

  it("THE-655: work_search and work_episodes expose the amendment chain (prev_id)", async () => {
    const db = edb0();
    seed(db, { id: "e-first" });
    seed(db, { id: "e-second", prev_id: "e-first" });
    const { registry, ctx } = harness(db);

    const search = un<{ results: Array<{ id: string; prev_id: string | null }> }>(
      await registry.dispatch("work_search", {}, ctx()),
    );
    const byId = (rs: Array<{ id: string; prev_id: string | null }>) =>
      Object.fromEntries(rs.map((r) => [r.id, r.prev_id]));
    expect(byId(search.results)).toEqual({ "e-first": null, "e-second": "e-first" });

    const episodes = un<{ episodes: Array<{ id: string; prev_id: string | null }> }>(
      await registry.dispatch("work_episodes", {}, ctx()),
    );
    expect(byId(episodes.episodes)).toEqual({ "e-first": null, "e-second": "e-first" });
  });

  it("THE-655: a tombstoned predecessor's id is never leaked via prev_id (control 1)", async () => {
    const db = edb0();
    // e-blocked is tombstoned, so it never surfaces itself (blocked=0 clause) — but e-visible's
    // prev_id still points at it in the raw row. The amendment link must not leak that id.
    seed(db, { id: "e-blocked", blocked: 1 });
    seed(db, { id: "e-visible", prev_id: "e-blocked" });
    const { registry, ctx } = harness(db);

    const search = un<{ results: Array<{ id: string; prev_id: string | null }> }>(
      await registry.dispatch("work_search", {}, ctx()),
    );
    expect(search.results).toHaveLength(1);
    expect(search.results[0]).toMatchObject({ id: "e-visible", prev_id: null });

    // work_episodes: even with include_blocked (which surfaces e-blocked's OWN row), e-visible's
    // link to it still must not leak — include_blocked lists tombstoned rows, it doesn't turn a
    // hidden link visible.
    const episodes = un<{ episodes: Array<{ id: string; prev_id: string | null }> }>(
      await registry.dispatch("work_episodes", { include_blocked: true }, ctx()),
    );
    const visible = episodes.episodes.find((e) => e.id === "e-visible");
    expect(visible?.prev_id).toBeNull();
  });

  it("work_forget tombstones an episode and work_search stops returning it", async () => {
    const db = edb0();
    seed(db, { id: "gone", eligibility: "eligible" });
    const { registry, ctx } = harness(db);
    const before = un<{ results: Array<{ id: string }> }>(
      await registry.dispatch("work_search", {}, ctx()),
    );
    expect(before.results.map((r) => r.id)).toEqual(["gone"]);
    const res = un<{ forgotten: boolean }>(
      await registry.dispatch("work_forget", { episode_id: "gone" }, ctx()),
    );
    expect(res.forgotten).toBe(true);
    const after = un<{ results: Array<{ id: string }> }>(
      await registry.dispatch("work_search", {}, ctx()),
    );
    expect(after.results).toEqual([]);
    // idempotent second forget: no change, no error
    const again = un<{ forgotten: boolean }>(
      await registry.dispatch("work_forget", { episode_id: "gone" }, ctx()),
    );
    expect(again.forgotten).toBe(false);
  });

  it("THE-600: work_forget appends exactly one chained forget_log row, recording the caller", async () => {
    const db = edb0();
    seed(db, { id: "gone", eligibility: "eligible", caller: "tester" });
    const { registry, ctx } = harness(db);
    const res = un<{ forgotten: boolean }>(
      await registry.dispatch("work_forget", { episode_id: "gone" }, ctx()),
    );
    expect(res.forgotten).toBe(true);

    const rows = forgetLogRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "episode", target: "gone", mode: "tombstone" });
    expect(JSON.parse(rows[0]?.details ?? "{}")).toMatchObject({ actor: "tester" });
    // hash-chained per THE-239: verifyForgetLog recomputes the chain from genesis and must agree.
    expect(verifyForgetLog(db)).toEqual({ ok: true, entries: 1 });

    // repeat call on the now-blocked episode is a silent no-op — NO additional row (idempotency;
    // appending here would spam the chain and make replay indistinguishable from a real forget).
    const again = un<{ forgotten: boolean }>(
      await registry.dispatch("work_forget", { episode_id: "gone" }, ctx()),
    );
    expect(again.forgotten).toBe(false);
    expect(forgetLogRows(db)).toHaveLength(1);
  });

  it("THE-600: a foreign or unknown episode id writes no forget_log row", async () => {
    const db = edb0();
    seed(db, { id: "theirs", eligibility: "eligible", caller: "someone-else" });
    const { registry, ctx } = harness(db);

    const foreign = un<{ forgotten: boolean }>(
      await registry.dispatch("work_forget", { episode_id: "theirs" }, ctx()),
    );
    expect(foreign.forgotten).toBe(false);
    expect(forgetLogRows(db)).toHaveLength(0);

    const unknown = un<{ forgotten: boolean }>(
      await registry.dispatch("work_forget", { episode_id: "does-not-exist" }, ctx()),
    );
    expect(unknown.forgotten).toBe(false);
    expect(forgetLogRows(db)).toHaveLength(0);
  });

  it("THE-600: a failed forget_log append rolls back the tombstone (mirrors forgetEpisode's C1 atomicity)", async () => {
    const db = edb0();
    seed(db, { id: "gone", eligibility: "eligible", caller: "tester" });
    const { registry, ctx } = harness(db);
    db.exec("DROP TABLE forget_log"); // force appendForgetLog to throw mid-forget
    // dispatch() never rejects — a thrown, non-typed error is caught and returned as ok:false
    // (registry.ts's catch-all), not propagated. What matters for THE-600 is that the handler's
    // own transaction rolled back rather than leaving a tombstone with no audit row.
    const res = await registry.dispatch("work_forget", { episode_id: "gone" }, ctx());
    expect(res.ok).toBe(false);
    const row = db.prepare("SELECT blocked FROM agent_episodes WHERE id = 'gone'").get() as {
      blocked: number;
    };
    expect(row.blocked).toBe(0); // tombstone rolled back — never blocked without an audit row
  });

  it("record_retrieval_feedback stamps the latest retrieval event(s) for a chunk", async () => {
    const db = edb0();
    let t = NOW;
    const log = createRetrievalLogger(db, { now: () => t++ });
    log({
      queryText: "q1",
      surfaceType: "search_semantic",
      hits: [{ chunkId: "c1", rank: 1, score: 0.9 }],
    });
    log({
      queryText: "q2",
      surfaceType: "search_semantic",
      hits: [{ chunkId: "c1", rank: 1, score: 0.8 }],
    });
    const { registry, ctx } = harness(db);
    const res = un<{ updated: number }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1, feedback: 1 },
        // these retrievals have a NULL session -> the stamp is unscoped, which now needs
        // admin:workspace (P1.7). A per-session stamp is covered by the dedicated test below.
        ctx({ grantedScopes: new Set(["write:workspace", "admin:workspace"]) }),
      ),
    );
    expect(res.updated).toBe(1); // last_n defaults to 1 -> newest only
    const rows = db
      .prepare("SELECT query_text, feedback, outcome FROM chunk_retrievals ORDER BY retrieved_at")
      .all() as Array<{ query_text: string; feedback: number | null; outcome: number | null }>;
    expect(rows[0]).toMatchObject({ query_text: "q1", feedback: null, outcome: null });
    expect(rows[1]).toMatchObject({ query_text: "q2", feedback: 1, outcome: 1 });
  });

  it("P1.7: any_caller without admin:workspace is forbidden (partition is an authz boundary)", async () => {
    const db = edb0();
    seed(db, { id: "mine", eligibility: "eligible" });
    seed(db, { id: "theirs", eligibility: "eligible", caller: "someone-else" });
    const { registry, ctx } = harness(db);
    const denied = await registry.dispatch("work_search", { any_caller: true }, ctx());
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("forbidden");
    // work_episodes enforces the same gate
    const denied2 = await registry.dispatch("work_episodes", { any_caller: true }, ctx());
    expect(denied2.ok).toBe(false);
    if (!denied2.ok) expect(denied2.error.code).toBe("forbidden");
  });

  it("P1.7: work_forget is own-only unless admin:workspace (foreign id is a silent no-op)", async () => {
    const db = edb0();
    seed(db, { id: "theirs", eligibility: "eligible", caller: "someone-else" });
    const { registry, ctx } = harness(db);
    // non-owner without elevation: no rows changed, no existence oracle
    const noop = un<{ forgotten: boolean }>(
      await registry.dispatch("work_forget", { episode_id: "theirs" }, ctx()),
    );
    expect(noop.forgotten).toBe(false);
    // admin:workspace can forget across principals
    const ok = un<{ forgotten: boolean }>(
      await registry.dispatch(
        "work_forget",
        { episode_id: "theirs" },
        ctx({ grantedScopes: new Set(["write:workspace", "admin:workspace"]) }),
      ),
    );
    expect(ok.forgotten).toBe(true);
  });

  it("P1.7: record_retrieval_feedback needs a session or admin; scopes to the caller's session", async () => {
    const db = edb0();
    // caller "tester" matches harness()'s default ctx().caller — session AND caller both own it.
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller) VALUES ('r1', 'c1', ?, 's1', 'tester')",
    ).run(NOW);
    const { registry, ctx } = harness(db);
    // no session_id, no active session, not admin -> forbidden (was a silent unscoped write)
    const denied = await registry.dispatch(
      "record_retrieval_feedback",
      { chunk_id: "c1", outcome: 1 },
      ctx(),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("forbidden");
    // a caller with an active session stamps only that session's retrievals
    const ok = un<{ updated: number }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1 },
        ctx({ sessionId: "s1" }),
      ),
    );
    expect(ok.updated).toBe(1);
  });

  it("THE-568: record_retrieval_feedback is gated on per-caller ownership; admin:workspace crosses it", async () => {
    const db = edb0();
    // caller-a's retrieval, logged in a session that caller-b (a different principal) also shares —
    // isolates the caller check from the pre-existing session check.
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller) VALUES ('r-a', 'c1', ?, 's1', 'caller-a')",
    ).run(NOW);
    const { registry, ctx } = harness(db);

    // caller-b shares the session but does NOT own the retrieval -> 0 rows stamped, not forbidden
    // (mirrors work_forget's foreign-id no-op: no existence oracle).
    const foreign = un<{ updated: number }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1 },
        ctx({ caller: "caller-b", sessionId: "s1" }),
      ),
    );
    expect(foreign.updated).toBe(0);
    expect(
      (
        db.prepare("SELECT outcome FROM chunk_retrievals WHERE id = 'r-a'").get() as {
          outcome: number | null;
        }
      ).outcome,
    ).toBeNull();

    // caller-a, same session -> owns it, can stamp
    const own = un<{ updated: number }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1 },
        ctx({ caller: "caller-a", sessionId: "s1" }),
      ),
    );
    expect(own.updated).toBe(1);

    // reset, then prove admin:workspace crosses the caller partition (a foreign caller, no session)
    db.prepare("UPDATE chunk_retrievals SET outcome = NULL WHERE id = 'r-a'").run();
    const admin = un<{ updated: number }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: -1 },
        ctx({
          caller: "caller-b",
          grantedScopes: new Set(["write:workspace", "admin:workspace"]),
        }),
      ),
    );
    expect(admin.updated).toBe(1);
  });

  // THE-718. Measured on the live store 2026-08-03, and the two NULLs have DIFFERENT causes —
  // conflating them misreads the fix:
  //   * session_id is NULL on 97 of 97 retrieval events, because no client has ever opened a
  //     workspace session (THE-714). This is what the session narrowing collided with.
  //   * caller is NULL on 81 of 97 (populated on 16, all `cave-agents-main` from 2026-08-01),
  //     because the column postdates those rows — THE-568 added it on 2026-07-24. Nothing to do
  //     with sessions; it is why the ownership test below exists.
  // The session narrowing therefore excluded every row a real caller could own, so the only
  // principal that could stamp anything was admin:workspace — and a correctly-behaving client got
  // `{ updated: 0 }` with no error to say so.
  //
  // A retrieval logged outside any session belongs to no session, so there is no second session to
  // confuse it with; ownership is fully carried by `caller`. Rows that DO carry a session stay
  // scoped exactly as before — the two guard tests below are what keep this a narrowing of the
  // NULL case rather than a general relaxation.
  it("THE-718: a session-scoped caller can stamp its own session-less retrieval", async () => {
    const db = edb0();
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller) VALUES ('r1', 'c1', ?, NULL, 'tester')",
    ).run(NOW);
    const { registry, ctx } = harness(db);
    const res = un<{ updated: number }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1 },
        ctx({ sessionId: "s1" }),
      ),
    );
    expect(res.updated).toBe(1);
  });

  it("THE-718: reaching session-less rows does not cross the caller partition", async () => {
    const db = edb0();
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller) VALUES ('r-a', 'c1', ?, NULL, 'caller-a')",
    ).run(NOW);
    const { registry, ctx } = harness(db);
    const foreign = un<{ updated: number }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1 },
        ctx({ caller: "caller-b", sessionId: "s1" }),
      ),
    );
    expect(foreign.updated).toBe(0);
    expect(
      (
        db.prepare("SELECT outcome FROM chunk_retrievals WHERE id = 'r-a'").get() as {
          outcome: number | null;
        }
      ).outcome,
    ).toBeNull();
  });

  it("THE-718: a session-scoped stamp still cannot reach another session's rows", async () => {
    const db = edb0();
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller) VALUES ('r-s2', 'c1', ?, 's2', 'tester')",
    ).run(NOW);
    const { registry, ctx } = harness(db);
    const res = un<{ updated: number }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1 },
        ctx({ sessionId: "s1" }),
      ),
    );
    expect(res.updated).toBe(0);
  });

  // The silent half of the defect: `{ updated: 0 }` is the same response shape as a successful
  // stamp, so a caller cannot tell "recorded" from "matched nothing" without a second read.
  it("THE-718: a no-op says the caller owns rows for the chunk but none in scope", async () => {
    const db = edb0();
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller) VALUES ('r-s2', 'c1', ?, 's2', 'tester')",
    ).run(NOW);
    const { registry, ctx } = harness(db);
    const res = un<{ updated: number; reason?: string }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1 },
        ctx({ sessionId: "s1" }),
      ),
    );
    expect(res.updated).toBe(0);
    expect(res.reason).toBe("session_scope");
  });

  // The reason is computed over rows the caller ALREADY owns, so it can never become an existence
  // oracle: a foreign caller's chunk and a chunk that does not exist must be indistinguishable.
  it("THE-718: the no-op reason is not an existence oracle", async () => {
    const db = edb0();
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller) VALUES ('r-a', 'c1', ?, NULL, 'caller-a')",
    ).run(NOW);
    const { registry, ctx } = harness(db);
    const foreign = un<{ updated: number; reason?: string }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1 },
        ctx({ caller: "caller-b", sessionId: "s1" }),
      ),
    );
    const absent = un<{ updated: number; reason?: string }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "no-such-chunk", outcome: 1 },
        ctx({ caller: "caller-b", sessionId: "s1" }),
      ),
    );
    expect(foreign.reason).toBe("no_owned_retrievals");
    expect(absent.reason).toBe(foreign.reason);
  });

  // THE-718 follow-up, found by attacking the change rather than confirming it. `caller` is
  // `string | null` and a valid JWT with no `sub` claim yields `caller: null` with
  // `authenticated: true` (auth/jwt.ts:163,170 — `sub` is never required). The ownership clause is
  // `AND caller IS ?`, so such a principal matches every legacy NULL-caller row: 81 of 97 on the
  // live store. Widening the session clause is what made that reachable — before it, the session
  // mismatch masked it. Ownership requires being identifiable, so an unattributed principal is
  // refused outright rather than silently inheriting rows nobody produced.
  it("THE-718: an unidentifiable caller cannot claim unowned NULL-caller rows", async () => {
    const db = edb0();
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller) VALUES ('legacy', 'c1', ?, NULL, NULL)",
    ).run(NOW);
    const { registry, ctx } = harness(db);
    const denied = await registry.dispatch(
      "record_retrieval_feedback",
      { chunk_id: "c1", outcome: 1 },
      ctx({ caller: null, sessionId: "s1" }),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("forbidden");
    expect(
      (
        db.prepare("SELECT outcome FROM chunk_retrievals WHERE id = 'legacy'").get() as {
          outcome: number | null;
        }
      ).outcome,
    ).toBeNull();
  });

  it("THE-718: admin:workspace still reaches unowned NULL-caller rows", async () => {
    const db = edb0();
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller) VALUES ('legacy', 'c1', ?, NULL, NULL)",
    ).run(NOW);
    const { registry, ctx } = harness(db);
    const admin = un<{ updated: number }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1 },
        ctx({ caller: null, grantedScopes: new Set(["write:workspace", "admin:workspace"]) }),
      ),
    );
    expect(admin.updated).toBe(1);
  });

  it("THE-718: a successful stamp carries no reason", async () => {
    const db = edb0();
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller) VALUES ('r1', 'c1', ?, NULL, 'tester')",
    ).run(NOW);
    const { registry, ctx } = harness(db);
    const res = un<{ updated: number; reason?: string }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1 },
        ctx({ sessionId: "s1" }),
      ),
    );
    expect(res.updated).toBe(1);
    expect(res.reason).toBeUndefined();
  });
});

// THE-611 — gap_report: a read-only view over the persisted gap-detector pass (THE-644 item 1).
// NEVER calls detectGaps itself; only reads gap_reports back and applies the THE-563/564 read
// ACL to the `nearest` paths before returning them.
describe("gap_report (THE-611)", () => {
  it("reports unavailable without an open experiential handle", async () => {
    const { registry, ctx } = harness(undefined);
    const res = un<{ available: boolean }>(
      await registry.dispatch(
        "gap_report",
        { vault: "main" },
        ctx({ grantedScopes: new Set(["read:notes"]) }),
      ),
    );
    expect(res.available).toBe(false);
  });

  it("is denied without read:notes", async () => {
    const db = edb0();
    const { registry, ctx } = harness(db);
    const r = (await registry.dispatch(
      "gap_report",
      { vault: "main" },
      ctx({ grantedScopes: new Set([]) }),
    )) as { ok: boolean };
    expect(r.ok).toBe(false);
  });

  it("honest-empty: no pass ever persisted -> available, computed_at null, no items", async () => {
    const db = edb0();
    const { registry, ctx } = harness(db);
    const res = un<{
      available: boolean;
      computed_at: number | null;
      total: number;
      returned: number;
      items: unknown[];
    }>(
      await registry.dispatch(
        "gap_report",
        { vault: "main" },
        ctx({ grantedScopes: new Set(["read:notes"]) }),
      ),
    );
    expect(res.available).toBe(true);
    expect(res.computed_at).toBeNull();
    expect(res.total).toBe(0);
    expect(res.returned).toBe(0);
    expect(res.items).toEqual([]);
  });

  it("reads back the persisted pass: item order, gaps_only filter, and pass-level stats", async () => {
    const db = edb0();
    const report = await detectGaps(
      [
        { id: "q1", query: "covered" },
        { id: "q2", query: "gap" },
      ],
      singleQuerySearch(async (q) =>
        q === "covered" ? [{ path: "a.md", score: 0.9 }] : [{ path: "b.md", score: 0.001 }],
      ),
      { threshold: 0.1, minResults: 1 },
    );
    persistGapReport(db, report, { vaultId: "main", computedAt: 5_000 });
    const { registry, ctx } = harness(db);
    const c = ctx({ grantedScopes: new Set(["read:notes"]) });

    const full = un<{
      computed_at: number | null;
      total: number;
      gaps: number;
      returned: number;
      items: Array<{ id: string }>;
    }>(await registry.dispatch("gap_report", { vault: "main" }, c));
    expect(full.computed_at).toBe(5_000);
    expect(full.total).toBe(2);
    expect(full.gaps).toBe(1);
    expect(full.returned).toBe(2);
    expect(full.items.map((i) => i.id)).toEqual(["q1", "q2"]); // input order preserved

    const gapsOnly = un<{ returned: number; total: number; items: Array<{ id: string }> }>(
      await registry.dispatch("gap_report", { vault: "main", gaps_only: true }, c),
    );
    expect(gapsOnly.items.map((i) => i.id)).toEqual(["q2"]);
    expect(gapsOnly.returned).toBe(1);
    // pass-level `total` is unaffected by the gaps_only display filter — it still describes
    // the whole persisted pass, not just what gaps_only narrowed `items` down to.
    expect(gapsOnly.total).toBe(2);
  });

  it("THE-563/564: filters nearest paths the caller cannot read, without dropping the item", async () => {
    const db = edb0();
    const report = await detectGaps(
      [{ id: "q1", query: "mixed" }],
      singleQuerySearch(async () => [
        { path: "public/a.md", score: 0.5 },
        { path: "private/b.md", score: 0.4 },
      ]),
      { threshold: 0, minResults: 1, nearestN: 5 },
    );
    persistGapReport(db, report, { vaultId: "main", computedAt: 1_000 });
    const { registry, ctx } = harness(db);
    const readOnlyPublic = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["public/**"],
    });
    const res = un<{ items: Array<{ id: string; nearest: Array<{ path: string }> }> }>(
      await registry.dispatch(
        "gap_report",
        { vault: "main" },
        ctx({ grantedScopes: new Set(["read:notes"]), acl: readOnlyPublic }),
      ),
    );
    expect(res.items).toHaveLength(1); // the item survives...
    expect(res.items[0]?.nearest.map((n) => n.path)).toEqual(["public/a.md"]); // ...but private/ is gone
  });
});
