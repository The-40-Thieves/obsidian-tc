// Aggregate the per-trial result.json files into results.json, markdown tables, and an artifact
// eval/history.ts can record.
//
// Usage: bun eval/write-ergonomics/analyze.ts --root <dir> [--runs runs] [--out results.json]
//          [--tables tables.md] [--artifact history-artifact.json] [--task-set tasks.yaml] [--check]
//
// --check is the floor: every task has at least one trial for every client that has any trial, the
// results file parses, and no trial is recorded with an unparseable client output.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { QueryMetrics } from "../metrics";
import type { TrialResult } from "./run";
import { TASKS } from "./tasks";

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

export function loadTrials(root: string, runs = "runs"): TrialResult[] {
  const out: TrialResult[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (!statSync(p).isDirectory()) continue;
      try {
        out.push(JSON.parse(readFileSync(join(p, "result.json"), "utf8")) as TrialResult);
      } catch {
        walk(p);
      }
    }
  };
  walk(join(root, runs));
  return out;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

export interface Cell {
  client: string;
  task: string;
  arm: string;
  runs: number;
  passes: number;
  /** Fails in >= 2 of the runs recorded (the pre-registered "systematic" bar needs 3 runs). */
  systematic: boolean;
  medianReal: number;
  refCalls: number;
  excess: number;
  errors: number;
  retries: number;
  billable: number;
  wallS: number;
  codes: Record<string, number>;
}

export function summarize(trials: TrialResult[]): Cell[] {
  const ref = new Map(TASKS.map((t) => [t.id, t.refCalls]));
  const keys = [...new Set(trials.map((t) => `${t.client}\t${t.task}`))].sort();
  return keys.map((k) => {
    const [client = "", task = ""] = k.split("\t");
    const ts = trials.filter((t) => t.client === client && t.task === task);
    const codes: Record<string, number> = {};
    for (const t of ts)
      for (const e of t.friction.errorRows) codes[e.code] = (codes[e.code] ?? 0) + 1;
    const medianReal = median(ts.map((t) => t.friction.realCalls));
    const refCalls = ref.get(task) ?? 0;
    return {
      client,
      task,
      arm: ts[0]?.arm ?? "",
      runs: ts.length,
      passes: ts.filter((t) => t.pass).length,
      systematic: ts.length >= 2 && ts.filter((t) => !t.pass).length >= 2,
      medianReal,
      refCalls,
      excess: medianReal - refCalls,
      errors: sum(ts.map((t) => t.friction.errors)),
      retries: sum(ts.map((t) => t.friction.retries)),
      billable: Math.round(sum(ts.map((t) => t.usage.billable)) / ts.length),
      wallS: Math.round(sum(ts.map((t) => t.wallMs)) / ts.length / 1000),
      codes,
    };
  });
}

export function tables(trials: TrialResult[], cells: Cell[]): string {
  const clients = [...new Set(trials.map((t) => t.client))].sort();
  const lines: string[] = [];
  lines.push(
    "### Per task (pass/runs, median real calls vs reference, errors, mean billable tokens, mean wall s)\n",
  );
  lines.push(
    `| task | arm | ${clients.map((c) => `${c} pass | ${c} calls (ref) | ${c} err | ${c} tok | ${c} s`).join(" | ")} |`,
  );
  lines.push(`| --- | --- | ${clients.map(() => "--- | --- | --- | --- | ---").join(" | ")} |`);
  for (const t of TASKS) {
    const cols = clients.map((c) => {
      const x = cells.find((k) => k.client === c && k.task === t.id);
      return x
        ? `${x.passes}/${x.runs}${x.systematic ? " SYS" : ""} | ${x.medianReal} (${x.refCalls}) | ${x.errors} | ${x.billable} | ${x.wallS}`
        : "- | - | - | - | -";
    });
    lines.push(`| ${t.id} | ${t.arm} | ${cols.join(" | ")} |`);
  }
  lines.push("\n### Per client totals (first run of each task)\n");
  lines.push(
    "| client | trials | pass | tool calls | discovery | errors | with recovery hint | recovered | elicit_required | billable tokens | cacheRead tokens |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of clients) {
    const ts = trials.filter((t) => t.client === c);
    const f = (g: (t: TrialResult) => number) => sum(ts.map(g));
    lines.push(
      `| ${c} | ${ts.length} | ${ts.filter((t) => t.pass).length} | ${f((t) => t.friction.toolsCalls)} | ${f((t) => t.friction.discoveryCalls)} | ${f((t) => t.friction.errors)} | ${f((t) => t.friction.errorsWithRecovery)} | ${f((t) => t.friction.errorsRecovered)} | ${f((t) => t.friction.elicitRequired)} | ${f((t) => t.usage.billable)} | ${f((t) => t.usage.cacheRead)} |`,
    );
  }
  lines.push("\n### Error codes by tool (all trials)\n");
  const rows = new Map<
    string,
    { n: number; hint: number; recovered: number; tasks: Set<string>; clients: Set<string> }
  >();
  for (const t of trials) {
    for (const e of t.friction.errorRows) {
      const k = `${e.tool}\t${e.code}`;
      const r = rows.get(k) ?? {
        n: 0,
        hint: 0,
        recovered: 0,
        tasks: new Set<string>(),
        clients: new Set<string>(),
      };
      r.n++;
      r.hint += e.hasRecovery ? 1 : 0;
      r.recovered += e.recovered ? 1 : 0;
      r.tasks.add(t.task);
      r.clients.add(t.client);
      rows.set(k, r);
    }
  }
  lines.push("| tool | code | n | with recovery | recovered | tasks | clients |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const [k, r] of [...rows].sort((a, b) => b[1].n - a[1].n)) {
    const [tool, code] = k.split("\t");
    lines.push(
      `| ${tool} | ${code} | ${r.n} | ${r.hint} | ${r.recovered} | ${r.tasks.size} | ${[...r.clients].join(",")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** history.ts's record shape: `baseline` = the first client, `graph` = the second (the same structural
 *  re-use search-and-read-cost.ts documents). One "query" per task. recall@10 := success (majority of
 *  runs), mrr@10 := 1/(1+max(0, median real calls - refCalls)) (call efficiency), ndcg@10 := 1 when
 *  the task passed with zero errors on its first run (first-try clean). */
export function artifact(
  trials: TrialResult[],
  cells: Cell[],
): { flags: string[]; perQuery: unknown[] } {
  const clients = [...new Set(trials.map((t) => t.client))].sort();
  const side = (client: string, task: string): QueryMetrics => {
    const c = cells.find((k) => k.client === client && k.task === task);
    const first = trials.find((t) => t.client === client && t.task === task);
    const pass = c && c.passes * 2 > c.runs ? 1 : 0;
    return {
      query_id: task,
      recall_at_10: pass,
      mrr_at_10: c ? 1 / (1 + Math.max(0, c.excess)) : 0,
      ndcg_at_10: pass === 1 && first?.friction.errors === 0 ? 1 : 0,
      bridge_recall: 0,
      bridge_ndcg_at_10: null,
      expected_found_in_top10: pass,
      expected_total: 1,
      bridge_satisfied: false,
      result_paths_unique: 0,
      leaked_paths: null,
    };
  };
  const [a = "claude", b = a] = clients;
  return {
    flags: ["write-ergonomics", `baseline=${a}`, `graph=${b}`],
    perQuery: TASKS.filter((t) => cells.some((c) => c.task === t.id)).map((t) => ({
      id: t.id,
      baseline: side(a, t.id),
      graph: side(b, t.id),
      hard: false,
      z1: 0,
    })),
  };
}

/** The task list in the golden-set shape history.ts's --corpus expects, so a recorded run carries the
 *  task set's sha256 and diff refuses to compare runs measured on different task lists. */
export function taskSet(): string {
  return stringifyYaml({
    queries: TASKS.map((t) => ({
      id: t.id,
      query_text: t.prompt,
      seed_domain: t.arm,
      target_domain: "write-ergonomics",
      seed_paths: [],
      target_paths: [],
      bridge_paths: [],
      description: t.title,
    })),
  });
}

export function check(trials: TrialResult[]): string[] {
  const problems: string[] = [];
  if (trials.length === 0) problems.push("no trials found");
  for (const c of new Set(trials.map((t) => t.client))) {
    for (const t of TASKS) {
      if (!trials.some((x) => x.client === c && x.task === t.id))
        problems.push(`${c}: no trial for ${t.id}`);
    }
  }
  for (const t of trials)
    if (t.finalText.startsWith("<unparseable"))
      problems.push(`${t.client}/${t.task}: unparseable client output`);
  return problems;
}

function main(): void {
  const argv = process.argv.slice(2);
  const root = resolve(flag(argv, "--root") ?? "");
  const trials = loadTrials(root, flag(argv, "--runs") ?? "runs");
  if (argv.includes("--check")) {
    const problems = check(trials);
    for (const p of problems) process.stderr.write(`${p}\n`);
    process.stdout.write(`${trials.length} trials, ${problems.length} problems\n`);
    process.exit(problems.length === 0 ? 0 : 1);
  }
  const cells = summarize(trials);
  const out = flag(argv, "--out");
  if (out)
    writeFileSync(
      out,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), trials, cells }, null, 2)}\n`,
    );
  const tb = flag(argv, "--tables");
  if (tb) writeFileSync(tb, tables(trials, cells));
  const ts = flag(argv, "--task-set");
  if (ts) writeFileSync(ts, taskSet());
  const art = flag(argv, "--artifact");
  if (art) writeFileSync(art, `${JSON.stringify(artifact(trials, cells), null, 2)}\n`);
  process.stdout.write(`${trials.length} trials, ${cells.length} client x task cells\n`);
}

if ((import.meta as unknown as { main?: boolean }).main) main();
