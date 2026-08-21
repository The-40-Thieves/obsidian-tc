// THE-222 — reflect's sleep-time half: the evaluator pass over pending agent_episodes and the
// versioned preference profile (selective-addition stamp per THE-228; A-MemGuard-style
// cross-episode consistency per THE-238; ACE typed-delta preference updates per THE-232).
//
// Safety invariants, in order:
//   * born-'ineligible' rows (assessPoison's verdict at capture, episodes.ts:184) are NEVER
//     raised here — this pass's WHERE never selects them. THE-701 removed the judge layer that
//     used to sit here; see docs/design/experiential-reflection.md for the measurement.
//   * unstable evidence — the same caller+tool+args_hash showing BOTH ok and error among the
//     pending set — is held rather than promoted (contradictory runs are noise or an attack
//     surface, not a lesson yet).
//   * THE-565: an episode already judged a BAD result (`task_result = -1`) is held, never
//     auto-promoted — the one place this pass consults the task-result axis. Deliberate
//     asymmetry: a plain `status = 'error'` with no bad result still promotes ("errors are
//     lessons too"); only the explicit -1 is refused. THE-721: this gate is presently INERT
//     (no writer sets task_result = -1 on the live store) but stays wired for when one exists —
//     see the design note for the correction history.
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
 * THE-698 — the deterministic hold rules, as ONE derivation, shared by `evaluateEpisodes` and
 * `readEpisodeBacklog` so the two can never drift: a pending row is not evidence the evaluator is
 * broken (held rows are supposed to stay pending forever), so a health check needs to know how
 * many pending rows are actually promotable, not just how many are pending. See
 * docs/design/experiential-reflection.md for the measurement that motivated this.
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

  // THE-726: the WHERE re-checks `task_result` (not just `eligibility`) because this pass is not
  // transactional — a verdict stamping task_result = -1 can land in the gap between this pass's
  // read and this UPDATE. Without the re-check that race promotes the row anyway and it is never
  // re-inspected (the next pass selects only `pending`). See
  // docs/design/experiential-reflection.md for the full race sequence.
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
// NAMESPACE (THE-710; narrowed again by THE-891): the preference plane is partitioned BY VAULT —
// `vault_id` leads the primary key and every statement below is scoped to it. Migration
// 20260803_001 rebuilt both tables for this; see docs/design/experiential-reflection.md for the
// THE-310 defect class it replaced.
//
// THE CALLER AXIS IS PER-KEY, not global: `(vault_id, scope_caller, key)` is the full primary key
// (migration 20260820_001). WHICH partition a delta targets is a property of the delta record —
// see `PreferenceDelta.scopeCaller` and `scopeCallerFor`; this function never derives or defaults
// it, only writes wherever the caller says. Contrast: agent_episodes is per-principal at the ROW
// level; vault_object_state ACT-R activation is corpus-global; preference_profile is per-principal
// only for the keys that opt in.
//
// `vaultId` is REQUIRED and undefaulted for the same reason: a default would let a call site
// silently fall back to one shared bucket, which is the exact behaviour this partition removes.
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
 *  `any_caller` gate (tools/m8/work-search-tool.ts) — authorization-enforced, not filtered. The
 *  decision itself is computed at the MCP tool boundary (which has a `CallerContext`) and only the
 *  boolean crosses into this layer as `crossPrincipal`, since experiential cannot import from
 *  tools/ (dependency-cruiser's no-circular layering rule runs tools -> experiential only). */
export class PreferenceScopeError extends Error {}

/** THE-891: current profile rollup for ONE vault, scoped to ONE principal: entries with
 *  `scope_caller = ''` (the human/shared partition; a NULL caller — the single trusted local
 *  principal on an unauthenticated stdio transport — lands here too) UNION `caller`'s own
 *  partition. Active entries only (weight > 0), newest-touched first.
 *
 *  `caller` is required for the same reason `vaultId` is — an unscoped read would blend
 *  partitions this store exists to keep apart. `opts.anyCaller` crosses every principal's
 *  partition and requires `opts.crossPrincipal` proof, else throws `PreferenceScopeError` rather
 *  than silently narrowing. There is no "read every vault" overload; a caller wanting that must
 *  ask per vault (THE-710). */
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
 *  extractor may write, each declaring `"human"` (shared) or `"caller"` (partitioned) scope.
 *  Enforced in application code, not a DB CHECK (see design note for why). Deliberately one
 *  member — `preferred.search_mode` is the only axis with a real producer today, and it is
 *  `"caller"`-scoped dispatch telemetry (one agent's tool choice must not steer another's
 *  retrieval). Widen only when a new axis has a real producer; DEFAULT new keys to `"caller"` —
 *  sharing is a per-key opt-in, never the fallback. See docs/design/experiential-reflection.md for
 *  the four keys considered and rejected. */
export const PREFERENCE_KEYS: ReadonlyMap<string, PreferenceKeyScope> = new Map([
  ["preferred.search_mode", { scope: "caller" }],
]);

/** THE-891: the ONE place a producer derives `PreferenceDelta.scopeCaller` from a registered key
 *  plus the caller a window/evidence row carried. A `"human"`-scoped key always writes `''` — the
 *  shared partition, regardless of who was calling. A `"caller"`-scoped key writes
 *  `windowCaller ?? ''` (NULL collapses onto the shared `''` slot, matching migration
 *  `20260820_001`'s NULL-caller mapping, without inventing a shared identity between two different
 *  unauthenticated callers). An unregistered key defaults to caller-scoped (should never reach
 *  here — `filterRegisteredDeltas` drops those first). */
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
 * rendered judgement becomes one observation rather than N correlated rows. A task verdict is
 * rendered at session grain and PROJECTED onto every judgeable dispatch in its window; without
 * collapsing, a long tool-heavy task outweighs a careful one-call task for the same single
 * judgement — a LENGTH bias, not a quality signal. See docs/design/experiential-reflection.md for
 * the measured magnitude and the known row-budget/window-count limit this collapse has.
 *
 * Rows predating THE-726's producer have `verdict_at` NULL; they group under their own key so a
 * pre-projection row is never merged with an unrelated one.
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

/** THE-673: one window (one rendered judgement) yields AT MOST ONE delta — `preference_profile`'s
 *  primary key `(vault_id, key)` can only hold ONE current value, never a per-tool tally. When a
 *  window dispatched more than one distinct search-family tool, the MAJORITY tool wins (ties
 *  toward the most recently dispatched). A neutral/unjudged window (`task_result = 0`) or a window
 *  with no search-family tool produces no delta. `op` is `add` on the positive branch (upsert
 *  already reinforces); `weaken` stays UPDATE-only so it can never create a key from the negative
 *  side. See docs/design/experiential-reflection.md for the full rationale. */
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
 * THE-644: `chunk_retrievals` carries NO `vault_id` column (chunks live in cache.db, across the
 * experiential/cache membrane — see context-bundle.ts's header). Vault scoping here is therefore a
 * GROUND-TRUTH join against the TARGET vault's own cache.db `chunks` table, batched — the same
 * cross-store pattern note-quality.ts and metrics.ts use: a chunk id this vault's `chunks` table
 * does not contain is dropped rather than attributed to a default vault.
 *
 * `cacheDb` is undefined whenever `experiential.citationPreferences` is off, so this function is
 * never reached (zero query cost, not merely a discarded result). Rows are restricted to
 * `citation_state IS NOT NULL`: a row the citation pass never covered is unmeasured, not negative
 * evidence (same "unmeasured != bad" contract as note-quality.ts's `scoreNote`).
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
 *  for the same key `buildSearchModeDeltas` writes, not a new axis. One `event_group` window is
 *  one search call, so every row in it shares one `surface_type` (tool); the window verdict is
 *  CONFIRMED if any chunk was confirmed cited (strengthen), else REJECTED if any chunk was
 *  rejected and none confirmed (weaken), else no verdict (skip — unmeasured, not negative). A
 *  window whose tool is not in `SEARCH_FAMILY_TOOLS` is skipped for the same reason the episode
 *  producer restricts to that closed list: choice AMONG search alternatives, not citation for
 *  tools with no comparable substitute. */
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

/** Deterministic preference extraction (THE-673): evidence = recent task_result-bearing episodes,
 *  collapsed onto their `(session_id, verdict_at)` window and counted, never inferred from prose —
 *  THE-701's precedent (no judge layer; see file header). `skipped` means only "no evidence
 *  reached the window pass"; a run that finds evidence but derives no delta (every window neutral)
 *  is NOT skipped. `aborted` is retained for call-site compatibility but always `false` (a
 *  deterministic counter has no parse-failure mode). THE-644 adds `citation_state` as a second,
 *  optional evidence source (`opts.cacheDb`, a caller decision) — see
 *  docs/design/experiential-reflection.md for the history of what this axis used to be gated on. */
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
 * THE-698 — run the evaluator pass on the maintenance cadence. Registered beside
 * activation-recompute on the same `config.maintenance.intervalMinutes` cadence and behind the
 * same `experientialOpen` gate; no gateway dependency (like note-quality-enqueue), and since
 * THE-701 removed the judge, the deterministic layer is the only thing this pass can do.
 *
 * Every safety invariant lives in evaluateEpisodes and is unchanged by scheduling it: born-
 * 'ineligible' rows are untouchable by the WHERE, contradictory ok/error clusters are held, and a
 * known-bad outcome (-1) is held. Scheduling must never become a way to launder a row the
 * pre-ingest poison scanner already refused, so that is pinned by test. See
 * docs/design/experiential-reflection.md for the measurement that motivated wiring this up.
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
 * THE-698 — read the episode backlog WITHOUT evaluating anything. Diagnosing must never promote a
 * row, so this shares `partitionPending` with the evaluator rather than mutating through it — see
 * docs/design/experiential-reflection.md for why a plain `pending` count was tried first and found
 * wrong.
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
