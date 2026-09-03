// THE-634 — the scheduled proactive-advisory sweep.
//
// `scoreAgainstGoals` / `selectAdvisories` (PR #779, experiential/advisory.ts +
// experiential/advisory-policy.ts) had exactly one caller: their own test suite, which says so in
// its own header ("nothing here exercises DELIVERY"). Eighteen tests pinned the engine — precision
// over recall, never a digest, a hard rate limit that decays on dismissal — and nothing ever ran
// it. `listGoals` had the same shape one layer up (THE-633: the store shipped, nothing read it).
// This module is the caller both were missing, the same role gap-sweep.ts (THE-719) fills for
// `detectGaps`.
//
// THREE THINGS THIS FILE EXISTS TO GET RIGHT:
//
//   1. Scoring is PER VAULT, selection is PER SESSION. Relevance to a goal does not depend on who
//      is connected, but the interrupt BUDGET (advisory-policy.ts's AdvisorySessionState) is a
//      per-session resource — two sessions in the same vault must not silently share one budget,
//      and a vault nobody is connected to has nobody to compute a budget for at all (the sweep
//      exits before touching the gateway when `openSessions` is empty).
//   2. Session state is DERIVED, not stored. Every advisory this sweep ever selected for a session
//      lives as a chunk_retrievals row (surface_type = 'advisory'); `sessionAdvisoryState` rebuilds
//      `emitted` / `dismissed` / `seenRefs` from that log on every tick, so nothing is lost across a
//      restart and there is no second place session state can drift from the log a dismissal
//      actually updates (record_retrieval_feedback / feedback-scope.ts, unmodified by this ticket).
//   3. Delivery is BEST-EFFORT and NEVER blocks the emission it announces. The chunk_retrievals row
//      is the durable record — inserted regardless of whether anything is listening — and `publish`
//      (an AdvisoryBus.publish, mcp/advisories.ts) is a notification on top of it. A legacy-era
//      session (production's LiteLLM-fronted majority, docs/MCP-COMPATIBILITY.md) simply never has
//      an open stream, so publish silently reaches nobody for it — documented, not hidden.
import { randomUUID } from "node:crypto";
import type { Database } from "../db/types";
import type { EmbeddingProvider } from "../embeddings";
import {
  type AdvisoryCandidate,
  type AdvisoryGoal,
  type ScoredAdvisory,
  type SimilarityFn,
  scoreAgainstGoals,
} from "../experiential/advisory";
import {
  type AdvisoryPolicy,
  type AdvisorySessionState,
  selectAdvisories,
} from "../experiential/advisory-policy";
import { listGoals } from "../experiential/goals";
import type { AdvisoryBus, AdvisoryPushItem } from "../mcp/advisories";
import { type EgressFilter, isExcludedPath } from "../plane/egress-filter";
import type { Scheduler } from "../scheduler/scheduler";
import { cosineSimilarity } from "../search/native";
import { stderrOnError } from "../util/errors";

/** The one value that means "this row is a push, not a retrieval" — shared with activation.ts's
 *  exclusion filter and with the acceptance test that proves it holds. */
export const ADVISORY_SURFACE_TYPE = "advisory";

/** Per-source cap, hardcoded rather than configured: the ticket's config surface (§5 of the
 *  verified brief) names exactly five keys — enabled, minScore, topK, maxPerSession,
 *  dismissalPenalty — and a sixth cost knob was not part of what PR #779 deferred. 20 mirrors
 *  gap-sweep's default maxQueries order of magnitude for a single scheduled pass. */
const CANDIDATES_PER_SOURCE = 20;

export interface OpenSession {
  id: string;
  vaultId: string;
  /** workspace_sessions.principal — the server-OBSERVED identity, never the caller-supplied
   *  `caller` column. This is what a later record_retrieval_feedback call's `ctx.caller` will be
   *  compared against (feedback-scope.ts's `AND caller IS ?`), so it is the only value that makes
   *  the emitted chunk_retrievals row stampable by the session that actually owns it. */
  principal: string | null;
}

/** Sessions currently open in this vault (cache.db's workspace_sessions — see workspace/sessions.ts).
 *  A sweep with nobody connected has nobody to compute a budget for or publish to, which is the
 *  first and cheapest exit this job takes on a quiet vault. */
export function openSessions(cacheDb: Database, vaultId: string): OpenSession[] {
  return (
    cacheDb
      .prepare(
        "SELECT id, vault_id AS vaultId, principal FROM workspace_sessions WHERE vault_id = ? AND ended_at IS NULL",
      )
      .all(vaultId) as Array<{ id: string; vaultId: string; principal: string | null }>
  ).map((r) => ({ id: r.id, vaultId: r.vaultId, principal: r.principal }));
}

/** Candidate source 1: recently-changed notes, read from the AUTHORED chunk table (cache.db) —
 *  every indexed change (whether from the watcher or an explicit index_vault) lands here with an
 *  `updated_at`, so this needs no live hook into the watcher's callback stream. `content` is
 *  already chunker-bounded (~512 tokens), so no further truncation is applied. */
export function recentNoteChanges(
  cacheDb: Database,
  vaultId: string,
  limit: number,
): AdvisoryCandidate[] {
  const rows = cacheDb
    .prepare(
      "SELECT id, path, content, updated_at FROM chunks WHERE vault_id = ? ORDER BY updated_at DESC LIMIT ?",
    )
    .all(vaultId, limit) as Array<{
    id: string;
    path: string;
    content: string;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    kind: "note_changed",
    ref: r.id,
    // THE-934 fix round 2 (N1): the real vault path, distinct from `ref` (a chunk id) — see
    // AdvisoryCandidate's doc comment for why this field exists.
    path: r.path,
    text: `${r.path}\n${r.content}`,
    at: r.updated_at,
  }));
}

/** Candidate source 2: open contradictions (cache.db's `contradictions`, vault-scoped since
 *  20260724_001). Mirrors the read shape synthesis.ts and retrieval-runtime.ts already use for
 *  the same table. */
export function openContradictions(
  cacheDb: Database,
  vaultId: string,
  limit: number,
): AdvisoryCandidate[] {
  const rows = cacheDb
    .prepare(
      `SELECT id, source_path, conflict_path, judge_rationale, detected_at FROM contradictions
       WHERE vault_id = ? AND status = 'open' ORDER BY detected_at DESC LIMIT ?`,
    )
    .all(vaultId, limit) as Array<{
    id: string;
    source_path: string;
    conflict_path: string;
    judge_rationale: string | null;
    detected_at: number;
  }>;
  return rows.map((r) => ({
    kind: "contradiction",
    ref: r.id,
    text: `${r.source_path} vs ${r.conflict_path}: ${r.judge_rationale ?? ""}`,
    at: r.detected_at,
  }));
}

/** Candidate source 3: recent weekly syntheses (cache.db's `syntheses`). `patterns` is a JSON blob
 *  (synthesis.ts's own shape) rather than prose; fed to the embedder as-is — domain terms inside
 *  it still carry similarity signal, and a first-cut sweep does not need a bespoke JSON-to-text
 *  projection to be useful. */
export function recentSyntheses(
  cacheDb: Database,
  vaultId: string,
  limit: number,
): AdvisoryCandidate[] {
  const rows = cacheDb
    .prepare(
      `SELECT iso_year, iso_week, generated_at, patterns FROM syntheses
       WHERE vault_id = ? ORDER BY generated_at DESC LIMIT ?`,
    )
    .all(vaultId, limit) as Array<{
    iso_year: number;
    iso_week: number;
    generated_at: number;
    patterns: string;
  }>;
  return rows.map((r) => ({
    kind: "synthesis",
    ref: `synthesis-${r.iso_year}-${r.iso_week}`,
    text: r.patterns,
    at: r.generated_at,
  }));
}

/**
 * Session-level advisory state, DERIVED from the chunk_retrievals log rather than stored anywhere
 * new — the same design choice the ticket makes for the dismissal signal itself. `emitted` is
 * every advisory row this session has ever received (surface_type = 'advisory'); `dismissed` is
 * how many of those carry a negative stamp; `seenRefs` is their chunk_ids, so `selectAdvisories`
 * never re-surfaces one. Persists across ticks and restarts by construction — there is nothing
 * else to lose.
 */
export function sessionAdvisoryState(edb: Database, sessionId: string): AdvisorySessionState {
  const rows = edb
    .prepare(
      "SELECT chunk_id, feedback FROM chunk_retrievals WHERE session_id = ? AND surface_type = ?",
    )
    .all(sessionId, ADVISORY_SURFACE_TYPE) as Array<{
    chunk_id: string;
    feedback: number | null;
  }>;
  const seenRefs = new Set<string>();
  let dismissed = 0;
  for (const r of rows) {
    seenRefs.add(r.chunk_id);
    // applyFeedback's own rule, applied identically here: only feedback < 0 costs budget.
    if ((r.feedback ?? 0) < 0) dismissed++;
  }
  return { emitted: rows.length, dismissed, seenRefs };
}

/**
 * Build the SYNCHRONOUS SimilarityFn `scoreAgainstGoals` takes, from ONE precomputed embedding
 * batch per role. Goals and candidates are embedded with DIFFERENT `input` roles ("query" /
 * "document") because that is the asymmetry the rest of retrieval already relies on
 * (search/semantic.ts, gap-sweep's makeGapBatchSearch) — collapsing them to one role would silently
 * disagree with what an eval measures, exactly the drift this module's header warns against
 * reimplementing. Two calls, not four-per-candidate: cost stays O(vaults), not O(candidates).
 */
export async function buildSimilarityFn(
  provider: EmbeddingProvider,
  goals: readonly AdvisoryGoal[],
  candidates: readonly AdvisoryCandidate[],
): Promise<SimilarityFn> {
  if (goals.length === 0 || candidates.length === 0) return () => 0;
  const goalVecs = await provider.embed(
    goals.map((g) => g.text),
    { input: "query" },
  );
  const candidateVecs = await provider.embed(
    candidates.map((c) => c.text),
    {
      input: "document",
      // THE-934 fix round 2 (N1, narrowed in the NB2 follow-up): the egress guard's backstop
      // check. `path` (not `ref` — a chunk id, never a glob match) is the real vault path for
      // "note_changed" candidates, now REQUIRED by AdvisoryCandidate's discriminated union rather
      // than an optional field a `?? fallback` could silently paper over; the caller
      // (registerAdvisorySweep below) has already dropped any excluded (or malformed) one before
      // this runs. A "contradiction"/"synthesis" candidate carries no `path` field at all — its
      // `ref` is a derived-row id, never a vault path — so it falls through to `ref` here purely
      // as a stable non-empty placeholder string, not as something the filter is expected to match
      // against.
      sourcePaths: candidates.map((c) => (c.kind === "note_changed" ? c.path : c.ref)),
    },
  );
  const goalVecByText = new Map(goals.map((g, i) => [g.text, goalVecs[i]]));
  // Document side converts to Float32Array once at map build — the native cosine requires it
  // (native.ts contract); the goal side stays number[] per the same signature.
  const candidateVecByText = new Map(
    candidates.map((c, i) => {
      const v = candidateVecs[i];
      return [c.text, v ? Float32Array.from(v) : undefined] as const;
    }),
  );
  return (goalText, candidateText) => {
    const a = goalVecByText.get(goalText);
    const b = candidateVecByText.get(candidateText);
    if (!a || !b) return 0;
    return cosineSimilarity(a, b);
  };
}

function insertAdvisoryRow(
  edb: Database,
  opts: {
    chunkId: string;
    sessionId: string;
    caller: string | null;
    at: number;
    queryText: string;
    rank: number;
    rerankScore: number;
  },
): void {
  edb
    .prepare(
      `INSERT INTO chunk_retrievals
         (id, chunk_id, retrieved_at, session_id, caller, surface_type, query_text, rank_in_results, rerank_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      opts.chunkId,
      opts.at,
      opts.sessionId,
      opts.caller,
      ADVISORY_SURFACE_TYPE,
      opts.queryText,
      opts.rank,
      opts.rerankScore,
    );
}

function toPushItems(selected: readonly ScoredAdvisory[]): AdvisoryPushItem[] {
  return selected.map((a) => ({
    chunkId: a.candidate.ref,
    goalId: a.goalId,
    goalText: a.goalText,
    score: a.score,
    candidateKind: a.candidate.kind,
  }));
}

export interface AdvisorySweepDeps {
  cacheDb: Database;
  experientialDb: Database;
  provider: EmbeddingProvider;
  vaultIds: string[];
  intervalMs: number;
  policy: AdvisoryPolicy;
  /** THE-634: best-effort publish into the advisory push extension (mcp/advisories.ts). A bus with
   *  no open stream for a given (vault, caller) is a silent no-op by construction — see that
   *  module's own header. */
  publish: AdvisoryBus["publish"];
  /** Injected for tests; production passes nothing and gets Date.now. */
  now?: () => number;
  /** THE-934 fix round 1 (I3): egress.excludePaths, compiled. Undefined -> nothing excluded. A
   *  "note_changed" candidate under an excluded path is dropped before it can become embed
   *  input — this sweep runs on a SCHEDULE with no human in the loop reviewing it. */
  excludeFilter?: EgressFilter;
}

/**
 * Register the sweep. The caller decides whether to call this at all — gated on
 * `experiential.proactive.enabled`, which defaults FALSE (see the config schema's own comment for
 * why this is a precision decision, not only a cost one).
 *
 * Per vault: exits before any gateway call when nobody is connected (no open sessions) or there is
 * no goal to be relevant to (open goals empty — "relevance to the last query is not proactivity, it
 * is caching," the ticket's own line, is what a candidate list with no goal anchor would collapse
 * into). Scoring runs ONCE per vault; selection (and therefore delivery) runs once per open session,
 * since the interrupt budget is a per-session resource.
 */
export function registerAdvisorySweep(scheduler: Scheduler, deps: AdvisorySweepDeps): void {
  const now = deps.now ?? Date.now;
  scheduler.register({
    name: "advisory-sweep",
    intervalMs: deps.intervalMs,
    run: async (signal) => {
      for (const vaultId of deps.vaultIds) {
        // THE-926: cooperate with graceful shutdown between vaults — same cheap per-iteration
        // check job-runner.ts uses; a vault already mid-sweep still finishes.
        if (signal.aborted) return;
        const sessions = openSessions(deps.cacheDb, vaultId);
        if (sessions.length === 0) continue;

        const goals = listGoals(deps.experientialDb, vaultId); // defaults to status: "open"
        if (goals.length === 0) continue;

        const excludeFilter = deps.excludeFilter;
        const allCandidates: AdvisoryCandidate[] = [
          ...recentNoteChanges(deps.cacheDb, vaultId, CANDIDATES_PER_SOURCE),
          ...openContradictions(deps.cacheDb, vaultId, CANDIDATES_PER_SOURCE),
          ...recentSyntheses(deps.cacheDb, vaultId, CANDIDATES_PER_SOURCE),
        ];
        // THE-934 fix round 1 (I3), corrected in fix round 2 (N1), narrowed further in a
        // follow-up (NB2): a "note_changed" candidate under an excluded path is dropped BEFORE it
        // can become embed input — the chokepoint every other assembler uses. Round 1 checked
        // `c.ref`, which is the chunk id (a content hash) for "note_changed", never a glob match —
        // the filter was silently inert. Round 2 fixed that by checking `c.path`, but `path` was
        // still an OPTIONAL field with a `?? ""` fallback here — fail-OPEN if a malformed
        // candidate ever reached this code without one (an empty string matches no real glob).
        // `path` is now REQUIRED by AdvisoryCandidate's discriminated union for every "note_changed"
        // candidate, so a missing path is a type error at every construction site; this filter
        // additionally fails CLOSED (treats it as excluded) on a falsy `path` that somehow reaches
        // here anyway (e.g. a future producer built with an `as` cast), rather than silently
        // treating "no path" as "not excluded". contradiction/synthesis candidates carry no `path`
        // field at all, so the filter never touches them.
        const candidates =
          excludeFilter === undefined
            ? allCandidates
            : allCandidates.filter((c) => {
                if (c.kind !== "note_changed") return true;
                if (!c.path) return false; // fail CLOSED on a malformed/pathless candidate
                return !isExcludedPath(excludeFilter, c.path);
              });
        if (candidates.length === 0) continue;

        const similarity = await buildSimilarityFn(deps.provider, goals, candidates);
        const ranked = scoreAgainstGoals(goals, candidates, similarity);
        if (ranked.length === 0) continue;

        const at = now();
        for (const session of sessions) {
          const state = sessionAdvisoryState(deps.experientialDb, session.id);
          const selected = selectAdvisories(ranked, deps.policy, state);
          if (selected.length === 0) continue;

          selected.forEach((advisory, i) => {
            insertAdvisoryRow(deps.experientialDb, {
              chunkId: advisory.candidate.ref,
              sessionId: session.id,
              caller: session.principal,
              at,
              queryText: advisory.goalText,
              rank: i + 1,
              rerankScore: advisory.score,
            });
          });

          // Best-effort, deliberately AFTER the durable insert above: delivery may reach nobody,
          // but the chunk_retrievals row it announces must exist regardless (see this file's
          // header, point 3).
          deps.publish({
            vaultId,
            caller: session.principal,
            sessionId: session.id,
            advisories: toPushItems(selected),
          });
        }
      }
    },
    onError: stderrOnError("advisory-sweep"),
  });
}
