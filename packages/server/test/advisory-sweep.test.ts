// THE-634 — the scheduled proactive-advisory sweep. advisory-threshold.test.ts pins the ENGINE
// (scoreAgainstGoals / selectAdvisories) and states its own coverage boundary: "nothing here
// exercises DELIVERY." This file is what closes that boundary — the CALLER those functions never
// had, mirroring gap-sweep.test.ts's role for detectGaps.
//
// Three things this file proves that no other test does:
//
//   1. Scoring is per-vault, selection is per-session, and a sweep with nobody connected (or no
//      open goal) never touches the gateway — the same "empty pass costs nothing" discipline
//      gap-sweep.test.ts pins for its own sweep.
//   2. An emitted advisory becomes a REAL chunk_retrievals row that the REAL record_retrieval_
//      feedback tool (dispatched through the registry, not called as a bare function) can stamp a
//      dismissal onto — acceptance criterion 3 of the verified brief, exercised end to end.
//   3. Publish is best-effort: a session with no open stream still gets its emission recorded, and
//      calling publish never throws.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import type { AdvisoryPolicy } from "../src/experiential/advisory-policy";
import { remainingBudget } from "../src/experiential/advisory-policy";
import { setGoal } from "../src/experiential/goals";
import { createAdvisoryBus } from "../src/mcp/advisories";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { compileEgressFilter } from "../src/plane/egress-filter";
import {
  buildSimilarityFn,
  openContradictions,
  openSessions,
  recentNoteChanges,
  recentSyntheses,
  registerAdvisorySweep,
  sessionAdvisoryState,
} from "../src/runtime/advisory-sweep";
import { registerM8Tools } from "../src/tools/m8";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: read(file),
}));
const NOW = 1_700_000_000_000;
const V = "vault-one";

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

function cdb0(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function addChunk(
  cdb: Database,
  opts: { id: string; vaultId: string; path: string; content: string; updatedAt: number },
): void {
  cdb
    .prepare(
      `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
       VALUES (?, ?, ?, '0', '[]', ?, 'h', 1, ?, ?)`,
    )
    .run(opts.id, opts.vaultId, opts.path, opts.content, opts.updatedAt, opts.updatedAt);
}

function addContradiction(
  cdb: Database,
  opts: {
    id: string;
    vaultId: string;
    status?: string;
    rationale?: string;
    detectedAt: number;
    sourcePath?: string;
    conflictPath?: string;
  },
): void {
  cdb
    .prepare(
      `INSERT INTO contradictions
         (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path,
          source_content_sha, conflict_content_sha, judge_verdict, judge_rationale, status, detected_at)
       VALUES (?, ?, 'c1', ?, 'c2', ?, ?, ?, 'contradiction', ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.vaultId,
      opts.sourcePath ?? "a.md",
      opts.conflictPath ?? "b.md",
      `${opts.id}-a`,
      `${opts.id}-b`,
      opts.rationale ?? "they disagree",
      opts.status ?? "open",
      opts.detectedAt,
    );
}

function addSynthesis(
  cdb: Database,
  opts: {
    vaultId: string;
    isoYear: number;
    isoWeek: number;
    generatedAt: number;
    /** THE-934 fix round 3 (A): the raw `patterns` JSON, in synthesis.ts's real
     *  `SynthesisOutput["patterns"]` shape ({title, summary, evidence_paths, contradiction_ids}[])
     *  -- defaults to a shape with NO evidence_paths at all (a row this module cannot prove is
     *  safe), matching the pre-round-3 fixture's `{"note":"weekly pattern"}` placeholder in
     *  spirit: still not an array, still zero provable paths. */
    patterns?: string;
  },
): void {
  cdb
    .prepare(
      `INSERT INTO syntheses
         (vault_id, iso_year, iso_week, generated_at, cluster_count, pattern_count, clusters, patterns)
       VALUES (?, ?, ?, ?, 1, 1, '[]', ?)`,
    )
    .run(
      opts.vaultId,
      opts.isoYear,
      opts.isoWeek,
      opts.generatedAt,
      opts.patterns ?? '{"note":"weekly pattern"}',
    );
}

function addSession(
  cdb: Database,
  opts: { id: string; vaultId: string; principal: string | null; endedAt?: number | null },
): void {
  cdb
    .prepare(
      `INSERT INTO workspace_sessions
         (id, vault_id, caller, started_at, ended_at, trace_path, principal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.vaultId,
      opts.principal,
      NOW,
      opts.endedAt ?? null,
      `traces/${opts.id}`,
      opts.principal,
    );
}

/** Deterministic stub: exact-text lookup, so cosine similarity is hand-checkable rather than
 *  approximated. Separate query/document maps mirror the real asymmetry buildSimilarityFn relies
 *  on — a text present only under the "wrong" role returns the zero vector (norm 0), which
 *  cosineSimilarity treats as similarity 0 rather than throwing. */
function stubProvider(vectors: {
  query?: Record<string, number[]>;
  document?: Record<string, number[]>;
}): {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  embed: (texts: string[], opts?: { input?: "query" | "document" }) => Promise<number[][]>;
  calls: Array<{ texts: string[]; input?: string }>;
} {
  const calls: Array<{ texts: string[]; input?: string }> = [];
  return {
    id: "stub",
    provider: "stub",
    model: "stub",
    dimensions: 2,
    calls,
    embed: async (texts, opts) => {
      calls.push({ texts, input: opts?.input });
      const table = opts?.input === "query" ? (vectors.query ?? {}) : (vectors.document ?? {});
      return texts.map((t) => table[t] ?? [0, 0]);
    },
  };
}

const POLICY: AdvisoryPolicy = { minScore: 0.6, topK: 2, maxPerSession: 3, dismissalPenalty: 1 };

describe("openSessions", () => {
  it("returns only OPEN sessions for the given vault", () => {
    const cdb = cdb0();
    addSession(cdb, { id: "s1", vaultId: V, principal: "alice" });
    addSession(cdb, { id: "s2", vaultId: V, principal: "bob", endedAt: NOW }); // closed
    addSession(cdb, { id: "s3", vaultId: "other-vault", principal: "carol" }); // other vault
    expect(openSessions(cdb, V)).toEqual([{ id: "s1", vaultId: V, principal: "alice" }]);
  });
});

describe("candidate sources", () => {
  it("recentNoteChanges: vault-scoped, newest first, capped", () => {
    const cdb = cdb0();
    addChunk(cdb, { id: "c1", vaultId: V, path: "a.md", content: "old", updatedAt: NOW - 300 });
    addChunk(cdb, { id: "c2", vaultId: V, path: "b.md", content: "new", updatedAt: NOW });
    addChunk(cdb, {
      id: "c3",
      vaultId: "other",
      path: "z.md",
      content: "elsewhere",
      updatedAt: NOW,
    });
    const out = recentNoteChanges(cdb, V, 10);
    expect(out.map((c) => c.ref)).toEqual(["c2", "c1"]);
    expect(out[0]).toMatchObject({ kind: "note_changed", text: "b.md\nnew", at: NOW });
    expect(recentNoteChanges(cdb, V, 1)).toHaveLength(1);
  });

  it("openContradictions: open-status and vault-scoped only", () => {
    const cdb = cdb0();
    addContradiction(cdb, { id: "k1", vaultId: V, detectedAt: NOW });
    addContradiction(cdb, { id: "k2", vaultId: V, status: "resolved", detectedAt: NOW });
    addContradiction(cdb, { id: "k3", vaultId: "other", detectedAt: NOW });
    const out = openContradictions(cdb, V, 10);
    expect(out.map((c) => c.ref)).toEqual(["k1"]);
    expect(out[0]?.kind).toBe("contradiction");
  });

  it("recentSyntheses: vault-scoped, newest first", () => {
    const cdb = cdb0();
    addSynthesis(cdb, { vaultId: V, isoYear: 2026, isoWeek: 1, generatedAt: NOW - 10 });
    addSynthesis(cdb, { vaultId: V, isoYear: 2026, isoWeek: 2, generatedAt: NOW });
    addSynthesis(cdb, { vaultId: "other", isoYear: 2026, isoWeek: 3, generatedAt: NOW });
    const out = recentSyntheses(cdb, V, 10);
    expect(out.map((c) => c.ref)).toEqual(["synthesis-2026-2", "synthesis-2026-1"]);
  });
});

describe("sessionAdvisoryState", () => {
  it("derives emitted/dismissed/seenRefs from surface_type='advisory' rows only", () => {
    const edb = edb0();
    edb
      .prepare(
        "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, surface_type, feedback) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("r1", "cand-a", NOW, "s1", "advisory", null);
    edb
      .prepare(
        "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, surface_type, feedback) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("r2", "cand-b", NOW, "s1", "advisory", -1);
    // A REAL retrieval in the same session must not count toward the advisory budget.
    edb
      .prepare(
        "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, surface_type, feedback) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("r3", "cand-c", NOW, "s1", "graph_search", null);

    const state = sessionAdvisoryState(edb, "s1");
    expect(state.emitted).toBe(2);
    expect(state.dismissed).toBe(1);
    expect([...state.seenRefs].sort()).toEqual(["cand-a", "cand-b"]);
  });

  it("an unknown session has empty state, not an error", () => {
    expect(sessionAdvisoryState(edb0(), "nobody")).toEqual({
      emitted: 0,
      dismissed: 0,
      seenRefs: new Set(),
    });
  });
});

describe("buildSimilarityFn", () => {
  it("embeds goals with input:query and candidates with input:document, in two calls", async () => {
    const provider = stubProvider({
      query: { "ship the parser": [1, 0] },
      document: { "parser notes": [1, 0] },
    });
    const fn = await buildSimilarityFn(
      provider,
      [{ id: "g1", text: "ship the parser", status: "open" }],
      [{ kind: "note_changed", ref: "c1", path: "c1.md", text: "parser notes", at: NOW }],
    );
    expect(fn("ship the parser", "parser notes")).toBeCloseTo(1, 5);
    expect(provider.calls).toEqual([
      { texts: ["ship the parser"], input: "query" },
      { texts: ["parser notes"], input: "document" },
    ]);
  });

  it("returns a constant-zero function without any embed call when either side is empty", async () => {
    const provider = stubProvider({});
    const fn = await buildSimilarityFn(
      provider,
      [],
      [{ kind: "note_changed", ref: "c1", path: "c1.md", text: "x", at: 0 }],
    );
    expect(fn("anything", "anything")).toBe(0);
    expect(provider.calls).toEqual([]);
  });

  it("an unknown text pair scores 0 rather than throwing", async () => {
    const provider = stubProvider({ query: { g: [1, 0] }, document: { c: [1, 0] } });
    const fn = await buildSimilarityFn(
      provider,
      [{ id: "g1", text: "g", status: "open" }],
      [{ kind: "note_changed", ref: "c1", path: "c1.md", text: "c", at: 0 }],
    );
    expect(fn("never seen", "c")).toBe(0);
  });
});

describe("registerAdvisorySweep", () => {
  type Task = { name: string; intervalMs: number; run: (signal: AbortSignal) => unknown };
  function capture(): { task: Task | null } {
    return { task: null };
  }
  const fakeScheduler = (box: ReturnType<typeof capture>) =>
    ({
      register: (t: Task) => {
        box.task = t;
      },
    }) as never;
  const NOT_ABORTED = new AbortController().signal;

  it("registers under the name advisory-sweep, at the configured interval", () => {
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb0(),
      experientialDb: edb0(),
      provider: stubProvider({}) as never,
      vaultIds: [V],
      intervalMs: 3_600_000,
      policy: POLICY,
      publish: () => {},
      now: () => NOW,
    });
    expect(box.task?.name).toBe("advisory-sweep");
    expect(box.task?.intervalMs).toBe(3_600_000);
  });

  it("no open sessions: no embed call, nothing inserted, publish never called", async () => {
    const cdb = cdb0();
    addChunk(cdb, { id: "c1", vaultId: V, path: "a.md", content: "x", updatedAt: NOW });
    const edb = edb0();
    setGoal(edb, { id: "g1", vaultId: V, text: "ship the parser", createdAt: NOW });
    const provider = stubProvider({});
    const published: unknown[] = [];
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb,
      experientialDb: edb,
      provider: provider as never,
      vaultIds: [V],
      intervalMs: 1000,
      policy: POLICY,
      publish: (e) => published.push(e),
      now: () => NOW,
    });
    await box.task?.run(NOT_ABORTED);
    expect(provider.calls).toEqual([]);
    expect(published).toEqual([]);
    expect(edb.prepare("SELECT COUNT(*) AS n FROM chunk_retrievals").get()).toMatchObject({ n: 0 });
  });

  it("open session but no open goal: no embed call — relevance to nothing is not proactivity", async () => {
    const cdb = cdb0();
    addSession(cdb, { id: "s1", vaultId: V, principal: "alice" });
    addChunk(cdb, { id: "c1", vaultId: V, path: "a.md", content: "x", updatedAt: NOW });
    const provider = stubProvider({});
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb,
      experientialDb: edb0(),
      provider: provider as never,
      vaultIds: [V],
      intervalMs: 1000,
      policy: POLICY,
      publish: () => {},
      now: () => NOW,
    });
    await box.task?.run(NOT_ABORTED);
    expect(provider.calls).toEqual([]);
  });

  it("end to end: a relevant candidate is selected, inserted as an advisory row, and published", async () => {
    const cdb = cdb0();
    addSession(cdb, { id: "s1", vaultId: V, principal: "alice" });
    addChunk(cdb, { id: "hit", vaultId: V, path: "a.md", content: "relevant", updatedAt: NOW });
    addChunk(cdb, {
      id: "miss",
      vaultId: V,
      path: "b.md",
      content: "unrelated",
      updatedAt: NOW - 1,
    });
    const edb = edb0();
    setGoal(edb, { id: "g1", vaultId: V, text: "goal text", createdAt: NOW });
    const provider = stubProvider({
      query: { "goal text": [1, 0] },
      document: { "a.md\nrelevant": [1, 0], "b.md\nunrelated": [0, 1] },
    });
    const published: Array<{
      vaultId: string;
      caller: string | null;
      sessionId: string;
      advisories: ReadonlyArray<{ chunkId: string }>;
    }> = [];
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb,
      experientialDb: edb,
      provider: provider as never,
      vaultIds: [V],
      intervalMs: 1000,
      policy: POLICY,
      publish: (e) => published.push(e),
      now: () => NOW,
    });
    await box.task?.run(NOT_ABORTED);

    const rows = edb
      .prepare(
        "SELECT chunk_id, session_id, caller, surface_type, query_text, rerank_score FROM chunk_retrievals",
      )
      .all() as Array<{
      chunk_id: string;
      session_id: string;
      caller: string | null;
      surface_type: string;
      query_text: string;
      rerank_score: number;
    }>;
    expect(rows).toHaveLength(1); // "unrelated" scored 0 < minScore 0.6 — never inserted
    expect(rows[0]).toMatchObject({
      chunk_id: "hit",
      session_id: "s1",
      caller: "alice",
      surface_type: "advisory",
      query_text: "goal text",
    });
    expect(rows[0]?.rerank_score).toBeCloseTo(1, 5);

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ vaultId: V, caller: "alice", sessionId: "s1" });
    expect(published[0]?.advisories.map((a) => a.chunkId)).toEqual(["hit"]);
  });

  it("a session's own seenRefs are not re-surfaced on the next tick", async () => {
    const cdb = cdb0();
    addSession(cdb, { id: "s1", vaultId: V, principal: "alice" });
    addChunk(cdb, { id: "hit", vaultId: V, path: "a.md", content: "relevant", updatedAt: NOW });
    const edb = edb0();
    setGoal(edb, { id: "g1", vaultId: V, text: "goal text", createdAt: NOW });
    const provider = stubProvider({
      query: { "goal text": [1, 0] },
      document: { "a.md\nrelevant": [1, 0] },
    });
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb,
      experientialDb: edb,
      provider: provider as never,
      vaultIds: [V],
      intervalMs: 1000,
      policy: POLICY,
      publish: () => {},
      now: () => NOW,
    });
    await box.task?.run(NOT_ABORTED);
    await box.task?.run(NOT_ABORTED);
    expect(edb.prepare("SELECT COUNT(*) AS n FROM chunk_retrievals").get()).toMatchObject({ n: 1 });
  });

  it("publish is best-effort: calling it with no listeners never throws (createAdvisoryBus)", () => {
    const bus = createAdvisoryBus();
    expect(() =>
      bus.publish({ vaultId: V, caller: "alice", sessionId: "s1", advisories: [] }),
    ).not.toThrow();
  });

  // Acceptance criterion 3 (verified brief §8): the EXISTING record_retrieval_feedback tool,
  // dispatched through the registry exactly as a real client would call it, stamps a dismissal
  // onto an advisory-emitted row and the session's remaining budget reflects it on the next tick.
  it("THE-634 acceptance #3: record_retrieval_feedback stamps an advisory row; budget decays", async () => {
    const cdb = cdb0();
    addSession(cdb, { id: "s1", vaultId: V, principal: "alice" });
    addChunk(cdb, { id: "hit", vaultId: V, path: "a.md", content: "relevant", updatedAt: NOW });
    const edb = edb0();
    setGoal(edb, { id: "g1", vaultId: V, text: "goal text", createdAt: NOW });
    const provider = stubProvider({
      query: { "goal text": [1, 0] },
      document: { "a.md\nrelevant": [1, 0] },
    });
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb,
      experientialDb: edb,
      provider: provider as never,
      vaultIds: [V],
      intervalMs: 1000,
      policy: POLICY,
      publish: () => {},
      now: () => NOW,
    });
    await box.task?.run(NOT_ABORTED);

    const before = sessionAdvisoryState(edb, "s1");
    expect(remainingBudget(POLICY, before)).toBe(POLICY.maxPerSession - 1); // 1 emitted, 0 dismissed

    const registry = new ToolRegistry({});
    registerM8Tools(registry, { edb, now: () => NOW });
    const ctx: CallerContext = {
      caller: "alice",
      authenticated: true,
      grantedScopes: new Set(["write:workspace"]),
      vaultId: V,
      db: cdb,
      sessionId: "s1",
    };
    const result = (await registry.dispatch(
      "record_retrieval_feedback",
      { chunk_id: "hit", feedback: -1 },
      ctx,
    )) as { data: { updated: number } };
    expect(result.data.updated).toBe(1);

    const after = sessionAdvisoryState(edb, "s1");
    expect(after.dismissed).toBe(1);
    expect(remainingBudget(POLICY, after)).toBe(POLICY.maxPerSession - POLICY.dismissalPenalty - 1);
  });

  // THE-926: scheduler.ts passes its own AbortSignal to every job's run(signal), but this sweep
  // used to discard it — so stores.close() during a graceful shutdown could tear down the shared
  // connection while the sweep was mid-write. It must now bail BETWEEN vaults instead of pressing
  // on regardless.
  it("THE-926: stops sweeping further vaults once the signal is already aborted", async () => {
    const cdb = cdb0();
    addSession(cdb, { id: "s1", vaultId: V, principal: "alice" });
    addChunk(cdb, { id: "hit", vaultId: V, path: "a.md", content: "relevant", updatedAt: NOW });
    const edb = edb0();
    setGoal(edb, { id: "g1", vaultId: V, text: "goal text", createdAt: NOW });
    const provider = stubProvider({
      query: { "goal text": [1, 0] },
      document: { "a.md\nrelevant": [1, 0] },
    });
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb,
      experientialDb: edb,
      provider: provider as never,
      vaultIds: [V],
      intervalMs: 1000,
      policy: POLICY,
      publish: () => {},
      now: () => NOW,
    });
    const aborted = new AbortController();
    aborted.abort();
    await box.task?.run(aborted.signal);
    // The aborted run must not have scored this vault at all — an open session + open goal +
    // candidate are all present, so a non-aborted run would have.
    expect(provider.calls).toHaveLength(0);
    expect(edb.prepare("SELECT COUNT(*) AS n FROM chunk_retrievals").get()).toMatchObject({ n: 0 });
  });

  it("egress.excludePaths: an excluded note_changed candidate never reaches the embed port; a public one still scores (THE-934 fix round 2, N1)", async () => {
    const cdb = cdb0();
    addSession(cdb, { id: "s1", vaultId: V, principal: "alice" });
    addChunk(cdb, {
      id: "pub",
      vaultId: V,
      path: "Public/a.md",
      content: "relevant",
      updatedAt: NOW,
    });
    addChunk(cdb, {
      id: "priv",
      vaultId: V,
      path: "Private/b.md",
      content: "SECRET_MARKER relevant",
      updatedAt: NOW - 1,
    });
    const edb = edb0();
    setGoal(edb, { id: "g1", vaultId: V, text: "goal text", createdAt: NOW });
    const provider = stubProvider({
      query: { "goal text": [1, 0] },
      document: {
        "Public/a.md\nrelevant": [1, 0],
        "Private/b.md\nSECRET_MARKER relevant": [1, 0],
      },
    });
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb,
      experientialDb: edb,
      provider: provider as never,
      vaultIds: [V],
      intervalMs: 1000,
      policy: POLICY,
      publish: () => {},
      now: () => NOW,
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    await box.task?.run(NOT_ABORTED);

    // The port (provider.embed) never saw the excluded candidate's text at all.
    const documentCall = provider.calls.find((c) => c.input === "document");
    expect(documentCall?.texts).toEqual(["Public/a.md\nrelevant"]);
    expect(documentCall?.texts.join("\n")).not.toContain("SECRET_MARKER");

    // The result reports the skip: only the public chunk was ever inserted as an advisory.
    const rows = edb.prepare("SELECT chunk_id FROM chunk_retrievals").all() as Array<{
      chunk_id: string;
    }>;
    expect(rows).toEqual([{ chunk_id: "pub" }]);
  });

  it("a malformed note_changed candidate with a falsy path fails CLOSED (treated as excluded), not open (THE-934 fix round 2, NB2 follow-up)", async () => {
    // AdvisoryCandidate's discriminated union now REQUIRES `path` on every "note_changed" variant
    // (a pathless one is a type error at every construction site — see advisory.ts), but this
    // proves the runtime backstop too: if a malformed candidate ever reached the filter anyway
    // (e.g. a future producer built with an `as` cast, or — as simulated here — a chunk row with
    // an empty `path` column), it must be excluded, not silently treated as "not excluded" the way
    // the old `c.path ?? ""` fallback did (an empty string matches no real glob, so it used to
    // clear the filter).
    const cdb = cdb0();
    addSession(cdb, { id: "s1", vaultId: V, principal: "alice" });
    addChunk(cdb, {
      id: "pub",
      vaultId: V,
      path: "Public/a.md",
      content: "relevant",
      updatedAt: NOW,
    });
    // A chunk row with an empty path — pathological, but a real value SQLite will happily store —
    // simulating a malformed candidate reaching the exclusion filter with no usable path.
    addChunk(cdb, {
      id: "malformed",
      vaultId: V,
      path: "",
      content: "SECRET_MARKER relevant",
      updatedAt: NOW - 1,
    });
    const edb = edb0();
    setGoal(edb, { id: "g1", vaultId: V, text: "goal text", createdAt: NOW });
    const provider = stubProvider({
      query: { "goal text": [1, 0] },
      document: {
        "Public/a.md\nrelevant": [1, 0],
        "\nSECRET_MARKER relevant": [1, 0],
      },
    });
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb,
      experientialDb: edb,
      provider: provider as never,
      vaultIds: [V],
      intervalMs: 1000,
      policy: POLICY,
      publish: () => {},
      now: () => NOW,
      // ANY excludeFilter arms the fail-closed check — the malformed candidate has no pattern that
      // needs to match it; a missing path alone is disqualifying once filtering is active at all.
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    await box.task?.run(NOT_ABORTED);

    const documentCall = provider.calls.find((c) => c.input === "document");
    expect(documentCall?.texts).toEqual(["Public/a.md\nrelevant"]);
    expect(documentCall?.texts.join("\n")).not.toContain("SECRET_MARKER");
    const rows = edb.prepare("SELECT chunk_id FROM chunk_retrievals").all() as Array<{
      chunk_id: string;
    }>;
    expect(rows).toEqual([{ chunk_id: "pub" }]);
  });

  it("flag off (no excludeFilter): the SAME malformed pathless candidate is NOT dropped — 'no filter configured' must stay a true no-op, not a side-channel exclusion (THE-934 fix round 2, NB2 follow-up)", async () => {
    const cdb = cdb0();
    addSession(cdb, { id: "s1", vaultId: V, principal: "alice" });
    addChunk(cdb, {
      id: "malformed",
      vaultId: V,
      path: "",
      content: "unlabeled",
      updatedAt: NOW,
    });
    const edb = edb0();
    setGoal(edb, { id: "g1", vaultId: V, text: "goal text", createdAt: NOW });
    const provider = stubProvider({
      query: { "goal text": [1, 0] },
      document: { "\nunlabeled": [1, 0] },
    });
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb,
      experientialDb: edb,
      provider: provider as never,
      vaultIds: [V],
      intervalMs: 1000,
      policy: POLICY,
      publish: () => {},
      now: () => NOW,
      // No excludeFilter at all: `egress.excludePaths` is unconfigured, so nothing is excluded.
    });
    await box.task?.run(NOT_ABORTED);

    const documentCall = provider.calls.find((c) => c.input === "document");
    expect(documentCall?.texts).toEqual(["\nunlabeled"]);
    const rows = edb.prepare("SELECT chunk_id FROM chunk_retrievals").all() as Array<{
      chunk_id: string;
    }>;
    expect(rows).toEqual([{ chunk_id: "malformed" }]);
  });

  it("egress.excludePaths: a contradiction candidate touching an excluded path never reaches the embed port (THE-934 fix round 3, A)", async () => {
    const cdb = cdb0();
    addSession(cdb, { id: "s1", vaultId: V, principal: "alice" });
    addContradiction(cdb, {
      id: "k1",
      vaultId: V,
      sourcePath: "Private/journal.md",
      conflictPath: "Public/other.md",
      rationale: "SECRET_MARKER private rationale",
      detectedAt: NOW,
    });
    const edb = edb0();
    setGoal(edb, { id: "g1", vaultId: V, text: "goal text", createdAt: NOW });
    const provider = stubProvider({ query: { "goal text": [1, 0] } });
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb,
      experientialDb: edb,
      provider: provider as never,
      vaultIds: [V],
      intervalMs: 1000,
      policy: POLICY,
      publish: () => {},
      now: () => NOW,
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    await box.task?.run(NOT_ABORTED);

    // Either no document call happened at all (the only candidate was excluded), or one happened
    // and its texts never carried the private path or rationale.
    const documentCall = provider.calls.find((c) => c.input === "document");
    expect(documentCall?.texts.join("\n") ?? "").not.toContain("SECRET_MARKER");
    expect(documentCall?.texts.join("\n") ?? "").not.toContain("Private/journal.md");
    expect(edb.prepare("SELECT COUNT(*) AS n FROM chunk_retrievals").get()).toMatchObject({
      n: 0,
    });
  });

  it("egress.excludePaths: a synthesis candidate whose evidence_paths touch an excluded path never reaches the embed port (THE-934 fix round 3, A)", async () => {
    const cdb = cdb0();
    addSession(cdb, { id: "s1", vaultId: V, principal: "alice" });
    addSynthesis(cdb, {
      vaultId: V,
      isoYear: 2026,
      isoWeek: 1,
      generatedAt: NOW,
      patterns: JSON.stringify([
        {
          title: "SECRET_MARKER pattern",
          summary: "a private pattern",
          evidence_paths: ["Private/journal.md"],
          contradiction_ids: [],
        },
      ]),
    });
    const edb = edb0();
    setGoal(edb, { id: "g1", vaultId: V, text: "goal text", createdAt: NOW });
    const provider = stubProvider({ query: { "goal text": [1, 0] } });
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb,
      experientialDb: edb,
      provider: provider as never,
      vaultIds: [V],
      intervalMs: 1000,
      policy: POLICY,
      publish: () => {},
      now: () => NOW,
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    await box.task?.run(NOT_ABORTED);

    const documentCall = provider.calls.find((c) => c.input === "document");
    expect(documentCall?.texts.join("\n") ?? "").not.toContain("SECRET_MARKER");
    expect(edb.prepare("SELECT COUNT(*) AS n FROM chunk_retrievals").get()).toMatchObject({
      n: 0,
    });
  });

  it("a synthesis row with NO parseable evidence_paths fails CLOSED (excluded) once a filter is configured — a row this module cannot prove safe is never embedded merely because it also cannot be proven excluded (THE-934 fix round 3, A)", async () => {
    const cdb = cdb0();
    addSession(cdb, { id: "s1", vaultId: V, principal: "alice" });
    // The pre-round-3 fixture default: `patterns` is not an array at all, so
    // synthesisEvidencePaths yields [] -- no provenance provable.
    addSynthesis(cdb, { vaultId: V, isoYear: 2026, isoWeek: 1, generatedAt: NOW });
    const edb = edb0();
    setGoal(edb, { id: "g1", vaultId: V, text: "goal text", createdAt: NOW });
    const provider = stubProvider({ query: { "goal text": [1, 0] } });
    const box = capture();
    registerAdvisorySweep(fakeScheduler(box), {
      cacheDb: cdb,
      experientialDb: edb,
      provider: provider as never,
      vaultIds: [V],
      intervalMs: 1000,
      policy: POLICY,
      publish: () => {},
      now: () => NOW,
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    await box.task?.run(NOT_ABORTED);

    expect(provider.calls.some((c) => c.input === "document")).toBe(false);
    expect(edb.prepare("SELECT COUNT(*) AS n FROM chunk_retrievals").get()).toMatchObject({
      n: 0,
    });
  });
});
