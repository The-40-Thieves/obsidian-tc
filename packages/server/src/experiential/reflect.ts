// THE-222 — reflect's sleep-time half: the evaluator pass over pending agent_episodes and the
// versioned preference profile. This is the selective-addition stamp THE-228 designed for
// (rows are born 'pending'; retrieval-USE waits for this pass) plus THE-238's layer 2
// (A-MemGuard-style cross-episode consistency) and the ACE typed-delta constraint folded from
// THE-232 (preference updates are add/strengthen/weaken/retract with counters — never a
// monolithic profile regeneration).
//
// Safety invariants, in order:
//   * born-'ineligible' rows (the poison scanner's verdict) are NEVER raised here;
//   * THE-701: there is NO judge layer. It was removed 2026-08-02 after measurement, not on
//     principle. Over 333 candidates it denied 35 rows, ALL of them status=error and nothing else
//     — 100% of its effect was reproducing `status === "error"`, at 94.6% fidelity with zero false
//     positives on ok rows. That directly contradicted this file's own policy below ("errors are
//     lessons too"), and because the judge could only LOWER it won every disagreement silently.
//     It also could not have been doing its stated job: every episode had summary IS NULL, so it
//     saw only id/tool/status while being asked to detect manipulative content. That job is
//     already done deterministically and EARLIER — assessPoison() runs at capture and stamps a
//     high-risk row 'ineligible' at birth (episodes.ts:184), which this pass's WHERE never sees.
//     deterministic promotions stand (same kill-switch posture as citation inference);
//   * unstable evidence — the same caller+tool+args_hash showing BOTH ok and error among the
//     pending set — is held pending rather than promoted (contradictory runs are not a lesson
//     yet, they are noise or an attack surface).
//   * THE-565: an episode the system has already judged a BAD outcome (`outcome = -1`) is held
//     pending, never auto-promoted — a known-negative-outcome row must not enter the eligible
//     pool as a default lesson. This is the one place the deterministic pass consults the outcome
//     axis. NOTE the deliberate asymmetry: a `status = 'error'` dispatch with NO bad outcome
//     still promotes ("errors are lessons too" — a forbidden delete teaches a boundary); it is
//     the explicit -1 outcome, not a failed dispatch, that we refuse. `status`/`skipped` are
//     otherwise unchanged.
//
//     THE-721: this gate is CORRECT, TESTED and INERT. An earlier version of this comment said
//     the -1 was "stamped by the citation / session-close outcome pass". No such writer exists,
//     and none ever did: `agent_episodes` has seven write statements across the tree and not one
//     of them sets `outcome`, so the column is NULL on 363 of 363 live rows. The citation pass
//     stamps `chunk_retrievals` columns only, and there is no session-close outcome pass —
//     sessions.ts and session-tools.ts never touch the column. The same false claim is frozen
//     into migration 20260711_001's header, which is checksum-pinned and cannot be corrected in
//     place; THE-721 carries it.
//
//     The consequence is bounded rather than dangerous: an unreachable HOLD is more permissive
//     than designed, not less, and there is no known-bad set to leak because nothing marks one.
//     reflect-evaluator.test.ts:96 seeds `outcome: -1` directly and asserts the hold, so the gate
//     is ready the moment a producer exists. Whether to build one is the open question on THE-721.
import type { Database } from "../db/types";
import { type GatewayRoles, prompt } from "../plane/gateway";
import type { Scheduler } from "../scheduler/scheduler";

export interface EvaluateStats {
  scanned: number;
  promoted: number;
  held: number;
  denied: number;
}

interface PendingRow {
  id: string;
  caller: string | null;
  tool: string | null;
  status: string;
  args_hash: string | null;
  summary: string | null;
  /** THE-230 outcome axis (-1 | 0 | +1 | null). -1 (known-bad) is held; see the invariants. */
  outcome: number | null;
}

/**
 * THE-698 — the deterministic hold rules, as ONE derivation.
 *
 * Extracted so `readEpisodeBacklog` can answer "how many pending rows would this pass promote?"
 * WITHOUT promoting anything. That question is what a health check actually needs: a pending row is
 * not evidence the evaluator is broken — held rows are supposed to stay pending forever, and on the
 * live store four contradictory `index_vault` episodes do exactly that. A count of pending rows
 * therefore cannot distinguish "the evaluator has never run" from "the evaluator ran and correctly
 * held these", and a check built on that count warns forever on a healthy deployment. Measured: it
 * did, immediately after the live promotion left 333 eligible and 4 legitimately held.
 *
 * Deliberately shared rather than reimplemented in the checker. Two copies of these predicates
 * would drift, and the drift would be silent in exactly the direction that matters — a checker
 * that thinks fewer rows are promotable than the evaluator does reports healthy while the tier
 * goes dark again.
 *
 * Layer 2 (cross-episode consistency): the same caller+tool+args_hash yielding BOTH ok and error
 * among the pending set is unstable evidence, so every row of that cluster is held. Plus THE-565:
 * a known-bad outcome (-1) is held. A plain `status = 'error'` with no bad-outcome stamp still
 * promotes — errors are lessons too.
 */
export function partitionPending(pending: PendingRow[]): {
  candidates: PendingRow[];
  held: number;
} {
  const statusesByKey = new Map<string, Set<string>>();
  const keyOf = (r: PendingRow): string | null =>
    r.args_hash ? `${r.caller ?? ""}\u0000${r.tool ?? ""}\u0000${r.args_hash}` : null;
  for (const r of pending) {
    const k = keyOf(r);
    if (!k) continue;
    let s = statusesByKey.get(k);
    if (!s) {
      s = new Set();
      statusesByKey.set(k, s);
    }
    s.add(r.status);
  }
  const unstable = (r: PendingRow): boolean => {
    const k = keyOf(r);
    if (!k) return false;
    const s = statusesByKey.get(k);
    return s?.has("ok") === true && s.has("error");
  };
  const candidates: PendingRow[] = [];
  let held = 0;
  for (const r of pending) {
    if (unstable(r) || r.outcome === -1) held++;
    else candidates.push(r);
  }
  return { candidates, held };
}

/** Evaluator pass: pending -> eligible under the deterministic rules. Ineligible rows are
 *  untouchable by construction (the WHERE) — assessPoison stamps those at capture, before this
 *  pass exists. THE-701 removed the judge layer; see the file header for the measurement. */
export async function evaluateEpisodes(
  edb: Database,
  opts: { nowMs: number },
): Promise<EvaluateStats> {
  const pending = edb
    .prepare(
      `SELECT id, caller, tool, status, args_hash, summary, outcome FROM agent_episodes
       WHERE eligibility = 'pending' AND blocked = 0
         AND (valid_until IS NULL OR valid_until > ?)
       ORDER BY ts ASC`,
    )
    .all(opts.nowMs) as PendingRow[];
  const stats: EvaluateStats = {
    scanned: pending.length,
    promoted: 0,
    held: 0,
    denied: 0,
  };
  if (pending.length === 0) return stats;

  const { candidates, held } = partitionPending(pending);
  stats.held = held;

  const promote = edb.prepare(
    "UPDATE agent_episodes SET eligibility = 'eligible' WHERE id = ? AND eligibility = 'pending'",
  );
  // `denied` is retained and stays 0 here. Nothing in this pass denies any more: the only source of
  // 'ineligible' is assessPoison at capture time (episodes.ts:184), which this WHERE never selects.
  // Kept in the stats shape because doctor's experiential.evaluator signal and the reflect CLI both
  // read it, and because a future deterministic deny rule belongs in this counter rather than a new
  // one.
  for (const r of candidates) {
    promote.run(r.id);
    stats.promoted++;
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Preference profile — versioned, delta-updated (the ACE constraint).

export interface PreferenceDelta {
  key: string;
  op: "add" | "strengthen" | "weaken" | "retract";
  value?: string;
  evidence?: string;
}

const WEIGHT_CAP = 5;
const WEIGHT_STEP = 0.5;

function tableReady(edb: Database): boolean {
  return (
    edb
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='preference_profile'")
      .get() !== undefined
  );
}

/** Apply typed deltas as ONE versioned batch. Never regenerates: rows not named by a delta are
 *  untouched, retraction zeroes the weight but keeps the row (readers filter weight > 0). */
// NAMESPACE (THE-710, revising the P1.8 / audit-THE-562 disposition): the preference plane is now
// partitioned BY VAULT — `(vault_id, key)` is the primary key and every statement below is scoped.
// It was previously keyed by `key` alone, deliberately, on the rationale that a single-user runtime
// wants one shared profile. That rationale does not extend to a single-VAULT assumption: with two
// vaults configured, one vault's learned preference silently overwrote the other's under the same
// key, with no column to filter on (the THE-310 defect class). Migration 20260803_001 rebuilt both
// tables; its header carries the full reasoning.
//
// THE CALLER AXIS IS STILL GLOBAL, and that remains deliberate: within a vault, deltas from any
// caller update the one shared profile. That residual is documented in SECURITY.md ("Learned-state
// namespaces" + "Known limitations") and closing it needs the P1.7 authorization treatment
// agent_episodes got. Contrast: agent_episodes is per-principal (vault+caller+session,
// P1.7-authorized); vault_object_state ACT-R activation is corpus-global by design.
//
// `vaultId` is REQUIRED and deliberately undefaulted. A default would let a call site silently fall
// back to one shared bucket, which is the exact behaviour this partition exists to remove — and an
// added-with-a-default parameter turns every existing caller into a caller of the default.
export function applyPreferenceDeltas(
  edb: Database,
  vaultId: string,
  deltas: PreferenceDelta[],
  nowMs: number,
): { version: number; applied: number } {
  if (!tableReady(edb)) throw new Error("preference_profile tables missing (run migrations)");
  // Version is PER-VAULT. A global counter would make one vault's batch bump the other's version
  // number, so `version` would no longer describe the profile it is stored on.
  const prev = edb
    .prepare(
      "SELECT MAX(v) AS v FROM (SELECT MAX(version) AS v FROM preference_deltas WHERE vault_id = ? UNION ALL SELECT MAX(version) AS v FROM preference_profile WHERE vault_id = ?)",
    )
    .get(vaultId, vaultId) as { v: number | null };
  const version = (prev.v ?? 0) + 1;
  const logDelta = edb.prepare(
    "INSERT INTO preference_deltas (vault_id, ts, key, op, value, evidence, version) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const upsertAdd = edb.prepare(
    `INSERT INTO preference_profile (vault_id, key, value, weight, version, updated_at, provenance)
     VALUES (?, ?, ?, 1.0, ?, ?, ?)
     ON CONFLICT(vault_id, key) DO UPDATE SET
       weight = MIN(${WEIGHT_CAP}, weight + ${WEIGHT_STEP}),
       value = COALESCE(excluded.value, preference_profile.value),
       version = excluded.version, updated_at = excluded.updated_at`,
  );
  const bump = edb.prepare(
    `UPDATE preference_profile SET weight = MIN(${WEIGHT_CAP}, weight + ${WEIGHT_STEP}), version = ?, updated_at = ? WHERE vault_id = ? AND key = ?`,
  );
  const damp = edb.prepare(
    `UPDATE preference_profile SET weight = MAX(0, weight - ${WEIGHT_STEP}), version = ?, updated_at = ? WHERE vault_id = ? AND key = ?`,
  );
  const retract = edb.prepare(
    "UPDATE preference_profile SET weight = 0, version = ?, updated_at = ? WHERE vault_id = ? AND key = ?",
  );
  let applied = 0;
  for (const d of deltas) {
    if (!d.key) continue;
    // strengthen/weaken/retract are UPDATE ... WHERE vault_id = ? AND key = ? — on a key that was
    // never added IN THIS VAULT they change 0 rows. Gate the audit row + `applied` on an actual
    // mutation so a judge proposing a delta for a non-existent key can't log a phantom
    // preference_deltas row or bump the version.
    let changed = 1;
    if (d.op === "add")
      upsertAdd.run(vaultId, d.key, d.value ?? "", version, nowMs, d.evidence ?? null);
    else if (d.op === "strengthen")
      changed = bump.run(version, nowMs, vaultId, d.key).changes as number;
    else if (d.op === "weaken")
      changed = damp.run(version, nowMs, vaultId, d.key).changes as number;
    else if (d.op === "retract")
      changed = retract.run(version, nowMs, vaultId, d.key).changes as number;
    else continue;
    if (changed === 0) continue;
    logDelta.run(vaultId, nowMs, d.key, d.op, d.value ?? null, d.evidence ?? null, version);
    applied++;
  }
  return { version, applied };
}

/** Current profile rollup for ONE vault: active entries (weight > 0), newest-touched first.
 *
 *  THE-710: `vaultId` is required for the same reason it is on applyPreferenceDeltas — an
 *  unscoped read would return a blend of every vault's profile, which is the pre-migration
 *  behaviour this partition removes. There is deliberately no "read every vault" overload; a
 *  caller that wants that must ask for each vault and say so. */
export function preferenceProfile(
  edb: Database,
  vaultId: string,
): {
  version: number;
  entries: Array<{ key: string; value: string; weight: number; updated_at: number }>;
} {
  if (!tableReady(edb)) return { version: 0, entries: [] };
  const rows = edb
    .prepare(
      "SELECT key, value, weight, version, updated_at FROM preference_profile WHERE vault_id = ? AND weight > 0 ORDER BY updated_at DESC",
    )
    .all(vaultId) as Array<{
    key: string;
    value: string;
    weight: number;
    version: number;
    updated_at: number;
  }>;
  const version = rows.reduce((m, r) => Math.max(m, r.version), 0);
  return {
    version,
    entries: rows.map((r) => ({
      key: r.key,
      value: r.value,
      weight: r.weight,
      updated_at: r.updated_at,
    })),
  };
}

/** Gateway-gated preference extraction: evidence = recent outcome-bearing episodes + retrieval
 *  feedback; the judge proposes typed deltas (strict JSON, capped); a parse failure aborts the
 *  batch — nothing half-applies. Without a judge the pass reports skipped (the deterministic
 *  evaluator above still ran). */
export async function extractPreferences(
  edb: Database,
  vaultId: string,
  opts: { judge: GatewayRoles["judge"] | null; nowMs: number; maxEvidence?: number },
): Promise<{ skipped: boolean; aborted: boolean; applied: number; version: number }> {
  if (!opts.judge) return { skipped: true, aborted: false, applied: 0, version: 0 };
  const maxEvidence = opts.maxEvidence ?? 40;
  // THE-710: episode evidence is scoped to this vault. `agent_episodes.vault_id` is NULLABLE, and a
  // NULL-vault episode is deliberately EXCLUDED rather than attributed anywhere — assigning it to a
  // default vault would invent the attribution the migration purged old rows to avoid inventing.
  // The equality predicate already excludes NULL; it is spelled out here so the exclusion reads as
  // a decision rather than as an accident of SQL three-valued logic.
  const episodes = edb
    .prepare(
      `SELECT tool, status, outcome, summary FROM agent_episodes
       WHERE vault_id = ? AND vault_id IS NOT NULL
         AND blocked = 0 AND eligibility = 'eligible' AND outcome IS NOT NULL ORDER BY ts DESC LIMIT ?`,
    )
    .all(vaultId, maxEvidence) as Array<{
    tool: string | null;
    status: string;
    outcome: number;
    summary: string | null;
  }>;
  // THE-710 scope note: retrieval feedback is NOT vault-scoped here, and cannot cheaply be. It is
  // corpus-level by design (SECURITY.md classifies chunk_retrievals as content-level, "a relevance
  // signal about a chunk, not about a principal"), and the vault of a chunk_id lives in cache.db,
  // which the membrane forbids joining to from this store — object ids cross by value, never by
  // foreign key. So the evidence pool is broader than the partition while the learned row is
  // attributed to the vault whose episodes drove the extraction. Stated rather than silently true.
  // THE-644 item 2 — NAMED FOR THE COLUMN IT READS. This was called `feedback` while selecting
  // `outcome`, and `chunk_retrievals.feedback` is a DIFFERENT column that this file reads nowhere.
  // The mismatch made the item look already-done to anyone who grepped the variable name instead
  // of the query: the ticket flagged it twice as a trap and asked for exactly this rename. Wiring
  // the real `feedback` column into extraction is still open, and is a ranking-adjacent change
  // needing THE-641's eval gate — do not add it here without one.
  const retrievalOutcomes = edb
    .prepare(
      `SELECT query_text, outcome FROM chunk_retrievals
       WHERE outcome IS NOT NULL AND query_text IS NOT NULL ORDER BY retrieved_at DESC LIMIT 20`,
    )
    .all() as Array<{ query_text: string; outcome: number }>;
  if (episodes.length === 0 && retrievalOutcomes.length === 0)
    return { skipped: true, aborted: false, applied: 0, version: 0 };
  const lines = [
    ...episodes.map(
      (e) =>
        `episode outcome=${e.outcome > 0 ? "+1" : e.outcome < 0 ? "-1" : "0"} tool=${e.tool ?? "?"} status=${e.status}${e.summary ? ` summary=${e.summary.slice(0, 120)}` : ""}`,
    ),
    ...retrievalOutcomes.map(
      (f) => `retrieval outcome=${f.outcome > 0 ? "+1" : "-1"} query=${f.query_text.slice(0, 120)}`,
    ),
  ].join("\n");
  try {
    const res = await opts.judge({
      ...prompt(
        "You maintain a small durable preference profile for this workspace's user, derived " +
          "from work-outcome evidence. Propose AT MOST 10 typed deltas about stable preferences " +
          "(tools, formats, workflows) the evidence supports. Ops: add (new preference), " +
          "strengthen / weaken (existing key), retract (evidence contradicts it). Respond with " +
          'strict JSON: {"deltas":[{"key":"kebab-case-key","op":"add|strengthen|weaken|retract",' +
          '"value":"short statement","evidence":"one-line gist"}]}. No other text.',
        lines,
      ),
      responseFormat: { type: "json_object" },
    });
    const parsed = JSON.parse(res.text) as { deltas?: PreferenceDelta[] };
    if (!Array.isArray(parsed.deltas)) throw new Error("no deltas array");
    const deltas = parsed.deltas
      .filter((d) => d && typeof d.key === "string" && d.key.length > 0)
      .slice(0, 10);
    const { version, applied } = applyPreferenceDeltas(edb, vaultId, deltas, opts.nowMs);
    return { skipped: false, aborted: false, applied, version };
  } catch {
    return { skipped: false, aborted: true, applied: 0, version: 0 };
  }
}

/** THE-698: deps for the periodic serve-path episode evaluation (registerEpisodeEvaluation).
 *  Mirrors ActivationRecomputeDeps — same shape, same optional clock, same onError contract. */
export interface EpisodeEvaluationDeps {
  edb: Database;
  intervalMs: number;
  now?: () => number;
  // THE-701 removed `judge` and `maxJudged`. This pass is now purely deterministic, so it acquires
  // no network dependency at all — which was already the stated goal of never defaulting the judge
  // to a lazy gateway lookup, now true by construction rather than by discipline.
  onEvaluate?: (stats: EvaluateStats) => void;
  onError?: (e: unknown) => void;
}

/**
 * THE-698 — run the evaluator pass on the maintenance cadence.
 *
 * `evaluateEpisodes` had exactly two non-test call sites: its own definition and the manual
 * `obsidian-tc reflect` CLI. Nothing wired it on a schedule the way registerActivationRecompute
 * wires activation, so the promotion pass simply never happened unless an operator remembered to
 * invoke it. Measured on the live store before this shipped: 337 of 337 episodes `pending`, zero
 * eligible, across seventeen days of continuous capture.
 *
 * The consequence was not a stale number but a dark subsystem. `work_search` serves
 * evaluator-approved rows only — that is its security contract, not a default — so with zero
 * eligible rows it returned nothing, always. An empty result is indistinguishable from "nothing
 * matched", which is exactly how this stayed invisible. SECURITY.md meanwhile documents `pending`
 * as "a short-lived state and not a quarantine"; seventeen days at 100% pending is a quarantine.
 *
 * Registered beside activation-recompute on the same `config.maintenance.intervalMinutes` cadence
 * and behind the same `experientialOpen` gate. No gateway dependency, like note-quality-enqueue —
 * and since THE-701 removed the judge, the deterministic layer is not merely "the whole job here"
 * by convention but the only thing this pass can do.
 *
 * Every safety invariant lives in evaluateEpisodes and is unchanged by scheduling it: born-
 * 'ineligible' rows are untouchable by the WHERE, contradictory ok/error clusters are held, and a
 * known-bad outcome (-1) is held. Scheduling the pass must never become a way to launder a row the
 * pre-ingest poison scanner already refused, so that is pinned by test rather than left to reading.
 */
export function registerEpisodeEvaluation(scheduler: Scheduler, deps: EpisodeEvaluationDeps): void {
  scheduler.register({
    name: "episode-evaluation",
    intervalMs: deps.intervalMs,
    run: async () => {
      const stats = await evaluateEpisodes(deps.edb, { nowMs: (deps.now ?? Date.now)() });
      deps.onEvaluate?.(stats);
    },
    onError: (e) => deps.onError?.(e),
  });
}

/** THE-698: the backlog an operator actually needs to see. `promotable` is the discriminating
 *  field — `pending` alone counts rows the evaluator is deliberately holding forever. */
export interface EpisodeBacklog {
  pending: number;
  eligible: number;
  /** Pending rows the deterministic pass WOULD promote right now. Non-zero and old means the
   *  evaluator is not running; zero means it is up to date, however many held rows remain. */
  promotable: number;
  /** Age of the oldest PROMOTABLE pending episode, or null when there are none. */
  oldestPromotableAgeMs: number | null;
}

/**
 * THE-698 — read the episode backlog WITHOUT evaluating anything.
 *
 * Diagnosing must never promote a row, so this shares `partitionPending` with the evaluator rather
 * than mutating through it. The alternative — counting `eligibility = 'pending'` in the checker —
 * was tried first and was wrong on the live store the moment the backlog was promoted: 333 eligible
 * and 4 permanently-held contradictory `index_vault` episodes read as "the evaluator has not run".
 */
export function readEpisodeBacklog(edb: Database, nowMs: number): EpisodeBacklog {
  const pending = edb
    .prepare(
      `SELECT id, caller, tool, status, args_hash, summary, outcome, ts FROM agent_episodes
       WHERE eligibility = 'pending' AND blocked = 0
         AND (valid_until IS NULL OR valid_until > ?)
       ORDER BY ts ASC`,
    )
    .all(nowMs) as Array<PendingRow & { ts: number }>;
  const eligible = (
    edb
      .prepare("SELECT COUNT(*) AS n FROM agent_episodes WHERE eligibility = 'eligible'")
      .get() as { n: number }
  ).n;
  const { candidates } = partitionPending(pending);
  // Rows come back ts ASC, so the first candidate is the oldest promotable one.
  const oldest = candidates[0] as (PendingRow & { ts: number }) | undefined;
  return {
    pending: pending.length,
    eligible,
    promotable: candidates.length,
    oldestPromotableAgeMs: oldest ? Math.max(0, nowMs - oldest.ts) : null,
  };
}
