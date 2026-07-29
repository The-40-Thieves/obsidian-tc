import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { openDatabase } from "../../db/open";
import { createEmbeddingProvider } from "../../embeddings";
import {
  DEFAULT_GAP_THRESHOLD,
  detectGaps,
  type GapBatchSearchFn,
  parseQueriesFile,
  persistGapReport,
  scoreDistribution,
} from "../../experiential/gaps";
import { graphSearch } from "../../search/graph_search";
import { USAGE } from "../args";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

export async function run_gaps(cmd: Cmd<"gaps">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  if (!cmd.queries && !cmd.calibrate) {
    process.stderr.write(`gaps requires --queries <file> or --calibrate <golden.yaml>\n\n${USAGE}`);
    process.exit(2);
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  // THE-644 item 1: persist detectGaps' report here so it can be read back (the THE-611 MCP tool)
  // instead of recomputed. Provisioned unconditionally, same as `note-quality`'s CLI handler.
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  const provider = createEmbeddingProvider(cfg.embeddings);
  const vaultId = cmd.vault ?? cfg.vaults[0]?.id ?? "main";
  // THE-616: batch-shaped — ONE provider.embed(queries[]) call per invocation instead of one per
  // query, which was the dominant cost of a pass (this is the loop that runs the full 250-query
  // golden set under --calibrate, not just a detectGaps call). graphSearch still runs one query at
  // a time in a plain sequential loop (never Promise.all): only the embed call batches, so this
  // adds no extra concurrency pressure on the gateway.
  const search: GapBatchSearchFn = async (queries) => {
    if (queries.length === 0) return [];
    const vecs = await provider.embed(queries, { input: "query" });
    const out: Array<Array<{ path: string; score: number }>> = [];
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i] as string;
      const results = await graphSearch(cacheDb, {
        query,
        queryVec: vecs[i] ?? [],
        vaultId,
        model: provider.id, // THE-530: constrain seeds to the active model
        finalTopK: 10,
        ...(cfg.retrieval?.rrfK !== undefined ? { rrfK: cfg.retrieval.rrfK } : {}),
        reranker: null,
      });
      out.push(results.map((r) => ({ path: r.path, score: r.rerank_score })));
    }
    return out;
  };
  try {
    if (cmd.calibrate) {
      const golden = parseYaml(readFileSync(cmd.calibrate, "utf8")) as {
        queries?: Array<{ id?: string; query_text?: string }>;
      };
      const qs = (golden.queries ?? []).filter((q) => typeof q.query_text === "string");
      // THE-616: the loop the ticket's headline number (250 golden queries) actually runs —
      // batched the same way as the detectGaps path below.
      const hitsByQuery = await search(qs.map((q) => q.query_text as string));
      const tops: number[] = [];
      for (const hits of hitsByQuery) if (hits[0]) tops.push(hits[0].score);
      const d = scoreDistribution(tops);
      process.stdout.write(
        `calibrate (${vaultId}, n=${d.n}): min=${d.min.toFixed(4)} p5=${d.p5.toFixed(4)} p10=${d.p10.toFixed(4)} p25=${d.p25.toFixed(4)} median=${d.median.toFixed(4)} p75=${d.p75.toFixed(4)} p90=${d.p90.toFixed(4)} p95=${d.p95.toFixed(4)}\n` +
          `suggested threshold (p5): ${d.p5.toFixed(4)} (shipped default ${DEFAULT_GAP_THRESHOLD})\n`,
      );
      return;
    }
    const { queries, warnings } = parseQueriesFile(readFileSync(cmd.queries as string, "utf8"));
    for (const w of warnings) process.stderr.write(`gaps: ${w}\n`);
    const report = await detectGaps(queries, search, {
      ...(cmd.threshold !== undefined ? { threshold: cmd.threshold } : {}),
      ...(cmd.minResults !== undefined ? { minResults: cmd.minResults } : {}),
    });
    // THE-644 item 1: persist so a later pass (or the read-only gap_report MCP tool, THE-611) can
    // read this back. Advisory only — see experiential/gaps.ts for why nothing here auto-emits a
    // config delta from the observation.
    persistGapReport(edb, report, { vaultId, computedAt: Date.now() });
    process.stdout.write(
      `gaps ${vaultId}: ${report.gaps}/${report.total} below threshold ${report.threshold} (gap rate ${(report.gap_rate * 100).toFixed(1)}%)\n`,
    );
    for (const i of report.items.filter((x) => x.gap)) {
      process.stdout.write(
        `  GAP ${i.id}: "${i.query.slice(0, 80)}" top=${i.top_score?.toFixed(4) ?? "none"} results=${i.results}\n`,
      );
    }
    if (cmd.json) {
      writeFileSync(cmd.json, JSON.stringify(report, null, 2));
      process.stdout.write(`wrote ${cmd.json}\n`);
    }
  } finally {
    edb.close?.();
    cacheDb.close?.();
  }
  return;
}
