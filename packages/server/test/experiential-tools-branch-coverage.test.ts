// THE-602 — branch-coverage top-up for src/tools/m8/experiential-tools.ts. Each test asserts a
// caller-visible behavior (a returned value, a filtered result set, an error code) rather than
// merely executing a branch. See test/m8-experiential-tools.test.ts for the primary THE-229/
// THE-568/P1.7 contract tests this file supplements — it deliberately covers filter combinations
// and edge legs (null caller, missing edb per-tool, real-clock fallback, note_quality_report) that
// file does not exercise.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM8Tools } from "../src/tools/m8";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
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
  tags?: string | null;
}

function seed(db: Database, e: Ep) {
  db.prepare(
    `INSERT INTO agent_episodes (id, ts, vault_id, session_id, caller, channel, episode_type,
       tool, status, eligibility, trust, blocked, valid_from, valid_until, summary, tags)
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
    e.tags ?? null,
  );
}

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

// `withNow: false` omits the `now` dep entirely so the tool falls back to the real Date.now()
// (line 145's `deps.now ?? Date.now`), rather than always installing a fixed clock.
function harness(edb?: Database, opts: { withNow?: boolean } = {}) {
  const registry = new ToolRegistry({});
  const withNow = opts.withNow ?? true;
  registerM8Tools(registry, { ...(edb ? { edb } : {}), ...(withNow ? { now: () => NOW } : {}) });
  const cache = cacheDb0();
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["read:workspace", "write:workspace", "read:notes"]),
    vaultId: "main",
    db: cache,
    ...over,
  });
  return { registry, ctx };
}

function noteQualityRow(
  db: Database,
  over: Partial<{
    vault_id: string;
    path: string;
    computed_at: number;
    flags: string;
    quality_score: number | null;
  }>,
) {
  db.prepare(
    `INSERT INTO note_quality (vault_id, path, computed_at, flags, quality_score)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    over.vault_id ?? "main",
    over.path ?? "note.md",
    over.computed_at ?? NOW,
    over.flags ?? "[]",
    over.quality_score ?? null,
  );
}

describe("THE-602 branch coverage: experiential-tools.ts", () => {
  it("every m8 tool (not just work_search) reports unavailable without an open edb", async () => {
    const { registry, ctx } = harness(undefined);
    const search = un<{ available: boolean }>(await registry.dispatch("work_search", {}, ctx()));
    const episodes = un<{ available: boolean }>(
      await registry.dispatch("work_episodes", {}, ctx()),
    );
    const forget = un<{ available: boolean }>(
      await registry.dispatch("work_forget", { episode_id: "x" }, ctx()),
    );
    const feedback = un<{ available: boolean }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1 },
        ctx({ sessionId: "s1" }),
      ),
    );
    const quality = un<{ available: boolean }>(
      await registry.dispatch("note_quality_report", { vault: "main" }, ctx()),
    );
    expect(search.available).toBe(false);
    expect(episodes.available).toBe(false);
    expect(forget.available).toBe(false);
    expect(feedback.available).toBe(false);
    expect(quality.available).toBe(false);
  });

  it("projectEpisode's tag parser: an array survives, a non-array JSON value becomes []", async () => {
    const db = edb0();
    seed(db, { id: "arr-tags", tags: JSON.stringify(["a", "b"]) });
    seed(db, { id: "obj-tags", tags: JSON.stringify({ not: "an array" }) });
    const { registry, ctx } = harness(db);
    const res = un<{ results: Array<{ id: string; tags: string[] }> }>(
      await registry.dispatch("work_search", {}, ctx()),
    );
    const byId = Object.fromEntries(res.results.map((r) => [r.id, r.tags]));
    expect(byId["arr-tags"]).toEqual(["a", "b"]);
    expect(byId["obj-tags"]).toEqual([]);
  });

  it("without a `now` dep, expiry falls back to the real clock (Date.now), not a fixed clock", async () => {
    const db = edb0();
    const realNow = Date.now();
    seed(db, { id: "still-valid", valid_until: realNow + 60_000 });
    seed(db, { id: "expired", valid_until: realNow - 60_000 });
    const { registry, ctx } = harness(db, { withNow: false });
    const res = un<{ results: Array<{ id: string }> }>(
      await registry.dispatch("work_search", {}, ctx()),
    );
    expect(res.results.map((r) => r.id)).toEqual(["still-valid"]);
  });

  it("work_search: a caller with no principal (null) is partitioned to caller IS NULL rows", async () => {
    const db = edb0();
    seed(db, { id: "anon-ep", caller: null });
    seed(db, { id: "tester-ep", caller: "tester" });
    const { registry, ctx } = harness(db);
    const res = un<{ results: Array<{ id: string }> }>(
      await registry.dispatch("work_search", {}, ctx({ caller: null })),
    );
    expect(res.results.map((r) => r.id)).toEqual(["anon-ep"]);
  });

  it("work_episodes: a caller with no principal (null) is partitioned to caller IS NULL rows", async () => {
    const db = edb0();
    seed(db, { id: "anon-ep", caller: null, eligibility: "pending" });
    seed(db, { id: "tester-ep", caller: "tester", eligibility: "pending" });
    const { registry, ctx } = harness(db);
    const res = un<{ episodes: Array<{ id: string }> }>(
      await registry.dispatch("work_episodes", {}, ctx({ caller: null })),
    );
    expect(res.episodes.map((e) => e.id)).toEqual(["anon-ep"]);
  });

  it("work_search: tool/session_id/since/until/query filters each narrow the result set", async () => {
    const db = edb0();
    seed(db, { id: "match-tool", tool: "vault_search" });
    seed(db, { id: "other-tool", tool: "read_note" });
    seed(db, { id: "match-session", session_id: "s-target" });
    seed(db, { id: "other-session", session_id: "s-other" });
    seed(db, { id: "early", ts: NOW - 10_000 });
    seed(db, { id: "late", ts: NOW + 10_000 });
    seed(db, { id: "match-query", summary: "unique-marker-xyz" });
    seed(db, { id: "no-query-match", summary: "irrelevant" });
    const { registry, ctx } = harness(db);

    const byTool = un<{ results: Array<{ id: string }> }>(
      await registry.dispatch("work_search", { tool: "vault_search" }, ctx()),
    );
    expect(byTool.results.map((r) => r.id)).toEqual(["match-tool"]);

    const bySession = un<{ results: Array<{ id: string }> }>(
      await registry.dispatch("work_search", { session_id: "s-target" }, ctx()),
    );
    expect(bySession.results.map((r) => r.id)).toEqual(["match-session"]);

    const bySince = un<{ results: Array<{ id: string }> }>(
      await registry.dispatch("work_search", { since: NOW }, ctx()),
    );
    expect(bySince.results.map((r) => r.id).sort()).toEqual(
      [
        "late",
        "match-query",
        "match-session",
        "match-tool",
        "no-query-match",
        "other-session",
        "other-tool",
      ].sort(),
    );
    expect(bySince.results.map((r) => r.id)).not.toContain("early");

    const byUntil = un<{ results: Array<{ id: string }> }>(
      await registry.dispatch("work_search", { until: NOW - 1 }, ctx()),
    );
    expect(byUntil.results.map((r) => r.id)).toEqual(["early"]);

    const byQuery = un<{ results: Array<{ id: string }> }>(
      await registry.dispatch("work_search", { query: "unique-marker-xyz" }, ctx()),
    );
    expect(byQuery.results.map((r) => r.id)).toEqual(["match-query"]);
  });

  it("work_episodes: session_id/tool/status/since/until filters each narrow the result set", async () => {
    const db = edb0();
    seed(db, { id: "match-session", session_id: "s-target", eligibility: "pending" });
    seed(db, { id: "other-session", session_id: "s-other", eligibility: "pending" });
    seed(db, { id: "match-tool", tool: "vault_search", eligibility: "pending" });
    seed(db, { id: "other-tool", tool: "read_note", eligibility: "pending" });
    seed(db, { id: "errored", status: "error", eligibility: "pending" });
    seed(db, { id: "okay", status: "ok", eligibility: "pending" });
    seed(db, { id: "early", ts: NOW - 10_000, eligibility: "pending" });
    seed(db, { id: "late", ts: NOW + 10_000, eligibility: "pending" });
    const { registry, ctx } = harness(db);

    const bySession = un<{ episodes: Array<{ id: string }> }>(
      await registry.dispatch("work_episodes", { session_id: "s-target" }, ctx()),
    );
    expect(bySession.episodes.map((e) => e.id)).toEqual(["match-session"]);

    const byTool = un<{ episodes: Array<{ id: string }> }>(
      await registry.dispatch("work_episodes", { tool: "vault_search" }, ctx()),
    );
    expect(byTool.episodes.map((e) => e.id)).toEqual(["match-tool"]);

    const byStatus = un<{ episodes: Array<{ id: string }> }>(
      await registry.dispatch("work_episodes", { status: "error" }, ctx()),
    );
    expect(byStatus.episodes.map((e) => e.id)).toEqual(["errored"]);

    const bySince = un<{ episodes: Array<{ id: string }> }>(
      await registry.dispatch("work_episodes", { since: NOW }, ctx()),
    );
    expect(bySince.episodes.map((e) => e.id)).not.toContain("early");
    expect(bySince.episodes.map((e) => e.id)).toContain("late");

    const byUntil = un<{ episodes: Array<{ id: string }> }>(
      await registry.dispatch("work_episodes", { until: NOW - 1 }, ctx()),
    );
    expect(byUntil.episodes.map((e) => e.id)).toEqual(["early"]);
  });

  it("work_forget: a null-caller episode is forgettable by a null-caller principal, and the log records a null actor", async () => {
    const db = edb0();
    seed(db, { id: "anon-ep", caller: null });
    const { registry, ctx } = harness(db);
    const res = un<{ forgotten: boolean }>(
      await registry.dispatch("work_forget", { episode_id: "anon-ep" }, ctx({ caller: null })),
    );
    expect(res.forgotten).toBe(true);
    const row = db.prepare("SELECT details FROM forget_log WHERE target = 'anon-ep'").get() as {
      details: string;
    };
    expect(JSON.parse(row.details)).toMatchObject({ actor: null });
  });

  it("record_retrieval_feedback: feedback-only (outcome omitted) leaves outcome untouched via COALESCE", async () => {
    const db = edb0();
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller, outcome) VALUES ('r1', 'c1', ?, 's1', 'tester', 1)",
    ).run(NOW);
    const { registry, ctx } = harness(db);
    const res = un<{ updated: number }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", feedback: -1 },
        ctx({ sessionId: "s1" }),
      ),
    );
    expect(res.updated).toBe(1);
    const row = db
      .prepare("SELECT feedback, outcome FROM chunk_retrievals WHERE id = 'r1'")
      .get() as { feedback: number; outcome: number };
    expect(row.feedback).toBe(-1);
    expect(row.outcome).toBe(1); // untouched: COALESCE(NULL, outcome) keeps the prior value
  });

  it("record_retrieval_feedback: a null-caller principal stamps only null-caller retrievals it owns", async () => {
    const db = edb0();
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller) VALUES ('r-anon', 'c1', ?, 's1', NULL)",
    ).run(NOW);
    const { registry, ctx } = harness(db);
    const res = un<{ updated: number }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1 },
        ctx({ caller: null, sessionId: "s1" }),
      ),
    );
    expect(res.updated).toBe(1);
    const row = db.prepare("SELECT outcome FROM chunk_retrievals WHERE id = 'r-anon'").get() as {
      outcome: number;
    };
    expect(row.outcome).toBe(1);
  });

  it("note_quality_report: flags filter narrows results; omitting flags returns everything", async () => {
    const db = edb0();
    noteQualityRow(db, { path: "dup.md", flags: JSON.stringify(["duplicate"]) });
    noteQualityRow(db, { path: "clean.md", flags: "[]" });
    const { registry, ctx } = harness(db);

    const filtered = un<{ notes: Array<{ path: string }> }>(
      await registry.dispatch(
        "note_quality_report",
        { vault: "main", flags: ["duplicate"] },
        ctx(),
      ),
    );
    expect(filtered.notes.map((n) => n.path)).toEqual(["dup.md"]);

    const all = un<{ notes: Array<{ path: string }> }>(
      await registry.dispatch("note_quality_report", { vault: "main" }, ctx()),
    );
    expect(all.notes.map((n) => n.path).sort()).toEqual(["clean.md", "dup.md"]);
  });

  it("note_quality_report: computed_at surfaces the rollup's timestamp, or null for an empty/never-computed vault", async () => {
    const db = edb0();
    noteQualityRow(db, { vault_id: "main", computed_at: 12345 });
    const { registry, ctx } = harness(db);

    const populated = un<{ computed_at: number | null; count: number }>(
      await registry.dispatch("note_quality_report", { vault: "main" }, ctx()),
    );
    expect(populated.computed_at).toBe(12345);
    expect(populated.count).toBe(1);

    const empty = un<{ computed_at: number | null; count: number }>(
      await registry.dispatch("note_quality_report", { vault: "other-vault" }, ctx()),
    );
    expect(empty.computed_at).toBeNull();
    expect(empty.count).toBe(0);
  });
});
