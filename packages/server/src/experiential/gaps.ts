// THE-48 (local re-scope, 2026-07-11 flywheel decision) — the gap detector, batch-in-cycle-close
// instead of a Linear-webhook worker. The server DETECTS (this module + the `gaps` CLI); the
// cycle-close session FILES the "Knowledge gap: ..." issues via the Linear MCP with this report
// in hand. The original 0.75-cosine threshold is meaningless on this engine (fused RRF scores
// are rank-reciprocal sums, not similarities), so the threshold is CALIBRATED from the n=136
// golden set's top-1 score distribution (`gaps --calibrate`): a query whose best hit scores
// below what essentially every answerable query achieves has no real coverage.
export interface GapQuery {
  id: string;
  query: string;
}

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

/** Calibrated 2026-07-12 against the n=136 golden set on the live nomic-768 enriched index:
 *  top-1 fused scores ran min=0.1154 / p5=0.1389 / p10=0.1497 / median=0.1833. Shipped default
 *  = p5 rounded down — an answerable query essentially never scores below this (~5% false-flag
 *  rate on answerable-like queries by construction). Override per run with --threshold;
 *  re-calibrate with --calibrate after engine changes. */
export const DEFAULT_GAP_THRESHOLD = 0.138;
export const DEFAULT_GAP_MIN_RESULTS = 2;

export async function detectGaps(
  queries: GapQuery[],
  search: (query: string) => Promise<Array<{ path: string; score: number }>>,
  opts: { threshold?: number; minResults?: number; nearestN?: number } = {},
): Promise<GapReport> {
  const threshold = opts.threshold ?? DEFAULT_GAP_THRESHOLD;
  const minResults = opts.minResults ?? DEFAULT_GAP_MIN_RESULTS;
  const nearestN = opts.nearestN ?? 3;
  const items: GapItem[] = [];
  for (const q of queries) {
    const hits = await search(q.query);
    const top = hits[0];
    const gap = top === undefined || top.score < threshold || hits.length < minResults;
    items.push({
      id: q.id,
      query: q.query,
      top_score: top?.score ?? null,
      results: hits.length,
      gap,
      nearest: hits.slice(0, nearestN).map((h) => ({ path: h.path, score: h.score })),
    });
  }
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
