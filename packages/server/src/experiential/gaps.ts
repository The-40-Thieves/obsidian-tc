import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";
import { MIN_CALIBRATION_N, readLatestCalibration } from "./calibration";

// THE-48 (local re-scope, 2026-07-11 flywheel decision) — the gap detector, batch-in-cycle-close
// instead of a Linear-webhook worker. The server DETECTS (this module + the `gaps` CLI); the
// cycle-close session FILES the "Knowledge gap: ..." issues via the Linear MCP with this report
// in hand. The original 0.75-cosine threshold is meaningless on this engine (fused RRF scores
// are rank-reciprocal sums, not similarities), so the threshold is CALIBRATED from the n=136
// golden set's top-1 score distribution (`gaps --calibrate`): a query whose best hit scores
// below what essentially every answerable query achieves has no real coverage.
//
// THE-616: the golden set this pass runs against is 250 queries (the n=136 above is a HISTORICAL
// record of when the shipped threshold was calibrated — do not "fix" it), and a serial
// provider.embed(1)-per-query loop was the dominant cost of a pass. `search` below is
// batch-shaped so a caller does ONE provider.embed(queries[]) round trip instead of N; graphSearch
// itself still runs one query at a time (unbatchable, and not what was slow) so batching the embed
// call adds no extra concurrency pressure on the gateway.
//
// THE-644 item 1: a pass's GapReport can be persisted (persistGapReport) and read back later
// (readLatestGapReport) — the read half that lets the THE-611 MCP tool stay read-only instead of
// recomputing on every call.
export interface GapQuery {
  id: string;
  query: string;
}

/** One query's search results, as detectGaps needs them. */
export type GapSearchHits = Array<{ path: string; score: number }>;

/** THE-616: the injected search seam. Called ONCE per detectGaps run with every query string, in
 *  order; must return one result set per query, in the SAME order (index-aligned) — detectGaps
 *  trusts that alignment to build `items` in input order without re-sorting. */
export type GapBatchSearchFn = (queries: string[]) => Promise<GapSearchHits[]>;

export interface GapItem {
  id: string;
  query: string;
  top_score: number | null;
  results: number;
  gap: boolean;
  nearest: Array<{ path: string; score: number }>;
}

export interface GapReport {
  threshold: number;
  min_results: number;
  total: number;
  gaps: number;
  gap_rate: number;
  items: GapItem[];
}

/**
 * THE-891 item 4 — what this constant honestly IS, not what it was first documented as.
 *
 * Calibrated 2026-07-12 against the n=136 golden set on the live nomic-768 enriched index: top-1
 * fused scores ran min=0.1154 / p5=0.1389 / p10=0.1497 / median=0.1833 (shipped default = p5
 * rounded down). That is ONE vault's score distribution, on a representation (nomic-768) DELETED
 * 2026-07-31 (docs/EVALUATION.md — the store now runs BAAI/bge-m3) — so this number is doubly
 * stale: wrong engine, and never more than a single-vault sample to begin with.
 *
 * A fused RRF score is not comparable across vaults or engines (THE-733's score_calibration
 * migration explains why at length), which is exactly why it should never be the primary threshold
 * source. `resolveGapThreshold` below prefers a PER-VAULT calibration (`gaps --calibrate`,
 * persisted to `score_calibration`) whenever one exists with enough samples; this constant is the
 * LAST-RESORT fallback for a vault that has never been calibrated, kept only because "no threshold
 * at all" is worse than a documented-imperfect one. Every caller that falls back to it logs that it
 * did, so running uncalibrated is observable rather than silent.
 */
export const DEFAULT_GAP_THRESHOLD = 0.138;
export const DEFAULT_GAP_MIN_RESULTS = 2;

export interface ResolvedGapThreshold {
  threshold: number;
  /** "calibration" — a per-vault score_calibration row with enough samples was used.
   *  "fallback" — DEFAULT_GAP_THRESHOLD was used instead; `reason` says why. */
  source: "calibration" | "fallback";
  reason?: "not_calibrated" | "not_enough_samples";
}

/**
 * THE-891 item 4 — the threshold a caller should actually detect gaps with: the vault's own
 * calibration when one exists and is trustworthy, DEFAULT_GAP_THRESHOLD only as a last resort.
 *
 * Mirrors `confidenceFor`'s reasoning in calibration.ts (MIN_CALIBRATION_N floor: a percentile from
 * too few queries is an artifact of the sample, not a property of the vault) without depending on
 * a live top score — a threshold is chosen once per pass, before any query has been scored.
 *
 * `tableExists` guards a store that predates the score_calibration migration (20260805_002): it
 * degrades to the fallback rather than throwing "no such table" from inside a gap-detection pass.
 */
export function resolveGapThreshold(edb: Database, vaultId: string): ResolvedGapThreshold {
  if (!tableExists(edb, "score_calibration")) {
    return { threshold: DEFAULT_GAP_THRESHOLD, source: "fallback", reason: "not_calibrated" };
  }
  const calibration = readLatestCalibration(edb, vaultId);
  if (calibration === null) {
    return { threshold: DEFAULT_GAP_THRESHOLD, source: "fallback", reason: "not_calibrated" };
  }
  if (calibration.n < MIN_CALIBRATION_N) {
    return { threshold: DEFAULT_GAP_THRESHOLD, source: "fallback", reason: "not_enough_samples" };
  }
  return { threshold: calibration.p5, source: "calibration" };
}

export async function detectGaps(
  queries: GapQuery[],
  search: GapBatchSearchFn,
  opts: { threshold?: number; minResults?: number; nearestN?: number } = {},
): Promise<GapReport> {
  const threshold = opts.threshold ?? DEFAULT_GAP_THRESHOLD;
  const minResults = opts.minResults ?? DEFAULT_GAP_MIN_RESULTS;
  const nearestN = opts.nearestN ?? 3;
  // THE-616: ONE call for the whole batch, not one per query — the seam that lets a caller embed
  // every query in a single provider.embed(queries[]) round trip. Never call search per-query here.
  const hitsByQuery = queries.length === 0 ? [] : await search(queries.map((q) => q.query));
  if (hitsByQuery.length !== queries.length) {
    throw new Error(
      `gap search returned ${hitsByQuery.length} result set(s) for ${queries.length} quer(ies) — search() must return one entry per input query, in order`,
    );
  }
  // Preserve input order: items is built by mapping over `queries`, never by sorting or grouping
  // the batch response. The report is read by humans and diffed run-to-run, so a reorder would
  // look like a content change even when nothing about the underlying coverage changed.
  const items: GapItem[] = queries.map((q, i) => {
    const hits = hitsByQuery[i] ?? [];
    const top = hits[0];
    const gap = top === undefined || top.score < threshold || hits.length < minResults;
    return {
      id: q.id,
      query: q.query,
      top_score: top?.score ?? null,
      results: hits.length,
      gap,
      nearest: hits.slice(0, nearestN).map((h) => ({ path: h.path, score: h.score })),
    };
  });
  const gaps = items.filter((i) => i.gap).length;
  return {
    threshold,
    min_results: minResults,
    total: items.length,
    gaps,
    gap_rate: items.length === 0 ? 0 : gaps / items.length,
    items,
  };
}

/** Adapts a plain per-query search function into the batch-shaped seam `detectGaps` expects — for
 *  simple test stubs or a caller with no actual batching to do. Sequential (not Promise.all), so
 *  it preserves order without adding concurrency the caller didn't ask for. */
export function singleQuerySearch(fn: (query: string) => Promise<GapSearchHits>): GapBatchSearchFn {
  return async (queries) => {
    const out: GapSearchHits[] = [];
    for (const q of queries) out.push(await fn(q));
    return out;
  };
}

/** Nearest-rank percentiles over the top-1 score sample — the calibration output. THE-617 item
 *  1 extends this past the median (p75/p90/p95) on the SAME `at()` helper below — a hard
 *  prerequisite for THE-631, which needs the upper tail, not just where the threshold lives. */
export function scoreDistribution(scores: number[]): {
  n: number;
  min: number;
  p5: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  p95: number;
} {
  const s = [...scores].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
  return {
    n: s.length,
    min: s[0] ?? 0,
    p5: at(5),
    p10: at(10),
    p25: at(25),
    median: at(50),
    p75: at(75),
    p90: at(90),
    p95: at(95),
  };
}

export interface ParsedQueriesFile {
  queries: GapQuery[];
  /** THE-617 item 2 — a line that LOOKS like JSON (starts with "{") but fails to parse, or
   *  parses without a usable `query` string, degrades to a raw query line (unchanged behavior:
   *  a partly-malformed file must still produce a usable pass) but is no longer silently
   *  indistinguishable from a line that never claimed to be JSON. One entry per such line,
   *  naming its 1-indexed line number in the source file. */
  warnings: string[];
}

/** Parse a queries file: JSONL objects ({id?, query}) or plain one-query-per-line text. */
export function parseQueriesFile(raw: string): ParsedQueriesFile {
  const queries: GapQuery[] = [];
  const warnings: string[] = [];
  const rawLines = raw.split(/\r?\n/);
  for (let lineNo = 1; lineNo <= rawLines.length; lineNo++) {
    const line = (rawLines[lineNo - 1] as string).trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line) as { id?: unknown; query?: unknown };
        if (typeof obj.query === "string" && obj.query.length > 0) {
          queries.push({
            id: typeof obj.id === "string" ? obj.id : `q${queries.length + 1}`,
            query: obj.query,
          });
          continue;
        }
        warnings.push(
          `line ${lineNo}: looks like JSON but has no usable "query" string — treated as a raw query line`,
        );
      } catch {
        warnings.push(
          `line ${lineNo}: looks like JSON but failed to parse — treated as a raw query line`,
        );
      }
    }
    queries.push({ id: `q${queries.length + 1}`, query: line });
  }
  return { queries, warnings };
}

/** A persisted GapReport, tagged with the vault and pass it came from. */
export interface StoredGapReport extends GapReport {
  vault_id: string;
  computed_at: number;
}

export function hasGapReports(edb: Database): boolean {
  return tableExists(edb, "gap_reports");
}

/**
 * THE-644 item 1: persist a pass so it can be read back later instead of recomputed — the
 * precondition for the THE-611 read-only MCP tool. Append-only (one row per pass, like a run
 * log), NOT an upsert: a scheduled gaps pass is a new observation each time, and history across
 * passes is itself useful (did this query stop being a gap?). Silently no-ops on a handle that
 * predates this migration, matching recomputeNoteQuality's pre-migration handling.
 */
export function persistGapReport(
  edb: Database,
  report: GapReport,
  opts: { vaultId: string; computedAt: number },
): void {
  if (!hasGapReports(edb)) return;
  edb
    .prepare(
      `INSERT INTO gap_reports (vault_id, computed_at, threshold, min_results, total, gaps, gap_rate, items)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.vaultId,
      opts.computedAt,
      report.threshold,
      report.min_results,
      report.total,
      report.gaps,
      report.gap_rate,
      // `items` order is meaningful (input order, THE-616) and is preserved verbatim through
      // JSON — a plain array serializes and parses back in the same order.
      JSON.stringify(report.items),
    );
}

interface GapReportRow {
  vault_id: string;
  computed_at: number;
  threshold: number;
  min_results: number;
  total: number;
  gaps: number;
  gap_rate: number;
  items: string;
}

/** Read side for the THE-611 MCP tool (and any future CLI read verb): the most recent pass for a
 *  vault, or null when none has ever been persisted — "unmeasured", not an empty report. */
export function readLatestGapReport(edb: Database, vaultId: string): StoredGapReport | null {
  if (!hasGapReports(edb)) return null;
  const row = edb
    .prepare(
      `SELECT vault_id, computed_at, threshold, min_results, total, gaps, gap_rate, items
       FROM gap_reports WHERE vault_id = ? ORDER BY computed_at DESC, id DESC LIMIT 1`,
    )
    .get(vaultId) as GapReportRow | undefined;
  if (!row) return null;
  return {
    vault_id: row.vault_id,
    computed_at: row.computed_at,
    threshold: row.threshold,
    min_results: row.min_results,
    total: row.total,
    gaps: row.gaps,
    gap_rate: row.gap_rate,
    items: JSON.parse(row.items) as GapItem[],
  };
}
