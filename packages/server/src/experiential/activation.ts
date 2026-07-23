// ACT-R activation recompute — THE-227. Turns the append-only chunk_retrievals log into a
// cached_activation_score per chunk in vault_object_state, so bubble_safe_rerank (graph_search) is
// no longer inert. ACT-R base-level learning: a chunk's activation rises with how RECENTLY and how
// OFTEN it was retrieved, and decays with time. Runs offline (obsidian-tc activation-recompute) over
// the experiential store; the retrieval-LOGGING half (writing chunk_retrievals on each retrieval) is
// a separate slice, so until that lands this recompute is a no-op over an empty log.
import type { Database } from "../db/types";
import type { Scheduler } from "../scheduler/scheduler";

const MS_PER_DAY = 86_400_000;
const MIN_DELTA_DAYS = 1 / 24; // floor a just-now access at 1 hour so t^-d stays finite
const DEFAULT_DECAY = 0.5; // ACT-R base-level decay d

export interface RetrievalEvent {
  /** ms epoch. */
  retrieved_at: number;
  /** Relevance: -1 | 0 | +1 (nullable) — "was this the right chunk". */
  feedback?: number | null;
  /** THE-230 outcome axis: -1 | 0 | +1 (nullable) — "did acting on it lead somewhere good".
   *  Folded multiplicatively with feedback, same bounded halving/doubling. */
  outcome?: number | null;
}

/**
 * ACT-R base-level activation for one chunk, mapped to [0,1] for bubble_safe_rerank.
 *
 *   B = ln( Σ_j w_j * (Δdays_j)^-d ),  Δdays_j = max((now - t_j)/day, 1h)
 *   activation = sigmoid(B) = 1 / (1 + e^-B)
 *
 * More recent + more frequent retrievals raise B. `sigmoid` maps B -> (0,1) with 0.5 at B=0 (a
 * single access exactly 1 day ago), matching bubble_safe_rerank's 0.5 = inert 1.0x. No events ->
 * 0.5 (cold start). Negative feedback halves an event's weight, positive doubles it; the
 * THE-230 outcome axis folds the same way multiplicatively (bounded w ∈ [0.25, 4]).
 */
export function actrActivation(
  events: RetrievalEvent[],
  now: number,
  opts: { decay?: number; staleFloor?: boolean } = {},
): number {
  if (events.length === 0) return 0.5;
  const d = opts.decay ?? DEFAULT_DECAY;
  let sum = 0;
  let negativeEvidence = false;
  for (const e of events) {
    const days = Math.max((now - e.retrieved_at) / MS_PER_DAY, MIN_DELTA_DAYS);
    const wFeedback = e.feedback === -1 ? 0.5 : e.feedback === 1 ? 2 : 1;
    const wOutcome = e.outcome === -1 ? 0.5 : e.outcome === 1 ? 2 : 1;
    if (e.feedback === -1 || e.outcome === -1) negativeEvidence = true;
    sum += wFeedback * wOutcome * days ** -d;
  }
  if (sum <= 0) return 0.5;
  const raw = 1 / (1 + Math.exp(-Math.log(sum)));
  // THE-193 stale-floor DECISION: clamp at 0.5 (neutral). Time alone never demotes a chunk
  // below never-retrieved — without the floor, one old retrieval ranks BELOW no retrieval at
  // all, a perverse ordering. Explicit negative evidence (feedback/outcome = -1) may still
  // demote below neutral: the outcome axis stays live. staleFloor: false preserves the raw
  // ACT-R curve for research runs.
  if ((opts.staleFloor ?? true) && raw < 0.5 && !negativeEvidence) return 0.5;
  return raw;
}

/**
 * THE-187: serve-side activation lookup over an OPEN experiential.db handle — a prepared
 * point read of cached_activation_score per chunk id (PK lookup, ~top-K calls per query).
 * Returns null when the chunk has no state (bubble pass stays inert for it) and never
 * throws: a read failure degrades to inert, not to a broken search.
 */
export function makeActivationLookup(edb: Database): (chunkId: string) => number | null {
  const stmt = edb.prepare(
    "SELECT cached_activation_score AS s FROM vault_object_state WHERE object_id = ?",
  );
  return (chunkId) => {
    try {
      const row = stmt.get(chunkId) as { s: number | null } | undefined;
      return row?.s ?? null;
    } catch {
      return null;
    }
  };
}

export interface ActivationRecomputeStats {
  chunks: number;
}

// THE-461: the append-only chunk_retrievals log has a monotonic rowid, so the max rowid already
// folded into the cached scores is a race-free watermark. Stored one-row in activation_state
// (migration 20260723_001). Absent table (pre-migration db) -> incremental degrades to a full pass.
function hasActivationState(edb: Database): boolean {
  return (
    edb
      .prepare(
        "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'activation_state'",
      )
      .get() !== undefined
  );
}

function readWatermark(edb: Database): number {
  const r = edb.prepare("SELECT watermark FROM activation_state WHERE id = 1").get() as
    | { watermark: number }
    | undefined;
  return r?.watermark ?? 0;
}

/**
 * Recompute cached_activation_score, writing it (plus frequency + last_accessed + last_computed_at)
 * into vault_object_state. Idempotent; a chunk with no events is left untouched.
 *
 * THE-461: `incremental` recomputes ONLY chunks with retrieval events past the persisted watermark —
 * reading their FULL history (the exact ACT-R sum needs every reference; it is power-law and not
 * time-separable, so no running aggregate can stand in). A chunk with no new events keeps its cached
 * score from the pass that last saw it — accepted, since activation is a bounded, dark-by-default
 * tie-break; run a full pass (the default, e.g. the CLI command) to refresh every chunk to `now`. The
 * watermark seeds at 0, so the first pass is always full. `incremental` on a pre-migration db (no
 * activation_state) falls back to full.
 */
export function recomputeActivation(
  edb: Database,
  now: number,
  opts: { decay?: number; incremental?: boolean } = {},
): ActivationRecomputeStats {
  const trackWatermark = hasActivationState(edb);
  const incremental = opts.incremental === true && trackWatermark;
  const watermark = incremental ? readWatermark(edb) : 0;

  // Full pass reads the whole log; incremental reads only the events of chunks that have ANY event
  // past the watermark (their full history — every reference is needed for the exact ACT-R sum).
  const rows = (
    incremental
      ? edb
          .prepare(
            "SELECT chunk_id, retrieved_at, feedback, outcome FROM chunk_retrievals WHERE chunk_id IN (SELECT DISTINCT chunk_id FROM chunk_retrievals WHERE rowid > ?) ORDER BY chunk_id",
          )
          .all(watermark)
      : edb
          .prepare(
            "SELECT chunk_id, retrieved_at, feedback, outcome FROM chunk_retrievals ORDER BY chunk_id",
          )
          .all()
  ) as Array<{
    chunk_id: string;
    retrieved_at: number;
    feedback: number | null;
    outcome: number | null;
  }>;

  const byChunk = new Map<string, RetrievalEvent[]>();
  for (const r of rows) {
    const list = byChunk.get(r.chunk_id) ?? [];
    list.push({ retrieved_at: r.retrieved_at, feedback: r.feedback, outcome: r.outcome });
    byChunk.set(r.chunk_id, list);
  }
  const upsert = edb.prepare(
    "INSERT INTO vault_object_state (object_id, cached_activation_score, last_computed_at, frequency, last_accessed) VALUES (?, ?, ?, ?, ?) ON CONFLICT(object_id) DO UPDATE SET cached_activation_score = excluded.cached_activation_score, last_computed_at = excluded.last_computed_at, frequency = excluded.frequency, last_accessed = excluded.last_accessed",
  );
  // The new head to record — capture BEFORE the transaction so a concurrent append is not claimed as
  // processed. On an empty log MAX(rowid) is NULL -> keep the old watermark.
  const head = trackWatermark
    ? ((edb.prepare("SELECT MAX(rowid) AS m FROM chunk_retrievals").get() as { m: number | null })
        .m ?? watermark)
    : 0;

  edb.exec("BEGIN");
  try {
    for (const [chunkId, events] of byChunk) {
      const activation = actrActivation(events, now, opts);
      const lastAccessed = events.reduce((m, e) => Math.max(m, e.retrieved_at), 0);
      upsert.run(chunkId, activation, now, events.length, lastAccessed);
    }
    // Advance the watermark in the SAME transaction as the score writes, so a crash never records
    // events as processed whose scores were rolled back.
    if (trackWatermark) {
      edb.prepare("UPDATE activation_state SET watermark = ? WHERE id = 1").run(head);
    }
    edb.exec("COMMIT");
  } catch (err) {
    edb.exec("ROLLBACK");
    throw err;
  }
  return { chunks: byChunk.size };
}

/** Deps for the periodic serve-path activation recompute (registerActivationRecompute). */
export interface ActivationRecomputeDeps {
  edb: Database;
  intervalMs: number;
  now?: () => number;
  decay?: number;
  onRecompute?: (stats: ActivationRecomputeStats) => void;
  onError?: (e: unknown) => void;
}

/**
 * THE-227/228: recomputeActivation is otherwise CLI-only (activation-recompute), so on the serve
 * path cached_activation_score would freeze at whatever a one-off manual run left, going stale the
 * moment new retrievals land. Registering this job keeps it warm as capture accrues, so the bubble
 * pass (dark behind activationRerank) and the eval A/B read current scores.
 *
 * THE-462: registered as a job on a SHARED scheduler (the production path — one unref'd timer for
 * all background work, so stdio EOF still exits). The run body is unchanged: idempotent and cheap
 * (one scan of chunk_retrievals + upserts into vault_object_state, no gateway), and a failing run
 * routes to onError without escaping so capture continues regardless.
 */
export function registerActivationRecompute(
  scheduler: Scheduler,
  deps: ActivationRecomputeDeps,
): void {
  scheduler.register({
    name: "activation-recompute",
    intervalMs: deps.intervalMs,
    run: () => {
      // THE-461: the timer runs INCREMENTALLY (only chunks with events past the watermark) so the
      // periodic recompute no longer rescans the whole log while competing with interactive dispatch.
      // The first pass after boot is a full one (watermark seeds at 0); the CLI command stays full.
      const stats = recomputeActivation(deps.edb, (deps.now ?? Date.now)(), {
        incremental: true,
        ...(deps.decay !== undefined ? { decay: deps.decay } : {}),
      });
      deps.onRecompute?.(stats);
    },
    onError: (e) => deps.onError?.(e),
  });
}
