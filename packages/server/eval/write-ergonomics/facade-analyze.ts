// Aggregate the facade-mode study (runs/<mode>/<arm>/<client>/<task>__rN/result.json) into per-cell
// tables, apply the decision rule frozen in the study's PREREGISTRATION.md, and emit artifacts that
// eval/history.ts records (one per client: baseline = triad, graph = the other mode).
//
// Usage: bun eval/write-ergonomics/facade-analyze.ts --root <dir> [--runs runs] [--out results.json]
//          [--tables tables.md] [--artifact-prefix hist] [--task-set tasks.yaml]
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { QueryMetrics } from "../metrics";
import { loadTrials } from "./analyze";
import { readTap } from "./friction";
import type { TrialResult } from "./run";
import { ALL_TASKS, FACADE_TASK_IDS } from "./tasks";

export const MODES = ["triad", "domain", "flat"] as const;
type Mode = (typeof MODES)[number];

/** Modes within this many trials of the best success count are "tied" (pre-registered). */
export const TIE_TRIALS = 2;

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

export interface ModeCell {
  client: string;
  mode: Mode;
  trials: number;
  passes: number;
  /** Median server `tools/call` + client ToolSearch calls over PASSING trials. */
  medianCallsToSuccess: number;
  /** Trials with at least one server unknown-tool answer or client-side No-such-tool error. */
  notFoundTrials: number;
  notFoundEvents: number;
  medianBillable: number;
  meanCacheWrite: number;
  meanToolSearch: number;
  meanDiscovery: number;
  errors: number;
  timeouts: number;
  toolsListCount?: number;
  toolsListBytes?: number;
}

export const trialCalls = (t: TrialResult): number => t.friction.toolsCalls + t.toolSearchCalls;
export const trialNotFound = (t: TrialResult): number => t.friction.toolNotFound + t.clientNotFound;

export function modeCells(all: TrialResult[]): ModeCell[] {
  const cells: ModeCell[] = [];
  const ids = new Set(FACADE_TASK_IDS);
  const trials = all.filter((t) => t.facade && ids.has(t.task));
  for (const client of [...new Set(trials.map((t) => t.client))].sort()) {
    for (const mode of MODES) {
      const ts = trials.filter((t) => t.client === client && t.facade === mode);
      if (ts.length === 0) continue;
      const passing = ts.filter((t) => t.pass);
      const tap = readTap(join(ts[0]?.runDir ?? "", "tap.jsonl")).find(
        (e) => e.tool === "<tools/list>",
      ) as { toolCount?: number; bytes?: number } | undefined;
      cells.push({
        client,
        mode,
        trials: ts.length,
        passes: passing.length,
        medianCallsToSuccess: median(passing.map(trialCalls)),
        notFoundTrials: ts.filter((t) => trialNotFound(t) > 0).length,
        notFoundEvents: sum(ts.map(trialNotFound)),
        medianBillable: median(ts.map((t) => t.usage.billable)),
        meanCacheWrite: Math.round(sum(ts.map((t) => t.usage.cacheWrite)) / ts.length),
        meanToolSearch: sum(ts.map((t) => t.toolSearchCalls)) / ts.length,
        meanDiscovery: sum(ts.map((t) => t.friction.discoveryCalls)) / ts.length,
        errors: sum(ts.map((t) => t.friction.errors)),
        timeouts: ts.filter((t) => t.timedOut).length,
        toolsListCount: tap?.toolCount,
        toolsListBytes: tap?.bytes,
      });
    }
  }
  return cells;
}

export interface Verdict {
  client: string;
  recommended: Mode;
  tied: Mode[];
  /** Two modes within the tie band on success and not separable on the tiebreakers: needs reps 3-4. */
  close: boolean;
  reason: string;
}

/** The frozen rule. 1: rank by success, tie band TIE_TRIALS. 2: among tied, fewer median calls, then
 *  fewer not-found trials, then fewer median billable tokens. 3: keep `triad` unless another mode beats
 *  it on success by more than the band, or ties it and wins BOTH calls and not-found. 4: close cells. */
export function decide(cells: ModeCell[]): Verdict[] {
  const out: Verdict[] = [];
  for (const client of [...new Set(cells.map((c) => c.client))]) {
    const cs = cells.filter((c) => c.client === client);
    const best = Math.max(...cs.map((c) => c.passes));
    const tied = cs.filter((c) => best - c.passes <= TIE_TRIALS);
    const key = (c: ModeCell): number[] => [
      c.medianCallsToSuccess,
      c.notFoundTrials,
      c.medianBillable,
    ];
    const cmp = (a: ModeCell, b: ModeCell): number => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return (ka[i] ?? 0) - (kb[i] ?? 0);
      return 0;
    };
    const ranked = [...tied].sort(cmp);
    const winner = ranked[0] as ModeCell;
    const triad = cs.find((c) => c.mode === "triad");
    let recommended: Mode = winner.mode;
    let reason = `best success ${winner.passes}/${winner.trials} within the tie band, fewest calls`;
    if (triad && winner.mode !== "triad") {
      const beats = winner.passes - triad.passes > TIE_TRIALS;
      const bothBetter =
        tied.includes(triad) &&
        winner.medianCallsToSuccess < triad.medianCallsToSuccess &&
        winner.notFoundTrials < triad.notFoundTrials;
      if (!beats && !bothBetter) {
        recommended = "triad";
        reason = "no mode beats the shipped default by the pre-registered margin";
      } else
        reason = beats
          ? "beats triad on success by more than the tie band"
          : "ties triad on success, better on calls and not-found";
    }
    const second = ranked.find((c) => c.mode !== winner.mode);
    const close =
      second !== undefined &&
      Math.abs(second.medianCallsToSuccess - winner.medianCallsToSuccess) <= 0.5 &&
      second.notFoundTrials === winner.notFoundTrials;
    out.push({ client, recommended, tied: tied.map((c) => c.mode), close, reason });
  }
  return out;
}

export function tables(trials: TrialResult[], cells: ModeCell[], verdicts: Verdict[]): string {
  const L: string[] = [];
  L.push("### Per client x mode\n");
  L.push(
    "| client | mode | trials | success | median calls-to-success | tool-not-found trials (events) | median billable | mean cache-write | mean ToolSearch | mean discovery | errors | timeouts | tools/list (count, KB) |",
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of cells)
    L.push(
      `| ${c.client} | ${c.mode} | ${c.trials} | ${c.passes}/${c.trials} (${((100 * c.passes) / c.trials).toFixed(0)}%) | ${c.medianCallsToSuccess} | ${c.notFoundTrials} (${c.notFoundEvents}) | ${c.medianBillable} | ${c.meanCacheWrite} | ${c.meanToolSearch.toFixed(2)} | ${c.meanDiscovery.toFixed(2)} | ${c.errors} | ${c.timeouts} | ${c.toolsListCount ?? "-"}, ${c.toolsListBytes ? (c.toolsListBytes / 1024).toFixed(0) : "-"} |`,
    );
  L.push("\n### Pass count per task (passes/trials) by mode\n");
  const clients = [...new Set(cells.map((c) => c.client))];
  L.push(`| task | ${clients.flatMap((c) => MODES.map((m) => `${c} ${m}`)).join(" | ")} |`);
  L.push(`| --- | ${clients.flatMap(() => MODES.map(() => "---")).join(" | ")} |`);
  for (const id of FACADE_TASK_IDS) {
    const row = clients.flatMap((c) =>
      MODES.map((m) => {
        const ts = trials.filter((t) => t.client === c && t.facade === m && t.task === id);
        return ts.length ? `${ts.filter((t) => t.pass).length}/${ts.length}` : "-";
      }),
    );
    L.push(`| ${id} | ${row.join(" | ")} |`);
  }
  L.push("\n### Decision rule (pre-registered)\n");
  L.push("| client | recommended | tied on success | close cell | reason |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const v of verdicts)
    L.push(
      `| ${v.client} | ${v.recommended} | ${v.tied.join(", ")} | ${v.close ? "yes: reps 3-4" : "no"} | ${v.reason} |`,
    );
  L.push("\n### Not-found and error codes by mode\n");
  L.push("| client | mode | tool / code | n |");
  L.push("| --- | --- | --- | --- |");
  const rows = new Map<string, number>();
  for (const t of trials) {
    for (const e of t.friction.errorRows) {
      const k = `${t.client}\t${t.facade}\t${e.tool} / ${e.code}`;
      rows.set(k, (rows.get(k) ?? 0) + 1);
    }
    if (t.clientNotFound > 0) {
      const k = `${t.client}\t${t.facade}\t(client) no such tool`;
      rows.set(k, (rows.get(k) ?? 0) + t.clientNotFound);
    }
  }
  for (const [k, n] of [...rows].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    const [c, m, tc] = k.split("\t");
    L.push(`| ${c} | ${m} | ${tc} | ${n} |`);
  }
  return `${L.join("\n")}\n`;
}

/** history.ts record shape (see analyze.ts): `baseline` = triad, `graph` = `vs`. One "query" per task.
 *  recall@10 := majority of that task's trials passed, mrr@10 := 1/(1 + calls above refCalls) on the
 *  median calls of passing trials, ndcg@10 := passed with no error and no not-found in the first trial. */
export function artifact(
  trials: TrialResult[],
  client: string,
  vs: Mode,
): { flags: string[]; perQuery: unknown[] } {
  const side = (mode: Mode, id: string): QueryMetrics => {
    const ts = trials.filter((t) => t.client === client && t.facade === mode && t.task === id);
    const pass = ts.filter((t) => t.pass);
    const ref = ALL_TASKS.find((t) => t.id === id)?.refCalls ?? 0;
    const calls = median(pass.map(trialCalls));
    const first = ts[0];
    const ok = pass.length * 2 > ts.length ? 1 : 0;
    return {
      query_id: id,
      recall_at_10: ok,
      mrr_at_10: ok ? 1 / (1 + Math.max(0, calls - ref)) : 0,
      ndcg_at_10:
        ok && first?.pass && first.friction.errors === 0 && trialNotFound(first) === 0 ? 1 : 0,
      bridge_recall: 0,
      bridge_ndcg_at_10: null,
      expected_found_in_top10: ok,
      expected_total: 1,
      bridge_satisfied: false,
      result_paths_unique: 0,
      leaked_paths: null,
    };
  };
  return {
    flags: ["facade-modes", `client=${client}`, "baseline=triad", `graph=${vs}`],
    perQuery: FACADE_TASK_IDS.map((id) => ({
      id,
      baseline: side("triad", id),
      graph: side(vs, id),
      hard: false,
      z1: 0,
    })),
  };
}

export function taskSet(): string {
  return stringifyYaml({
    queries: FACADE_TASK_IDS.map((id) => {
      const t = ALL_TASKS.find((x) => x.id === id);
      return {
        id,
        query_text: t?.prompt ?? "",
        seed_domain: t?.arm ?? "main",
        target_domain: "facade-modes",
        seed_paths: [],
        target_paths: [],
        bridge_paths: [],
        description: t?.title ?? "",
      };
    }),
  });
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function main(): void {
  const argv = process.argv.slice(2);
  const root = resolve(flag(argv, "--root") ?? "");
  const trials = loadTrials(root, flag(argv, "--runs") ?? "runs").filter((t) => t.facade);
  const cells = modeCells(trials);
  const verdicts = decide(cells);
  const out = flag(argv, "--out");
  if (out) writeFileSync(out, JSON.stringify({ cells, verdicts, trials }, null, 2));
  const tb = tables(trials, cells, verdicts);
  const tp = flag(argv, "--tables");
  if (tp) writeFileSync(tp, tb);
  else process.stdout.write(tb);
  const prefix = flag(argv, "--artifact-prefix");
  if (prefix)
    for (const client of [...new Set(cells.map((c) => c.client))])
      for (const vs of ["domain", "flat"] as const)
        writeFileSync(
          `${prefix}-${client}-triad-vs-${vs}.json`,
          JSON.stringify(artifact(trials, client, vs), null, 2),
        );
  const ts = flag(argv, "--task-set");
  if (ts) writeFileSync(ts, taskSet());
}

if ((import.meta as unknown as { main?: boolean }).main) main();
