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
//   * THE-565: an episode the system has already judged a BAD result (`task_result = -1`) is held
//     pending, never auto-promoted — a known-negative-outcome row must not enter the eligible
//     pool as a default lesson. This is the one place the deterministic pass consults the
//     task-result axis. NOTE the deliberate asymmetry: a `status = 'error'` dispatch with no bad result
//     still promotes ("errors are lessons too" — a forbidden delete teaches a boundary); it is
//     the explicit -1 task_result, not a failed dispatch, that we refuse. `status`/`skipped` are
//     otherwise unchanged.
//
//     THE-721: this gate is CORRECT, TESTED and INERT. An earlier version of this comment said
//     the -1 was "stamped by the citation / session-close outcome pass". No such writer exists,
//     and none ever did: `agent_episodes` has seven write statements across the tree and not one
//     of them sets it, so the column is NULL on 414 of 414 live rows (re-measured 2026-08-06; it
//     was 363 when this was written, and the ratio has never moved off 1.0). The citation pass
//     stamps `chunk_retrievals` columns only, and there is no session-close pass —
//     sessions.ts and session-tools.ts never touch the column. The same false claim is frozen
//     into migration 20260711_001's header, which is checksum-pinned and cannot be corrected in
//     place; THE-721 carries it.
//
//     The consequence is bounded rather than dangerous: an unreachable HOLD is more permissive
//     than designed, not less, and there is no known-bad set to leak because nothing marks one.
//     reflect-evaluator.test.ts:96 seeds `task_result: -1` directly and asserts the hold, so the gate
//     is ready the moment a producer exists. Whether to build one is the open question on THE-721.
import type { Database } from "../db/types";
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
  /** Task result (-1 | 0 | +1 | null), renamed from `outcome` in 20260806_002. -1 (known-bad)
   *  is held; see the invariants. */
  task_result: number | null;
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
/** THE-746: the version of the RULE SET below, stamped alongside every verdict. Bump it whenever a
 *  rule is added, removed or changed — that is what lets a later re-run be told apart from a data
 *  change, the confound THE-672 had to control for by hand. */
export const ELIGIBILITY_POLICY_VERSION = 1;

/** Why a row got the verdict it got. Closed set: every branch below names exactly one. */
export type EligibilityReason =
  | "promoted_stable"
  | "held_unstable_evidence"
  | "held_bad_task_result";

export function partitionPending(pending: PendingRow[]): {
  candidates: PendingRow[];
  held: number;
  /** THE-746: the held rows WITH the rule that held each one. `held` above is retained as a plain
   *  count because EvaluateStats and the reflect CLI both read it. */
  holds: Array<{ row: PendingRow; reason: EligibilityReason }>;
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
  const holds: Array<{ row: PendingRow; reason: EligibilityReason }> = [];
  for (const r of pending) {
    // PRECEDENCE IS DELIBERATE AND MUST STAY STABLE: a row can be BOTH unstable and carry
    // task_result = -1, and an audit trail whose reason flips between runs on the same data is
    // worse than none. Instability is reported first because it is a property of the EVIDENCE SET
    // (this row plus its siblings) while task_result is a property of the row alone — the wider
    // fact is the more useful one to surface, and the narrower one is still recoverable from the
    // row's own column.
    if (unstable(r)) holds.push({ row: r, reason: "held_unstable_evidence" });
    else if (r.task_result === -1) holds.push({ row: r, reason: "held_bad_task_result" });
    else candidates.push(r);
  }
  return { candidates, held: holds.length, holds };
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
      `SELECT id, caller, tool, status, args_hash, summary, task_result FROM agent_episodes
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

  const { candidates, held, holds } = partitionPending(pending);
  stats.held = held;

  // THE-726: the WHERE re-checks `task_result` as well as `eligibility`, and that second clause is
  // load-bearing rather than defensive. This pass reads, classifies in memory, then writes — it
  // is not wrapped in a transaction — so a verdict can land in the gap:
  //
  //   1. this pass selects R (pending, task_result NULL) and classifies it for promotion
  //   2. a verdict transaction stamps R = -1; its own demotion matches nothing, because R is
  //      still `pending` and demotion only moves rows OUT of `eligible`
  //   3. this UPDATE promotes R anyway, and R is now eligible carrying a -1
  //
  // R would then never be re-inspected, because the next pass selects only `pending`. Re-checking
  // here means step 3 promotes nothing and the following pass holds R with its reason recorded.
  // Without this clause the demotion in verdict.ts closes only the case where the verdict arrives
  // AFTER promotion, and the claim that the hold is order-independent is simply false.
  const promote = edb.prepare(
    `UPDATE agent_episodes
        SET eligibility = 'eligible', eligibility_reason = ?, eligibility_policy = ?
      WHERE id = ? AND eligibility = 'pending' AND (task_result IS NULL OR task_result <> -1)`,
  );
  // THE-746: a HELD row keeps `eligibility = 'pending'` — being held is not a state change, it is
  // the absence of one — but it still records WHY it was passed over. Without this the two reasons
  // for a row sitting at 'pending' (never evaluated / evaluated and held) are indistinguishable,
  // which is the same never-ran-vs-ran-and-did-nothing conflation THE-744 fixed one plane over.
  const hold = edb.prepare(
    `UPDATE agent_episodes
        SET eligibility_reason = ?, eligibility_policy = ?
      WHERE id = ? AND eligibility = 'pending'`,
  );
  // `denied` is retained and stays 0 here. Nothing in this pass denies any more: the only source of
  // 'ineligible' is assessPoison at capture time (episodes.ts:184), which this WHERE never selects.
  // Kept in the stats shape because doctor's experiential.evaluator signal and the reflect CLI both
  // read it, and because a future deterministic deny rule belongs in this counter rather than a new
  // one.
  for (const r of candidates) {
    promote.run("promoted_stable", ELIGIBILITY_POLICY_VERSION, r.id);
    stats.promoted++;
  }
  for (const h of holds) {
    hold.run(h.reason, ELIGIBILITY_POLICY_VERSION, h.row.id);
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

/** THE-673: the closed set of preference keys a deterministic extractor may write. Enforced in
 *  application code, NOT a DB `CHECK` — `key` is half of `preference_profile`'s primary key, and
 *  SQLite cannot add a `CHECK` to an existing column without a full table rebuild (the same class
 *  of migration `20260803_001` already had to do once for this table). A TypeScript allowlist
 *  gives the same "impossible state" guarantee at zero migration cost.
 *
 *  Deliberately one member. `preferred.search_mode` is the only axis with a real producer today
 *  (tool choice, 100%-populated). The other four keys once proposed for this registry
 *  (`preferred.output_format`, `response.detail`, `citation.style`,
 *  `workflow.confirmation_level`) each need an input this ticket does not build — `captureContent`
 *  flipped on, THE-675's transcript question, or an elicitation/HITL producer respectively — and
 *  shipping them unregistered-but-inert would be the ticket's own named anti-pattern ("four keys
 *  nothing can ever write"). Widen this set only when a new axis has a real producer. */
export const PREFERENCE_KEYS: ReadonlySet<string> = new Set(["preferred.search_mode"]);

/** THE-673: the search-family tools `preferred.search_mode` counts over. Closed list rather than
 *  "any tool that ran", because the point of this key is revealed *choice among alternatives* —
 *  counting every dispatch would fold in tools with no comparable substitute and dilute the
 *  signal this axis exists to carry. */
const SEARCH_FAMILY_TOOLS: ReadonlySet<string> = new Set([
  "search_text",
  "search_regex",
  "search_vault",
  "vault_graph_search",
  "search_omnisearch",
]);

/** THE-673/THE-726: an evidence row shaped enough to know which `(session_id, verdict_at)` window
 *  it belongs to. `groupEpisodesByVerdictWindow` only needs these two fields — kept generic so it
 *  stays reusable by whatever else reads windowed episode evidence, rather than tied to the exact
 *  column set `extractPreferences` happens to select today. */
export interface VerdictWindowable {
  session_id: string | null;
  verdict_at: number | null;
}

/**
 * THE-726 / THE-673 — collapse episode rows onto their `(session_id, verdict_at)` WINDOW, so one
 * rendered judgement becomes one observation rather than N correlated rows.
 *
 * A task verdict is rendered at session grain and PROJECTED onto every judgeable dispatch in its
 * window, so N rows can carry one opinion. `(session_id, verdict_at)` is the window identity — the
 * pair that recovers which rows those are. Without collapsing on it a reader sees N
 * perfectly-correlated rows and cannot tell they are one observation: measured on the live corpus
 * at 4.82 dispatches per session (range 1-18), a single 18-dispatch task would outweigh a careful
 * one-call task 18:1 for the same single judgement. That is a LENGTH bias toward tool-heavy
 * workflows, not a quality signal.
 *
 * Extracted as ONE shared helper (originally inline in the now-removed LLM evidence-line
 * formatter) because this repo has an explicit standing rule against two copies of one predicate
 * drifting apart (see `partitionPending`'s comment above making the same argument) — the
 * deterministic counter built on this needs exactly the same collapse the LLM path needed, and a
 * second copy is exactly the kind of drift that would be silent in the direction that matters.
 *
 * Rows predating THE-726's producer have `verdict_at` NULL; they group under their own key so a
 * pre-projection row is never merged with an unrelated one.
 *
 * KNOWN LIMIT, stated rather than left to be rediscovered: grouping happens AFTER whatever row
 * LIMIT the caller applied upstream, so a large window still consumes ROW slots even though it
 * contributes one WINDOW. At the measured 4.82 dispatches per window a 40-row budget yields
 * roughly 8 windows, not 40. That is under-sampling, and it is a strictly smaller problem than the
 * length bias this collapse removes.
 */
export function groupEpisodesByVerdictWindow<T extends VerdictWindowable>(
  episodes: readonly T[],
): Array<{ episodes: T[]; sampledCalls: number }> {
  const windows = new Map<string, T[]>();
  for (const e of episodes) {
    const key =
      e.verdict_at !== null && e.session_id !== null
        ? `${e.session_id}:${e.verdict_at}`
        : `row:${windows.size}`;
    const bucket = windows.get(key);
    if (bucket) bucket.push(e);
    else windows.set(key, [e]);
  }
  return [...windows.values()].map((es) => ({ episodes: es, sampledCalls: es.length }));
}

interface EvidenceRow extends VerdictWindowable {
  tool: string | null;
  status: string;
  task_result: number;
  summary: string | null;
}

/** THE-673: one window (one rendered judgement) yields AT MOST ONE delta — the BINDING
 *  REQUIREMENT on this ticket is "one window contributes ONE observation", and `preference_profile`
 *  enforces the same shape structurally: its primary key is `(vault_id, key)`, so
 *  `preferred.search_mode` can only ever hold ONE current value, never a per-tool tally. So when a
 *  window dispatched more than one distinct search-family tool, the MAJORITY tool within that
 *  window (ties broken toward whichever was dispatched first) is the window's one observation —
 *  not a delta per tool, which would let a single judgement bump the weight multiple times and
 *  violate the one-window-one-observation requirement.
 *
 *  `task_result = 0` (recorded but neutral) produces no delta: a neutral or unjudged window is not
 *  evidence of preference either way, and treating "used a tool" alone as revealed preference
 *  would silently reintroduce the "count everything, judged or not" behaviour the eligibility
 *  WHERE (`task_result IS NOT NULL`) already excludes upstream. A window with no search-family
 *  tool at all (e.g. only `read_note`) also produces no delta — this axis counts choice among
 *  search alternatives, not general activity.
 *
 *  `op` is always `add` on the positive branch rather than a looked-up `strengthen` —
 *  `applyPreferenceDeltas`'s `add` already upserts (create-or-reinforce, refresh `value`), so it is
 *  the create-or-strengthen behaviour the design calls for without a second DB read to pick a
 *  label. `weaken` is left as a plain UPDATE-only op on purpose: weakening a key that was never
 *  added must stay a no-op (the existing C4 guard in `applyPreferenceDeltas` — no phantom audit
 *  row), never a way to sneak the key into existence from the negative side. */
function buildSearchModeDeltas(windows: Array<{ episodes: EvidenceRow[] }>): PreferenceDelta[] {
  const deltas: PreferenceDelta[] = [];
  for (const w of windows) {
    const taskResult = w.episodes[0]?.task_result ?? 0;
    if (taskResult === 0) continue;
    const toolCounts = new Map<string, number>();
    for (const e of w.episodes) {
      if (e.tool && SEARCH_FAMILY_TOOLS.has(e.tool)) {
        toolCounts.set(e.tool, (toolCounts.get(e.tool) ?? 0) + 1);
      }
    }
    if (toolCounts.size === 0) continue;
    let majorityTool = "";
    let majorityCount = 0;
    for (const [tool, count] of toolCounts) {
      if (count > majorityCount) {
        majorityTool = tool;
        majorityCount = count;
      }
    }
    deltas.push({
      key: "preferred.search_mode",
      op: taskResult > 0 ? "add" : "weaken",
      value: majorityTool,
      evidence: `tool=${majorityTool} sampled_calls=${majorityCount}`,
    });
  }
  return deltas;
}

/** THE-673: drop any delta whose key is not in `PREFERENCE_KEYS` before it reaches
 *  `applyPreferenceDeltas` — an unregistered key must never become a write, even from a future
 *  extractor sharing this filter, not just from the one counter this file builds today. Exported
 *  so the registry's enforcement is directly testable at the boundary, not just inferred from
 *  `PREFERENCE_KEYS`'s membership. */
export function filterRegisteredDeltas(deltas: PreferenceDelta[]): PreferenceDelta[] {
  return deltas.filter((d) => PREFERENCE_KEYS.has(d.key));
}

/** Deterministic preference extraction (THE-673): evidence = recent task_result-bearing episodes
 *  (THE-718 removed the retrieval half — see the note at the query), collapsed onto their
 *  `(session_id, verdict_at)` window and counted, never inferred from prose. THE-701 set the
 *  precedent for this file: the analogous judge layer left `evaluateEpisodes` "not on principle,
 *  on measurement" — this removes the second and last judge in this file for the same reason: a
 *  free-form LLM proposal over a store designed for auditable counters is strictly worse at equal
 *  accuracy, because it carries no derivation. `skipped` now means only "no evidence reached the
 *  window pass" (no gateway concept exists anymore); a run that finds evidence but derives no
 *  delta from it — e.g. every window is neutral — is NOT reported skipped, distinct from finding
 *  nothing to look at. `aborted` is retained in the return shape for call-site compatibility but a
 *  deterministic counter has no parse-failure mode, so it is always `false`. */
export async function extractPreferences(
  edb: Database,
  vaultId: string,
  opts: { nowMs: number; maxEvidence?: number },
): Promise<{ skipped: boolean; aborted: boolean; applied: number; version: number }> {
  const maxEvidence = opts.maxEvidence ?? 40;
  // THE-710: episode evidence is scoped to this vault. `agent_episodes.vault_id` is NULLABLE, and a
  // NULL-vault episode is deliberately EXCLUDED rather than attributed anywhere — assigning it to a
  // default vault would invent the attribution the migration purged old rows to avoid inventing.
  // The equality predicate already excludes NULL; it is spelled out here so the exclusion reads as
  // a decision rather than as an accident of SQL three-valued logic.
  const episodes = edb
    .prepare(
      `SELECT tool, status, task_result, summary, session_id, verdict_at FROM agent_episodes
       WHERE vault_id = ? AND vault_id IS NOT NULL
         AND blocked = 0 AND eligibility = 'eligible' AND task_result IS NOT NULL
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(vaultId, maxEvidence) as EvidenceRow[];
  // THE-718: the second evidence source here was `chunk_retrievals.outcome`, retired in
  // 20260806_001. It is REMOVED rather than repointed at `chunk_retrievals.feedback`, because the
  // comment this replaces said so explicitly — wiring the real `feedback` column into extraction
  // "is a ranking-adjacent change needing THE-641's eval gate — do not add it here without one",
  // and deleting the column it was reading is not that gate. Preference extraction now runs on
  // episode evidence alone. The THE-710 scope note that lived here described why retrieval feedback
  // could not be vault-scoped (chunk vaults live in cache.db, across the membrane); it goes with the
  // query, and comes back with it if THE-641 lands.
  if (episodes.length === 0) return { skipped: true, aborted: false, applied: 0, version: 0 };
  const windows = groupEpisodesByVerdictWindow(episodes);
  const deltas = filterRegisteredDeltas(buildSearchModeDeltas(windows));
  if (deltas.length === 0) return { skipped: false, aborted: false, applied: 0, version: 0 };
  const { version, applied } = applyPreferenceDeltas(edb, vaultId, deltas, opts.nowMs);
  return { skipped: false, aborted: false, applied, version };
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
      `SELECT id, caller, tool, status, args_hash, summary, task_result, ts FROM agent_episodes
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
