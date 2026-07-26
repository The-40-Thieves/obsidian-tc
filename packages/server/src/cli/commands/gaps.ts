import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { openDatabase } from "../../db/open";
import { createEmbeddingProvider } from "../../embeddings";
import {
  DEFAULT_GAP_THRESHOLD,
  detectGaps,
  parseQueriesFile,
  scoreDistribution,
} from "../../experiential/gaps";
import { graphSearch } from "../../search/graph_search";
import { USAGE } from "../args";
import { type Cmd, resolveOrUsageExit } from "../shared";

export async function run_gaps(cmd: Cmd<"gaps">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  if (!cmd.queries && !cmd.calibrate) {
    process.stderr.write(`gaps requires --queries <file> or --calibrate <golden.yaml>\n\n${USAGE}`);
    process.exit(2);
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  const provider = createEmbeddingProvider(cfg.embeddings);
  const vaultId = cmd.vault ?? cfg.vaults[0]?.id ?? "main";
  const search = async (query: string): Promise<Array<{ path: string; score: number }>> => {
    const [vec] = await provider.embed([query], { input: "query" });
    const results = await graphSearch(cacheDb, {
      query,
      queryVec: vec ?? [],
      vaultId,
      model: provider.id, // THE-530: constrain seeds to the active model
      finalTopK: 10,
      ...(cfg.retrieval?.rrfK !== undefined ? { rrfK: cfg.retrieval.rrfK } : {}),
      reranker: null,
    });
    return results.map((r) => ({ path: r.path, score: r.rerank_score }));
  };
  try {
    if (cmd.calibrate) {
      const golden = parseYaml(readFileSync(cmd.calibrate, "utf8")) as {
        queries?: Array<{ id?: string; query_text?: string }>;
      };
      const qs = (golden.queries ?? []).filter((q) => typeof q.query_text === "string");
      const tops: number[] = [];
      for (const q of qs) {
        const hits = await search(q.query_text as string);
        if (hits[0]) tops.push(hits[0].score);
      }
      const d = scoreDistribution(tops);
      process.stdout.write(
        `calibrate (${vaultId}, n=${d.n}): min=${d.min.toFixed(4)} p5=${d.p5.toFixed(4)} p10=${d.p10.toFixed(4)} p25=${d.p25.toFixed(4)} median=${d.median.toFixed(4)}\n` +
          `suggested threshold (p5): ${d.p5.toFixed(4)} (shipped default ${DEFAULT_GAP_THRESHOLD})\n`,
      );
      return;
    }
    const queries = parseQueriesFile(readFileSync(cmd.queries as string, "utf8"));
    const report = await detectGaps(queries, search, {
      ...(cmd.threshold !== undefined ? { threshold: cmd.threshold } : {}),
      ...(cmd.minResults !== undefined ? { minResults: cmd.minResults } : {}),
    });
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
    cacheDb.close?.();
  }
  return;
}
