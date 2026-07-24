// Persistent run history for the retrieval eval — the reporting layer the harness lacks.
//
// The statistics here are already stronger than any generic eval runner's: compare.ts does a
// paired permutation test with Benjamini-Hochberg across the metric family, a non-inferiority
// floor, and an MDE so a null reads as "no effect" rather than "underpowered". What was missing
// is bookkeeping. Runs went to ad-hoc paths (eval-n216.json, eval-n252.json, review.json) with
// nothing recording which config produced which file, against which corpus, at which commit.
//
// Schema shape borrowed from evalite's SQLite storage (runs -> results -> scores), collapsed to
// this harness's shape: there is exactly one eval (the golden set), so evalite's `evals` level is
// dropped, and the aggregate metrics are denormalized into run_metrics so `list` does not have to
// re-aggregate 250 x k rows per row it prints.
//
// The one deliberate ADDITION to evalite's schema is corpus provenance: corpus_sha256 + the
// PARSED corpus_n. The recorded failure mode in this project is a comparison across runs whose
// corpora silently differed (a golden set whose own header said 136 while it held 250). `diff`
// refuses to compare across a corpus hash change unless forced. A schema that cannot express
// "these two runs are not comparable" invites exactly that mistake.
//
// Usage:
//   bun eval/history.ts record <artifact.json> [--corpus <golden-set.yaml>] [--label L] [--note N]
//   bun eval/history.ts list [--limit N]
//   bun eval/history.ts show <id>
//   bun eval/history.ts diff <idB> [idA]        # idA defaults to the previous run, same corpus
//   bun eval/history.ts export <out.html>
// All commands accept --db <path> (default: eval/runs.db).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { openDatabase } from "../src/db/open";
import type { Database } from "../src/db/types";
import { aggregateMetrics, GoldenSetSchema } from "./metrics";
import type { EvalQueryResult } from "./run";

const DEFAULT_DB = join(import.meta.dirname, "runs.db");
const SIDES = ["baseline", "graph"] as const;
type Side = (typeof SIDES)[number];

interface Artifact {
  flags?: string[];
  perQuery: EvalQueryResult[];
}

function schema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    INTEGER NOT NULL,
      label         TEXT,
      note          TEXT,
      flags         TEXT NOT NULL,
      source_path   TEXT NOT NULL,
      git_sha       TEXT,
      git_dirty     INTEGER NOT NULL DEFAULT 0,
      corpus_path   TEXT,
      corpus_sha256 TEXT,
      corpus_n      INTEGER,
      query_count   INTEGER NOT NULL,
      artifact      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_metrics (
      run_id INTEGER NOT NULL REFERENCES runs(id),
      side   TEXT NOT NULL,
      metric TEXT NOT NULL,
      value  REAL NOT NULL,
      PRIMARY KEY (run_id, side, metric)
    );
    CREATE INDEX IF NOT EXISTS runs_created_at ON runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS runs_corpus     ON runs(corpus_sha256, created_at DESC);
  `);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function sh(cmd: string, args: string[]): string | undefined {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** Parse the golden set and return its hash plus its ACTUAL length. Never trust a header —
 *  the canonical set's own header claimed 136 while it held 250. */
function corpusProvenance(path: string): { sha256: string; n: number } {
  const raw = readFileSync(path, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const parsed = GoldenSetSchema.parse(parseYaml(raw));
  return { sha256, n: parsed.queries.length };
}

function metricsOf(perQuery: EvalQueryResult[], side: Side): Record<string, number> {
  const agg = aggregateMetrics(perQuery.map((p) => p[side]));
  return {
    mean_recall_at_10: agg.mean_recall_at_10,
    mean_mrr_at_10: agg.mean_mrr_at_10,
    mean_ndcg_at_10: agg.mean_ndcg_at_10,
    bridge_recall_rate: agg.bridge_recall_rate,
    mean_bridge_ndcg_at_10: agg.mean_bridge_ndcg_at_10,
    bridge_query_count: agg.bridge_query_count,
    query_count: agg.query_count,
  };
}

function record(db: Database, argv: string[]): void {
  const source = argv[0];
  if (!source) die("usage: history.ts record <artifact.json> [--corpus <golden-set.yaml>] ...");
  const artifact = JSON.parse(readFileSync(source, "utf8")) as Artifact;
  if (!Array.isArray(artifact.perQuery) || artifact.perQuery.length === 0) {
    die(`${source} has no perQuery rows — refusing to record an empty run`);
  }

  const corpusPath = flag(argv, "--corpus");
  const corpus = corpusPath ? corpusProvenance(corpusPath) : undefined;
  if (corpus && corpus.n !== artifact.perQuery.length) {
    process.stderr.write(
      `WARNING: corpus declares ${corpus.n} queries but the artifact holds ${artifact.perQuery.length}. ` +
        `Recording as a PARTIAL run; it will not be comparable to a full one.\n`,
    );
  }

  const sha = sh("git", ["rev-parse", "HEAD"]);
  const dirty = sh("git", ["status", "--porcelain"]);

  const info = db
    .prepare(
      `INSERT INTO runs (created_at, label, note, flags, source_path, git_sha, git_dirty,
                         corpus_path, corpus_sha256, corpus_n, query_count, artifact)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      Date.now(),
      flag(argv, "--label") ?? null,
      flag(argv, "--note") ?? null,
      JSON.stringify(artifact.flags ?? []),
      source,
      sha ?? null,
      dirty ? 1 : 0,
      corpusPath ?? null,
      corpus?.sha256 ?? null,
      corpus?.n ?? null,
      artifact.perQuery.length,
      JSON.stringify(artifact),
    );
  const runId = Number(info.lastInsertRowid);

  const ins = db.prepare("INSERT INTO run_metrics (run_id, side, metric, value) VALUES (?,?,?,?)");
  for (const side of SIDES) {
    for (const [metric, value] of Object.entries(metricsOf(artifact.perQuery, side))) {
      ins.run(runId, side, metric, value);
    }
  }

  const g = metricsOf(artifact.perQuery, "graph");
  const b = metricsOf(artifact.perQuery, "baseline");
  process.stdout.write(
    `recorded run ${runId}  n=${artifact.perQuery.length}  flags=[${(artifact.flags ?? []).join(",") || "static"}]\n` +
      `  nDCG@10 ${b.mean_ndcg_at_10.toFixed(4)} -> ${g.mean_ndcg_at_10.toFixed(4)}` +
      `   recall@10 ${b.mean_recall_at_10.toFixed(4)} -> ${g.mean_recall_at_10.toFixed(4)}\n` +
      (dirty ? "  NOTE: working tree was dirty at record time\n" : ""),
  );
}

interface RunRow {
  id: number;
  created_at: number;
  label: string | null;
  flags: string;
  git_sha: string | null;
  git_dirty: number;
  corpus_sha256: string | null;
  corpus_n: number | null;
  query_count: number;
}

function runRows(db: Database, limit: number): RunRow[] {
  return db
    .prepare(
      `SELECT id, created_at, label, flags, git_sha, git_dirty, corpus_sha256, corpus_n, query_count
       FROM runs ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as RunRow[];
}

function metricFor(db: Database, runId: number, side: Side, metric: string): number | undefined {
  const r = db
    .prepare("SELECT value FROM run_metrics WHERE run_id=? AND side=? AND metric=?")
    .get(runId, side, metric) as { value: number } | undefined;
  return r?.value;
}

function list(db: Database, argv: string[]): void {
  const rows = runRows(db, Number(flag(argv, "--limit") ?? 20));
  if (rows.length === 0) {
    process.stdout.write("no runs recorded yet\n");
    return;
  }
  process.stdout.write(
    "  id  when              n    nDCG@10   recall@10  corpus    flags\n" +
      "  --  ----------------  ---  --------  ---------  --------  -----\n",
  );
  for (const r of rows) {
    const nd = metricFor(db, r.id, "graph", "mean_ndcg_at_10");
    const rc = metricFor(db, r.id, "graph", "mean_recall_at_10");
    const when = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
    const flags = (JSON.parse(r.flags) as string[]).join(",") || "static";
    process.stdout.write(
      `  ${String(r.id).padStart(2)}  ${when}  ${String(r.query_count).padStart(3)}  ` +
        `${(nd ?? 0).toFixed(4).padStart(8)}  ${(rc ?? 0).toFixed(4).padStart(9)}  ` +
        `${(r.corpus_sha256 ?? "-").slice(0, 8).padEnd(8)}  ${flags}${r.git_dirty ? "  [dirty]" : ""}` +
        `${r.label ? `  ${r.label}` : ""}\n`,
    );
  }
}

function show(db: Database, argv: string[]): void {
  const id = Number(argv[0]);
  const r = db.prepare("SELECT * FROM runs WHERE id=?").get(id) as
    | (RunRow & { note: string | null; source_path: string; corpus_path: string | null })
    | undefined;
  if (!r) die(`no run ${id}`);
  process.stdout.write(
    `run ${r.id}\n` +
      `  recorded   ${new Date(r.created_at).toISOString()}\n` +
      `  label      ${r.label ?? "-"}\n` +
      `  note       ${r.note ?? "-"}\n` +
      `  flags      ${(JSON.parse(r.flags) as string[]).join(",") || "static"}\n` +
      `  source     ${r.source_path}\n` +
      `  commit     ${r.git_sha ?? "-"}${r.git_dirty ? " (dirty)" : ""}\n` +
      `  corpus     ${r.corpus_path ?? "-"}  sha=${(r.corpus_sha256 ?? "-").slice(0, 12)}  declared_n=${r.corpus_n ?? "-"}\n` +
      `  queries    ${r.query_count}\n\n`,
  );
  for (const side of SIDES) {
    process.stdout.write(`  ${side}\n`);
    const rows = db
      .prepare("SELECT metric, value FROM run_metrics WHERE run_id=? AND side=? ORDER BY metric")
      .all(r.id, side) as { metric: string; value: number }[];
    for (const m of rows)
      process.stdout.write(`    ${m.metric.padEnd(24)} ${m.value.toFixed(4)}\n`);
  }
}

/** Delegates the statistics to compare.ts. There is one implementation of the ship gate and this
 *  is not it — materialize both artifacts and hand them to the tool that owns that arithmetic. */
function diff(db: Database, argv: string[]): void {
  const bId = Number(argv[0]);
  const b = db.prepare("SELECT * FROM runs WHERE id=?").get(bId) as
    | (RunRow & { artifact: string })
    | undefined;
  if (!b) die(`no run ${bId}`);

  let aId = argv[1] && !argv[1].startsWith("--") ? Number(argv[1]) : undefined;
  if (aId === undefined) {
    const prev = db
      .prepare(
        `SELECT id FROM runs
         WHERE created_at < ? AND (corpus_sha256 IS ? OR ? IS NULL)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(b.created_at, b.corpus_sha256, b.corpus_sha256) as { id: number } | undefined;
    if (!prev) die(`run ${bId} has no earlier run on the same corpus to compare against`);
    aId = prev.id;
  }
  const a = db.prepare("SELECT * FROM runs WHERE id=?").get(aId) as
    | (RunRow & { artifact: string })
    | undefined;
  if (!a) die(`no run ${aId}`);

  if (a.corpus_sha256 !== b.corpus_sha256 && !argv.includes("--force")) {
    die(
      `refusing to compare across a corpus change:\n` +
        `  run ${a.id} corpus sha ${a.corpus_sha256 ?? "unrecorded"} (n=${a.query_count})\n` +
        `  run ${b.id} corpus sha ${b.corpus_sha256 ?? "unrecorded"} (n=${b.query_count})\n` +
        `A delta across different corpora is not a delta. Re-run one side on the other's corpus,\n` +
        `or pass --force if you genuinely mean to compare unlike things.`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "eval-history-"));
  try {
    const aPath = join(dir, `run-${a.id}.json`);
    const bPath = join(dir, `run-${b.id}.json`);
    writeFileSync(aPath, a.artifact);
    writeFileSync(bPath, b.artifact);
    process.stdout.write(`A = run ${a.id}   B = run ${b.id}\n`);
    // compare.ts is a TypeScript entry point, so it must run under the same bun that ran us.
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "compare.ts"), aPath, bPath], {
      stdio: "inherit",
    });
    process.exitCode = r.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function exportHtml(db: Database, argv: string[]): void {
  const out = argv[0];
  if (!out) die("usage: history.ts export <out.html>");
  const rows = runRows(db, 500);
  const body = rows
    .map((r) => {
      const nd = metricFor(db, r.id, "graph", "mean_ndcg_at_10") ?? 0;
      const ndb = metricFor(db, r.id, "baseline", "mean_ndcg_at_10") ?? 0;
      const rc = metricFor(db, r.id, "graph", "mean_recall_at_10") ?? 0;
      const flags = (JSON.parse(r.flags) as string[]).join(", ") || "static";
      return `<tr><td>${r.id}</td><td>${new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")}</td>
<td>${esc(r.label ?? "")}</td><td class=n>${r.query_count}</td><td class=n>${ndb.toFixed(4)}</td>
<td class=n>${nd.toFixed(4)}</td><td class=n>${rc.toFixed(4)}</td>
<td class=m>${(r.corpus_sha256 ?? "-").slice(0, 8)}</td><td>${esc(flags)}</td>
<td class=m>${(r.git_sha ?? "-").slice(0, 8)}${r.git_dirty ? " *" : ""}</td></tr>`;
    })
    .join("\n");
  writeFileSync(
    out,
    `<!doctype html><meta charset=utf-8><title>obsidian-tc eval run history</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:2rem;max-width:70rem}
 table{border-collapse:collapse;width:100%} th,td{padding:.35rem .6rem;border-bottom:1px solid #8883;text-align:left}
 th{font-weight:600;white-space:nowrap} .n,.m{text-align:right;font-variant-numeric:tabular-nums}
 .m{font-family:ui-monospace,monospace;font-size:.85em;opacity:.75}
 caption{text-align:left;padding-bottom:.75rem;opacity:.75}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}}
</style>
<h1>obsidian-tc eval run history</h1>
<table><caption>${rows.length} runs. Runs with different corpus hashes are not comparable; an asterisk marks a dirty tree.</caption>
<tr><th>id<th>recorded<th>label<th>n<th>nDCG base<th>nDCG graph<th>recall@10<th>corpus<th>flags<th>commit</tr>
${body}
</table>`,
  );
  process.stdout.write(`wrote ${out} (${rows.length} runs)\n`);
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

function die(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1).filter((a, i, all) => a !== "--db" && all[i - 1] !== "--db");
  const db = await openDatabase(flag(argv, "--db") ?? DEFAULT_DB);
  schema(db);
  switch (cmd) {
    case "record":
      record(db, rest);
      break;
    case "list":
      list(db, rest);
      break;
    case "show":
      show(db, rest);
      break;
    case "diff":
      diff(db, rest);
      break;
    case "export":
      exportHtml(db, rest);
      break;
    default:
      die(
        "usage: bun eval/history.ts <record|list|show|diff|export> [...]\n" +
          "  record <artifact.json> [--corpus <golden-set.yaml>] [--label L] [--note N]\n" +
          "  list [--limit N]\n" +
          "  show <id>\n" +
          "  diff <idB> [idA] [--force]     # idA defaults to the previous run on the same corpus\n" +
          "  export <out.html>\n" +
          "  (all: --db <path>, default eval/runs.db)",
      );
  }
  db.close?.();
}

if ((import.meta as unknown as { main?: boolean }).main) {
  void main();
}
