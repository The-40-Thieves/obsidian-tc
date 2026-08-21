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
import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";
import type { Scheduler } from "../scheduler/scheduler";
import { serializeEpisodeSummary, type ToolTally } from "./summarize-episode";

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

// THE-752: generic over the row shape rather than fixed to `PendingRow`, so a caller that SELECTs
// extra columns (evaluateEpisodes now selects `tags`/`session_id` for the summary receipt) gets
// them back on `candidates`/`holds` instead of losing them to the base type. `readEpisodeBacklog`
// still calls this with plain `PendingRow & { ts }` and is unaffected.
export function partitionPending<T extends PendingRow>(
  pending: T[],
): {
  candidates: T[];
  held: number;
  /** THE-746: the held rows WITH the rule that held each one. `held` above is retained as a plain
   *  count because EvaluateStats and the reflect CLI both read it. */
  holds: Array<{ row: T; reason: EligibilityReason }>;
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
  const candidates: T[] = [];
  const holds: Array<{ row: T; reason: EligibilityReason }> = [];
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

/** `PendingRow` plus the two columns THE-752's summary receipt needs beyond what
 *  `partitionPending` reads. Kept local to this function rather than folded into `PendingRow`
 *  itself — `readEpisodeBacklog` shares that interface for a read-only diagnostic query that has
 *  no reason to grow two more columns it never uses. */
interface PendingRowWithSummarySource extends PendingRow {
  tags: string | null;
  session_id: string | null;
}

/** THE-752 Tier 0: tool -> dispatch count, grouped by session, for every session represented in
 *  `rows`. ONE grouped query rather than one per row — `evaluateEpisodes` runs over the whole
 *  pending backlog, and an N+1 query per episode would scale with backlog size for no reason. Rows
 *  with a NULL `session_id` are not queried (there is no window to tally) and fall back to a
 *  single-entry tally of their own tool at the call site. */
function toolTalliesBySession(
  edb: Database,
  rows: readonly PendingRowWithSummarySource[],
): Map<string, ToolTally> {
  const sessionIds = [...new Set(rows.map((r) => r.session_id).filter((s) => s !== null))];
  const tallies = new Map<string, Record<string, number>>();
  if (sessionIds.length === 0) return tallies;
  const placeholders = sessionIds.map(() => "?").join(", ");
  const grouped = edb
    .prepare(
      // ORDER BY is load-bearing (not the optimizer's incidental sort): the tally key order feeds
      // serializeEpisodeSummary's JSON, and a held episode must regenerate a byte-identical summary.
      `SELECT session_id, tool, COUNT(*) AS n FROM agent_episodes
       WHERE session_id IN (${placeholders})
       GROUP BY session_id, tool
       ORDER BY session_id, tool`,
    )
    .all(...sessionIds) as Array<{ session_id: string; tool: string | null; n: number }>;
  for (const g of grouped) {
    let byTool = tallies.get(g.session_id);
    if (!byTool) {
      byTool = {};
      tallies.set(g.session_id, byTool);
    }
    byTool[g.tool ?? "unknown"] = g.n;
  }
  return tallies;
}

/** Evaluator pass: pending -> eligible under the deterministic rules. Ineligible rows are
 *  untouchable by construction (the WHERE) — assessPoison stamps those at capture, before this
 *  pass exists. THE-701 removed the judge layer; see the file header for the measurement.
 *
 *  THE-752 Tier 0: every row this pass touches (promoted OR held) also gets a deterministic,
 *  no-LLM `summary` receipt — see summarize-episode.ts for why that is safe to run unconditionally
 *  at any corpus size. A promoted row leaves `eligibility = 'pending'` behind and is never
 *  selected by this WHERE again, so its summary is written exactly once; a held row stays
 *  `pending` and is re-evaluated on the next pass, regenerating the same summary from the same
 *  columns (stable, not churn) unless the underlying data actually changed. */
export async function evaluateEpisodes(
  edb: Database,
  opts: { nowMs: number },
): Promise<EvaluateStats> {
  const pending = edb
    .prepare(
      `SELECT id, caller, tool, status, args_hash, summary, task_result, tags, session_id
         FROM agent_episodes
       WHERE eligibility = 'pending' AND blocked = 0
         AND (valid_until IS NULL OR valid_until > ?)
       ORDER BY ts ASC`,
    )
    .all(opts.nowMs) as PendingRowWithSummarySource[];
  const stats: EvaluateStats = {
    scanned: pending.length,
    promoted: 0,
    held: 0,
    denied: 0,
  };
  if (pending.length === 0) return stats;

  const { candidates, held, holds } = partitionPending(pending);
  stats.held = held;
  const tallies = toolTalliesBySession(edb, pending);
  const summaryFor = (r: PendingRowWithSummarySource): string =>
    serializeEpisodeSummary(
      r,
      r.session_id !== null
        ? (tallies.get(r.session_id) ?? { [r.tool ?? "unknown"]: 1 })
        : { [r.tool ?? "unknown"]: 1 },
    );

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
        SET eligibility = 'eligible', eligibility_reason = ?, eligibility_policy = ?, summary = ?
      WHERE id = ? AND eligibility = 'pending' AND (task_result IS NULL OR task_result <> -1)`,
  );
  // THE-746: a HELD row keeps `eligibility = 'pending'` — being held is not a state change, it is
  // the absence of one — but it still records WHY it was passed over. Without this the two reasons
  // for a row sitting at 'pending' (never evaluated / evaluated and held) are indistinguishable,
  // which is the same never-ran-vs-ran-and-did-nothing conflation THE-744 fixed one plane over.
  const hold = edb.prepare(
    `UPDATE agent_episodes
        SET eligibility_reason = ?, eligibility_policy = ?, summary = ?
      WHERE id = ? AND eligibility = 'pending'`,
  );
  // `denied` is retained and stays 0 here. Nothing in this pass denies any more: the only source of
  // 'ineligible' is assessPoison at capture time (episodes.ts:184), which this WHERE never selects.
  // Kept in the stats shape because doctor's experiential.evaluator signal and the reflect CLI both
  // read it, and because a future deterministic deny rule belongs in this counter rather than a new
  // one.
  for (const r of candidates) {
    promote.run("promoted_stable", ELIGIBILITY_POLICY_VERSION, summaryFor(r), r.id);
    stats.promoted++;
  }
  for (const h of holds) {
    hold.run(h.reason, ELIGIBILITY_POLICY_VERSION, summaryFor(h.row), h.row.id);
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
  /** THE-891: which partition this delta targets — `''` for the human/shared partition, or the
   *  caller string for that caller's own partition. Taken from the delta record itself, NEVER
   *  defaulted inside `applyPreferenceDeltas` — see `PREFERENCE_KEYS`'s per-key scope declaration
   *  and `scopeCallerFor`, the one place a producer is allowed to derive it. Required rather than
   *  optional so a producer cannot forget it and fall through to an implicit `''`, which is exactly
   *  the silent-bleed-back-to-shared failure mode this ticket exists to close. */
  scopeCaller: string;
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
// NAMESPACE (THE-710, revising the P1.8 / audit-THE-562 disposition; narrowed again by THE-891):
// the preference plane is partitioned BY VAULT — `vault_id` leads the primary key and every
// statement below is scoped to it. It was previously keyed by `key` alone, deliberately, on the
// rationale that a single-user runtime wants one shared profile. That rationale does not extend to
// a single-VAULT assumption: with two vaults configured, one vault's learned preference silently
// overwrote the other's under the same key, with no column to filter on (the THE-310 defect class).
// Migration 20260803_001 rebuilt both tables; its header carries the full reasoning.
//
// THE CALLER AXIS IS NOW PER-KEY, not global. `(vault_id, scope_caller, key)` is the full primary
// key (migration 20260820_001): `scope_caller` is `''` for the human/shared partition, or one
// caller's own partition, and WHICH one a delta targets is a property of the delta record — see
// `PreferenceDelta.scopeCaller` and `scopeCallerFor`. This function never derives or defaults that
// value itself; it only writes wherever the caller says. Contrast: agent_episodes is per-principal
// (vault+caller+session, P1.7-authorized) at the ROW level; vault_object_state ACT-R activation is
// corpus-global by design; preference_profile is per-principal only for the keys that opt in.
//
// `vaultId` is REQUIRED and deliberately undefaulted, for the same reason `scopeCaller` on each
// delta is required rather than optional: a default would let a call site silently fall back to one
// shared bucket, which is the exact behaviour this partition exists to remove.
export function applyPreferenceDeltas(
  edb: Database,
  vaultId: string,
  deltas: PreferenceDelta[],
  nowMs: number,
): { version: number; applied: number } {
  if (!tableReady(edb)) throw new Error("preference_profile tables missing (run migrations)");
  // Version is PER-VAULT (not per scope_caller): one batch can legitimately mix deltas for several
  // partitions (an extraction pass over several windows with different callers), and it is still
  // ONE batch — splitting the version counter by scope_caller too would make an operator's "what
  // changed in this run" question require reading N version numbers instead of one.
  const prev = edb
    .prepare(
      "SELECT MAX(v) AS v FROM (SELECT MAX(version) AS v FROM preference_deltas WHERE vault_id = ? UNION ALL SELECT MAX(version) AS v FROM preference_profile WHERE vault_id = ?)",
    )
    .get(vaultId, vaultId) as { v: number | null };
  const version = (prev.v ?? 0) + 1;
  const logDelta = edb.prepare(
    "INSERT INTO preference_deltas (vault_id, scope_caller, ts, key, op, value, evidence, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const upsertAdd = edb.prepare(
    `INSERT INTO preference_profile (vault_id, scope_caller, key, value, weight, version, updated_at, provenance)
     VALUES (?, ?, ?, ?, 1.0, ?, ?, ?)
     ON CONFLICT(vault_id, scope_caller, key) DO UPDATE SET
       weight = MIN(${WEIGHT_CAP}, weight + ${WEIGHT_STEP}),
       value = COALESCE(excluded.value, preference_profile.value),
       version = excluded.version, updated_at = excluded.updated_at`,
  );
  const bump = edb.prepare(
    `UPDATE preference_profile SET weight = MIN(${WEIGHT_CAP}, weight + ${WEIGHT_STEP}), version = ?, updated_at = ? WHERE vault_id = ? AND scope_caller = ? AND key = ?`,
  );
  const damp = edb.prepare(
    `UPDATE preference_profile SET weight = MAX(0, weight - ${WEIGHT_STEP}), version = ?, updated_at = ? WHERE vault_id = ? AND scope_caller = ? AND key = ?`,
  );
  const retract = edb.prepare(
    "UPDATE preference_profile SET weight = 0, version = ?, updated_at = ? WHERE vault_id = ? AND scope_caller = ? AND key = ?",
  );
  let applied = 0;
  for (const d of deltas) {
    if (!d.key) continue;
    // strengthen/weaken/retract are UPDATE ... WHERE vault_id = ? AND scope_caller = ? AND key = ?
    // — on a key that was never added IN THIS PARTITION they change 0 rows. Gate the audit row +
    // `applied` on an actual mutation so a judge proposing a delta for a non-existent key can't log
    // a phantom preference_deltas row or bump the version.
    let changed = 1;
    if (d.op === "add")
      upsertAdd.run(
        vaultId,
        d.scopeCaller,
        d.key,
        d.value ?? "",
        version,
        nowMs,
        d.evidence ?? null,
      );
    else if (d.op === "strengthen")
      changed = bump.run(version, nowMs, vaultId, d.scopeCaller, d.key).changes as number;
    else if (d.op === "weaken")
      changed = damp.run(version, nowMs, vaultId, d.scopeCaller, d.key).changes as number;
    else if (d.op === "retract")
      changed = retract.run(version, nowMs, vaultId, d.scopeCaller, d.key).changes as number;
    else continue;
    if (changed === 0) continue;
    logDelta.run(
      vaultId,
      d.scopeCaller,
      nowMs,
      d.key,
      d.op,
      d.value ?? null,
      d.evidence ?? null,
      version,
    );
    applied++;
  }
  return { version, applied };
}

/** THE-891: raised when a read tries to cross the caller partition (`opts.anyCaller`) without
 *  proving it holds the elevated scope (`opts.crossPrincipal`). Mirrors work_search's own
 *  `any_caller` gate (tools/m8/work-search-tool.ts) — same "authorization-enforced, not filtered"
 *  posture SECURITY.md now documents for this store — but this module cannot import
 *  `tools/m8/shared.ts`'s `CROSS_PRINCIPAL_SCOPE`/`canCrossPrincipal` itself: the dependency runs
 *  tools -> experiential, never the reverse (dependency-cruiser's `no-circular`/layering rules), so
 *  the decision (`canCrossPrincipal(ctx)`) is computed at the MCP tool boundary that has a
 *  `CallerContext`, and only the boolean RESULT crosses into this lower layer as `crossPrincipal`. */
export class PreferenceScopeError extends Error {}

/** Current profile rollup for ONE vault, scoped to ONE principal: entries with `scope_caller = ''`
 *  (the human/shared partition every registered human-scoped key writes, and where a NULL caller —
 *  the single trusted local principal on an unauthenticated stdio transport — lands too) UNION
 *  `caller`'s own partition. Active entries only (weight > 0), newest-touched first.
 *
 *  THE-891: `caller` is required for the same reason `vaultId` is — an unscoped read would blend
 *  partitions the migration exists to keep apart. `caller: null` reads ONLY the human partition
 *  (its own partition and the human partition are the same row set), matching the NULL-caller
 *  mapping the migration documents.
 *
 *  `opts.anyCaller` crosses every principal's partition in the vault — mirroring `agent_episodes`'
 *  P1.7 authorization rather than merely filtering it: a caller that has not proven
 *  `opts.crossPrincipal` gets `PreferenceScopeError` thrown, not a silently narrowed result. There
 *  is deliberately no "read every vault" overload either; a caller that wants that must ask for
 *  each vault and say so (unchanged from THE-710). */
export function preferenceProfile(
  edb: Database,
  vaultId: string,
  caller: string | null,
  opts?: { anyCaller?: boolean; crossPrincipal?: boolean },
): {
  version: number;
  entries: Array<{
    key: string;
    value: string;
    weight: number;
    updated_at: number;
    scope_caller: string;
  }>;
} {
  if (!tableReady(edb)) return { version: 0, entries: [] };
  if (opts?.anyCaller && !opts.crossPrincipal) {
    throw new PreferenceScopeError(
      "any_caller requires proof of the admin:workspace scope (P1.7 treatment — see tools/m8/shared.ts's CROSS_PRINCIPAL_SCOPE)",
    );
  }
  const rows = opts?.anyCaller
    ? (edb
        .prepare(
          "SELECT scope_caller, key, value, weight, version, updated_at FROM preference_profile WHERE vault_id = ? AND weight > 0 ORDER BY updated_at DESC",
        )
        .all(vaultId) as Array<{
        scope_caller: string;
        key: string;
        value: string;
        weight: number;
        version: number;
        updated_at: number;
      }>)
    : (edb
        .prepare(
          "SELECT scope_caller, key, value, weight, version, updated_at FROM preference_profile WHERE vault_id = ? AND (scope_caller = '' OR scope_caller = ?) AND weight > 0 ORDER BY updated_at DESC",
        )
        .all(vaultId, caller ?? "") as Array<{
        scope_caller: string;
        key: string;
        value: string;
        weight: number;
        version: number;
        updated_at: number;
      }>);
  const version = rows.reduce((m, r) => Math.max(m, r.version), 0);
  return {
    version,
    entries: rows.map((r) => ({
      key: r.key,
      value: r.value,
      weight: r.weight,
      updated_at: r.updated_at,
      scope_caller: r.scope_caller,
    })),
  };
}

/** THE-891: a registered key's scope — see `PREFERENCE_KEYS`. */
export interface PreferenceKeyScope {
  /** `"human"` — one shared value per vault, correct for a context-free, intent-derived
   *  preference (the human's preference, whichever agent is asking). `"caller"` — partitioned per
   *  principal, because the key encodes the OBSERVING AGENT's own workload and one agent's learned
   *  behavior must not steer a different agent's retrieval. */
  scope: "human" | "caller";
}

/** THE-673 (registry), THE-891 (per-key scope): the closed set of preference keys a deterministic
 *  extractor may write, each declaring whether it is shared (`"human"`) or partitioned
 *  (`"caller"`). Enforced in application code, NOT a DB `CHECK` — `key` is part of
 *  `preference_profile`'s primary key, and SQLite cannot add a `CHECK` to an existing column
 *  without a full table rebuild (the same class of migration `20260803_001`/`20260820_001` already
 *  had to do twice for this table). A TypeScript allowlist gives the same "impossible state"
 *  guarantee at zero migration cost.
 *
 *  Deliberately one member. `preferred.search_mode` is the only axis with a real producer today
 *  (tool choice, 100%-populated), and it is `"caller"`-scoped: it is dispatch telemetry — it
 *  encodes the OBSERVING agent's workload, not the human's intent, so one agent's revealed tool
 *  choice must not steer another agent's retrieval. The other four keys once proposed for this
 *  registry (`preferred.output_format`, `response.detail`, `citation.style`,
 *  `workflow.confirmation_level`) each need an input this ticket does not build — `captureContent`
 *  flipped on, THE-675's transcript question, or an elicitation/HITL producer respectively — and
 *  shipping them unregistered-but-inert would be the ticket's own named anti-pattern ("four keys
 *  nothing can ever write"). Widen this set only when a new axis has a real producer; DEFAULT any
 *  new key to `"caller"` — sharing is a per-key opt-in, reviewed at registration, never the
 *  fallback. */
export const PREFERENCE_KEYS: ReadonlyMap<string, PreferenceKeyScope> = new Map([
  ["preferred.search_mode", { scope: "caller" }],
]);

/** THE-891: the ONE place a producer derives `PreferenceDelta.scopeCaller` from a registered key
 *  plus the caller a window/evidence row carried. A `"human"`-scoped key always writes `''`
 *  regardless of who was calling — that IS the shared partition. A `"caller"`-scoped key writes
 *  `windowCaller ?? ''` — the NULL-caller mapping migration `20260820_001` documents (an
 *  unauthenticated local transport is the single trusted local principal, so NULL safely collapses
 *  onto the same `''` partition human-scoped keys use, without inventing a shared identity between
 *  two DIFFERENT unauthenticated callers). An unregistered key (should never reach here —
 *  `filterRegisteredDeltas` drops those first) defaults to caller-scoped, matching the registry's
 *  own "unknown defaults to partitioned" posture rather than silently sharing it. */
function scopeCallerFor(key: string, windowCaller: string | null): string {
  const decl = PREFERENCE_KEYS.get(key);
  if (decl?.scope === "human") return "";
  return windowCaller ?? "";
}

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
  /** THE-891: the window's caller — `agent_episodes.caller`, one value per (session_id,
   *  verdict_at) window by construction (a session belongs to one principal). Feeds
   *  `scopeCallerFor` so a caller-scoped delta lands in the window's OWN partition rather than the
   *  shared one. */
  caller: string | null;
}

/** THE-673: one window (one rendered judgement) yields AT MOST ONE delta — the BINDING
 *  REQUIREMENT on this ticket is "one window contributes ONE observation", and `preference_profile`
 *  enforces the same shape structurally: its primary key is `(vault_id, key)`, so
 *  `preferred.search_mode` can only ever hold ONE current value, never a per-tool tally. So when a
 *  window dispatched more than one distinct search-family tool, the MAJORITY tool within that
 *  window (ties broken toward the most recently dispatched — evidence rows arrive ts-DESC, so the
 *  first-seen tool in the count map is the latest) is the window's one observation —
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
    // THE-891: `preferred.search_mode` is caller-scoped (dispatch telemetry, not human intent) —
    // scopeCallerFor resolves that against the WINDOW's caller, so this delta lands in the
    // dispatching agent's own partition, never the shared one.
    deltas.push({
      key: "preferred.search_mode",
      op: taskResult > 0 ? "add" : "weaken",
      value: majorityTool,
      evidence: `tool=${majorityTool} sampled_calls=${w.episodes.length} tool_calls=${majorityCount}`,
      scopeCaller: scopeCallerFor("preferred.search_mode", w.episodes[0]?.caller ?? null),
    });
  }
  return deltas;
}

/** THE-644: one `chunk_retrievals` row shaped enough to build the citation-evidence delta —
 *  `surface_type` is the retrieving tool (log.ts's own doc comment: "which serve surface
 *  retrieved it (tool name) — chunk_retrievals.surface_type"), `event_group` is the one-id-per-
 *  search-CALL correlator (20260725_001), `citation_state` is THE-717's judge verdict, and `caller`
 *  (THE-568/P1.7) is the window's principal — THE-891 feeds it to `scopeCallerFor` the same way
 *  `EvidenceRow.caller` does for the episode side. */
export interface CitationEvidenceRow {
  chunk_id: string;
  surface_type: string | null;
  event_group: string | null;
  citation_state: string | null;
  caller: string | null;
}

/** THE-644: batch size for the cross-store chunk_id -> vault_id ground-truth join below. Same
 *  constant, same reason, as note-quality.ts's `BATCH` and metrics.ts's own copy. */
const CITATION_EVIDENCE_BATCH = 200;

/**
 * THE-644: `chunk_retrievals` carries NO `vault_id` column at all (chunks live in cache.db,
 * across the experiential/cache membrane — see context-bundle.ts's header on the same absence).
 * So vault scoping here is a GROUND-TRUTH join against the TARGET vault's own cache.db `chunks`
 * table, batched, exactly the cross-store pattern note-quality.ts and metrics.ts already use for
 * the identical reason: a chunk id this vault's `chunks` table does not contain is a deleted or
 * foreign-vault chunk, and is dropped rather than attributed (never a default vault, matching the
 * NULL-vault-episode exclusion two comments above).
 *
 * `cacheDb` is undefined whenever `experiential.citationPreferences` is off — the caller never
 * opens cache.db at all in that case, so this function is simply never reached and the query cost
 * is zero, not merely its result discarded.
 *
 * Rows are restricted to `citation_state IS NOT NULL`: a row the citation pass never covered
 * (THE-717's `citationInfer.enabled`, or the kill-switch leaving survivors NULL for a clean rerun)
 * is unmeasured, not negative evidence — the same "unmeasured != bad" contract note-quality.ts's
 * `scoreNote` documents for the same column.
 */
function citationEvidence(
  edb: Database,
  cacheDb: Database,
  vaultId: string,
  maxEvidence: number,
): CitationEvidenceRow[] {
  if (!tableExists(edb, "chunk_retrievals")) return [];
  const rows = edb
    .prepare(
      `SELECT chunk_id, surface_type, event_group, citation_state, caller FROM chunk_retrievals
       WHERE citation_state IS NOT NULL
       ORDER BY retrieved_at DESC LIMIT ?`,
    )
    .all(maxEvidence) as CitationEvidenceRow[];
  if (rows.length === 0) return [];
  const chunkIds = [...new Set(rows.map((r) => r.chunk_id))];
  const inVault = new Set<string>();
  for (let i = 0; i < chunkIds.length; i += CITATION_EVIDENCE_BATCH) {
    const batch = chunkIds.slice(i, i + CITATION_EVIDENCE_BATCH);
    for (const r of cacheDb
      .prepare(
        `SELECT id FROM chunks WHERE vault_id = ? AND id IN (${batch.map(() => "?").join(",")})`,
      )
      .all(vaultId, ...batch) as Array<{ id: string }>) {
      inVault.add(r.id);
    }
  }
  return rows.filter((r) => inVault.has(r.chunk_id));
}

/** THE-644: group vault-scoped citation evidence onto its `event_group` — the one-id-per-search-
 *  CALL correlator, so a call returning K chunks contributes ONE observation rather than K
 *  perfectly-correlated ones (the exact length-bias argument `groupEpisodesByVerdictWindow`'s
 *  header makes for episode windows, applied to the retrieval-log analogue of a session window).
 *  A row with no `event_group` — a surface that predates THE-538 or never describes its policy —
 *  gets its own singleton window rather than merging with an unrelated row, mirroring that same
 *  helper's `row:${windows.size}` fallback. */
export function groupCitationEvidenceByEventGroup(
  rows: readonly CitationEvidenceRow[],
): Array<{ rows: CitationEvidenceRow[] }> {
  const windows = new Map<string, CitationEvidenceRow[]>();
  for (const r of rows) {
    const key = r.event_group !== null ? `eg:${r.event_group}` : `row:${windows.size}`;
    const bucket = windows.get(key);
    if (bucket) bucket.push(r);
    else windows.set(key, [r]);
  }
  return [...windows.values()].map((rows) => ({ rows }));
}

/** THE-644: the citation-evidence producer for `preferred.search_mode` — a second EVIDENCE SOURCE
 *  for the same key `buildSearchModeDeltas` already writes, not a new axis. One `event_group`
 *  window is one search call by construction, so every row in it shares one `surface_type`
 *  (tool); that tool's window verdict is CONFIRMED if any chunk in the call was confirmed cited
 *  (strengthen — `add` upserts, same create-or-reinforce reasoning `buildSearchModeDeltas`
 *  documents), else REJECTED if any chunk was rejected and none confirmed (weaken), else the
 *  window carries no verdict at all (skip — unmeasured, not negative). A window whose tool is not
 *  in `SEARCH_FAMILY_TOOLS` — `knowledge_search`, `vault_context`, `reflect`'s own
 *  self-instrumentation, `advisory` rows — is skipped for the same reason the episode producer
 *  restricts to that closed tool list: this axis counts revealed choice AMONG search
 *  alternatives, not citation for tools with no comparable substitute. */
function buildCitationSearchModeDeltas(
  windows: Array<{ rows: CitationEvidenceRow[] }>,
): PreferenceDelta[] {
  const deltas: PreferenceDelta[] = [];
  for (const w of windows) {
    const tool = w.rows[0]?.surface_type;
    if (!tool || !SEARCH_FAMILY_TOOLS.has(tool)) continue;
    let confirmed = 0;
    let rejected = 0;
    for (const r of w.rows) {
      if (r.citation_state === "confirmed") confirmed++;
      else if (r.citation_state === "rejected") rejected++;
    }
    if (confirmed === 0 && rejected === 0) continue;
    deltas.push({
      key: "preferred.search_mode",
      op: confirmed > 0 ? "add" : "weaken",
      value: tool,
      evidence: `citation tool=${tool} confirmed=${confirmed} rejected=${rejected}`,
      // THE-891: same registry lookup buildSearchModeDeltas uses, against this window's caller.
      scopeCaller: scopeCallerFor("preferred.search_mode", w.rows[0]?.caller ?? null),
    });
  }
  return deltas;
}

/** THE-673: drop any delta whose key is not in `PREFERENCE_KEYS` before it reaches
 *  `applyPreferenceDeltas` — an unregistered key must never become a write, even from a future
 *  extractor sharing this filter, not just from the one counter this file builds today. Exported
 *  so the registry's enforcement is directly testable at the boundary, not just inferred from
 *  `PREFERENCE_KEYS`'s membership. Drops are SILENT, and that is only safe while this file's one
 *  producer emits only registered keys — a future second producer must surface its dropped count
 *  rather than lean on this filter's silence. */
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
 *  deterministic counter has no parse-failure mode, so it is always `false`.
 *
 *  THE-644 reopens the retrieval half THE-718 removed, repointed at the axis that actually has a
 *  producer: `citation_state`, not the still-dead `feedback` this comment used to name as the
 *  repoint target. `opts.cacheDb` is that gate, and it is a CALLER decision, not a flag read in
 *  here — the caller only supplies it when `experiential.citationPreferences` is on, so leaving it
 *  undefined (the default) skips `citationEvidence` entirely and this function is byte-identical
 *  to the THE-673 version: same query, same windowing, same one evidence source. */
export async function extractPreferences(
  edb: Database,
  vaultId: string,
  opts: { nowMs: number; maxEvidence?: number; cacheDb?: Database },
): Promise<{ skipped: boolean; aborted: boolean; applied: number; version: number }> {
  const maxEvidence = opts.maxEvidence ?? 40;
  // THE-710: episode evidence is scoped to this vault. `agent_episodes.vault_id` is NULLABLE, and a
  // NULL-vault episode is deliberately EXCLUDED rather than attributed anywhere — assigning it to a
  // default vault would invent the attribution the migration purged old rows to avoid inventing.
  // The equality predicate already excludes NULL; it is spelled out here so the exclusion reads as
  // a decision rather than as an accident of SQL three-valued logic.
  // THE-891: `caller` travels alongside — it is the window identity's principal, fed to
  // scopeCallerFor so a caller-scoped delta lands in the dispatching agent's own partition.
  const episodes = edb
    .prepare(
      `SELECT tool, status, task_result, summary, session_id, verdict_at, caller FROM agent_episodes
       WHERE vault_id = ? AND vault_id IS NOT NULL
         AND blocked = 0 AND eligibility = 'eligible' AND task_result IS NOT NULL
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(vaultId, maxEvidence) as EvidenceRow[];
  // THE-644 (was THE-718): citation rows are the second evidence source, gated behind
  // `opts.cacheDb` — see `citationEvidence`'s own header for the ground-truth join this needs and
  // why chunk_retrievals cannot be scoped by a plain WHERE the way agent_episodes is above.
  const citationRows = opts.cacheDb
    ? citationEvidence(edb, opts.cacheDb, vaultId, maxEvidence)
    : [];
  if (episodes.length === 0 && citationRows.length === 0) {
    return { skipped: true, aborted: false, applied: 0, version: 0 };
  }
  const windows = groupEpisodesByVerdictWindow(episodes);
  const citationWindows = groupCitationEvidenceByEventGroup(citationRows);
  const deltas = filterRegisteredDeltas([
    ...buildSearchModeDeltas(windows),
    ...buildCitationSearchModeDeltas(citationWindows),
  ]);
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
