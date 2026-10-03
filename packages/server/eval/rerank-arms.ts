// Reranker-arms eval: does a cross-encoder reranker over the SAME dense top-K improve retrieval?
//
// Three stages, each resumable and each writing plain JSON next to the others:
//   pools   dense top-K chunk pool per query (the real `search_semantic` handler: the control), the
//           production graph_rrf order (second control), the router class, candidate text. The pool
//           file carries vault text, so it stays under the experiment directory and is never committed.
//   rerank  one arm over the pools: provider call per query, latency and input size recorded, scores
//           cached per query so a re-run spends nothing on queries already answered.
//   score   metrics per arm against a golden set (pure rerank and RRF-fused with dense), paired
//           statistics, per-class breakdown, class-gated arm, and one `history.ts record` artifact per
//           arm. Numbers only, never a query or a path.
//
//   bun eval/rerank-arms.ts pools  <config.json> <golden> --out pools.json [--query-vecs v.json]
//        [--k 50] [--kind public|private]
//   bun --env-file=<keys> eval/rerank-arms.ts rerank <pools.json> --arm <name> --k 30 --out r.json
//        [--limit N] [--neuron-cap N] [--probe]
//   bun eval/rerank-arms.ts score  <golden> <pools.json> --results a.json,b.json --out-dir <dir>
//        [--controls graph] [--gate-classes standard,lexical]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config/load";
import { openConfiguredDatabase } from "../src/db/open";
import { createEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { compileEgressFilter } from "../src/plane/egress-filter";
import { graphSearch } from "../src/search/graph_search";
import { buildRepresentationManifest } from "../src/search/representation";
import {
  formatRerankPassage,
  type RerankPassageFormat,
  rerankWithScores,
} from "../src/search/rerank";
import { routeQuery } from "../src/search/router";
import { registerM2Tools } from "../src/tools/m2";
import { VaultRegistry } from "../src/vault/registry";
import { assertGoldenNotInVault } from "./golden-guard";
import {
  aggregateMetrics,
  computeQueryMetrics,
  type GoldenQuery,
  GoldenSetSchema,
  type QueryMetrics,
  type RankedChunk,
} from "./metrics";
import { ARMS, type ArmName, buildArm, PUBLIC_ONLY_ARMS } from "./rerank-adapters";
import {
  bhDecisions,
  corpusVerdict,
  denseOrder,
  estimateNeurons,
  gatedOrder,
  hopClass,
  type Pool,
  percentile,
  rerankOrder,
  rrfFuseOrder,
  type ScoreHit,
  summarizePaired,
  truncatePool,
} from "./rerank-arms-lib";

const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = argv
  .slice(1)
  .filter((a, i, all) => !a.startsWith("--") && !(all[i - 1] ?? "").startsWith("--"));
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
function die(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

interface PoolFile {
  kind: "public" | "private";
  k: number;
  excludePaths: string[];
  pools: Pool[];
  /** Production graph_rrf order (chunk ids + paths), the second control. */
  graph: Record<string, Array<{ chunk_id: string; path: string }>>;
}

async function stagePools(): Promise<void> {
  const [configPath, goldenPath] = pos;
  const out = flag("--out");
  const vecsPath = flag("--query-vecs");
  const k = Number(flag("--k") ?? 50);
  const kind = flag("--kind");
  if (!configPath || !goldenPath || !out || (kind !== "public" && kind !== "private"))
    die(
      "usage: pools <config.json> <golden> --out pools.json --kind public|private [--query-vecs v.json] [--k 50]",
    );

  const config = loadConfig(configPath);
  const vault = config.vaults[0];
  if (!vault) throw new Error("config.vaults is empty");
  const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath, "utf8")));
  // Fail before scoring if the vault quotes the golden set (see eval/golden-guard.ts).
  assertGoldenNotInVault(golden, vault.path);
  const vecs = new Map<string, number[]>(
    vecsPath
      ? Object.entries(JSON.parse(readFileSync(vecsPath, "utf8")) as Record<string, number[]>)
      : [],
  );
  const base = createEmbeddingProvider(config.embeddings, {
    excludeFilter: compileEgressFilter(config.egress.excludePaths),
    cacheDir: config.cacheDir,
  });
  const embedQuery = async (q: string): Promise<number[]> => {
    const hit = vecs.get(q);
    if (hit) return hit;
    const [v] = await base.embed([q], { input: "query" });
    if (!v) throw new Error("embedding provider returned no vector");
    vecs.set(q, v);
    return v;
  };
  const provider = Object.assign(Object.create(base), {
    embed: async (texts: string[], o?: { input?: "query" | "document" }): Promise<number[][]> =>
      o?.input === "query" ? Promise.all(texts.map(embedQuery)) : base.embed(texts, o),
  });
  const db = await openConfiguredDatabase(config, "cache.db");
  const registry = new ToolRegistry();
  registerM2Tools(registry, {
    vaultRegistry: new VaultRegistry(config.vaults),
    embeddingProvider: provider,
    representation: buildRepresentationManifest(provider, {}),
    metadataIndex: { hasFts: true, ready: () => true },
  });
  const ctx: CallerContext = {
    caller: "eval",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: vault.id,
    db,
  };
  const textOf = db.prepare("SELECT content FROM chunks WHERE id = ? AND vault_id = ?");

  const pools: Pool[] = [];
  const graph: PoolFile["graph"] = {};
  for (const q of golden.queries) {
    const r = await registry.dispatch(
      "search_semantic",
      { vault: vault.id, query: q.query_text, k, return_content: true },
      ctx,
    );
    if (!r.ok) throw new Error(`search_semantic: ${r.error.code}: ${r.error.message}`);
    const items = (
      r.data as { items: Array<{ path: string; chunk_id?: string; content?: string }> }
    ).items;
    const route = routeQuery(db, vault.id, q.query_text, { readUnrestricted: true });
    pools.push({
      id: q.id,
      query_text: q.query_text,
      route_class: route.class,
      candidates: items.map((h) => ({
        chunk_id: h.chunk_id ?? "",
        path: h.path,
        text:
          h.content ??
          (textOf.get(h.chunk_id ?? "", vault.id) as { content?: string } | undefined)?.content ??
          "",
      })),
    });
    // Production default order (graph_rrf), same query vector. A second control, not an arm.
    const qv = await embedQuery(q.query_text);
    const gh = await graphSearch(db, {
      query: q.query_text,
      queryVec: qv,
      vaultId: vault.id,
      finalTopK: k,
    });
    graph[q.id] = gh.map((h) => ({ chunk_id: h.chunk_id, path: h.path }));
    if (pools.length % 50 === 0)
      process.stderr.write(`  pooled ${pools.length}/${golden.queries.length}\n`);
  }
  const file: PoolFile = { kind, k, excludePaths: [...config.egress.excludePaths], pools, graph };
  writeFileSync(out, JSON.stringify(file));
  if (!vecsPath) writeFileSync(`${out}.qvecs.json`, JSON.stringify(Object.fromEntries(vecs)));
  const empty = pools.filter((p) => p.candidates.length === 0).length;
  const noText = pools.filter((p) => p.candidates.some((c) => c.text === "")).length;
  const routes: Record<string, number> = {};
  for (const p of pools) routes[p.route_class] = (routes[p.route_class] ?? 0) + 1;
  process.stdout.write(
    `pools n=${pools.length} k=${k} empty=${empty} pools_with_missing_text=${noText} routes=${JSON.stringify(routes)}\n`,
  );
  db.close?.();
}

interface QueryResult {
  hits: ScoreHit[];
  latency_ms: number;
  /** Characters sent to the provider (documents + query), the neuron-cost proxy. */
  chars_sent: number;
  outcome: string;
}
interface ResultFile {
  arm: ArmName;
  /** Sensitivity run: each passage was prefixed with its note title (the file name) before scoring. */
  title_prefix?: boolean;
  k: number;
  kind: "public" | "private";
  perQuery: Record<string, QueryResult>;
}

async function stageRerank(): Promise<void> {
  const [poolsPath] = pos;
  const arm = flag("--arm") as ArmName | undefined;
  const k = Number(flag("--k") ?? 30);
  const titlePrefix = argv.includes("--title-prefix");
  const passageFormat: RerankPassageFormat = titlePrefix ? "title+chunk" : "chunk";
  const out = flag("--out");
  const limit = flag("--limit") ? Number(flag("--limit")) : undefined;
  const neuronCap = flag("--neuron-cap") ? Number(flag("--neuron-cap")) : undefined;
  if (!poolsPath || !arm || !out || !ARMS.includes(arm))
    die(
      `usage: rerank <pools.json> --arm ${ARMS.join("|")} --k 30 --out r.json [--limit N] [--neuron-cap N]`,
    );
  const pf = JSON.parse(readFileSync(poolsPath, "utf8")) as PoolFile;
  if (PUBLIC_ONLY_ARMS.has(arm) && pf.kind !== "public")
    die(
      `${arm} is public-corpus only (its provider's terms allow training on submitted text); refusing a ${pf.kind} pool`,
    );
  const reranker = await buildArm(arm, process.env);
  const filter = compileEgressFilter(pf.excludePaths);
  // A local model loads on its first call; warm it on throwaway text so latency is steady-state.
  if (arm.startsWith("local-")) await reranker("warm up", ["a", "b", "c"], 3, ["a", "b", "c"]);
  const res: ResultFile = existsSync(out)
    ? (JSON.parse(readFileSync(out, "utf8")) as ResultFile)
    : { arm, k, kind: pf.kind, ...(titlePrefix ? { title_prefix: true } : {}), perQuery: {} };
  let spent = Object.values(res.perQuery).reduce((a, r) => a + estimateNeurons(r.chars_sent), 0);
  let done = 0;
  for (const full of pf.pools) {
    if (limit !== undefined && done >= limit) break;
    if (res.perQuery[full.id]?.outcome === "executed") continue;
    const pool = truncatePool(full, k);
    const docs = pool.candidates.map((c, index) => ({ content: c.text, path: c.path, index }));
    // Neuron-cost proxy: the characters actually sent, i.e. the passages as the product formats them.
    const chars =
      docs.reduce((a, d) => a + formatRerankPassage(d, passageFormat).length, 0) +
      full.query_text.length * docs.length;
    if (
      arm === "cf-bge-reranker-base" &&
      neuronCap !== undefined &&
      spent + estimateNeurons(chars) > neuronCap
    ) {
      process.stdout.write(
        `neuron cap ${neuronCap} reached at ~${spent.toFixed(1)}; stopping (resume later)\n`,
      );
      break;
    }
    let outcome = "unknown";
    const t0 = performance.now();
    const scored = await rerankWithScores(
      full.query_text,
      docs,
      docs.length,
      reranker,
      (o) => {
        outcome = o;
      },
      undefined,
      filter,
      // The SHIPPED seam (`reranker.passageFormat`), so the arm measures the product's passage.
      passageFormat,
    );
    // Provider time of the successful call; wall time (which includes throttle sleeps) only as a fallback.
    const latency = reranker.lastMs > 0 ? reranker.lastMs : performance.now() - t0;
    res.perQuery[full.id] = {
      hits: scored.map((s) => ({ index: s.item.index, score: s.score })),
      latency_ms: Math.round(latency),
      chars_sent: chars,
      outcome,
    };
    if (outcome === "executed") spent += estimateNeurons(chars);
    done++;
    writeFileSync(out, JSON.stringify(res));
    if (outcome !== "executed" || done % 25 === 0)
      process.stderr.write(
        `  ${arm} k=${k} ${Object.keys(res.perQuery).length}/${pf.pools.length} ${outcome} ${Math.round(latency)}ms\n`,
      );
  }
  const all = Object.values(res.perQuery);
  const ok = all.filter((r) => r.outcome === "executed");
  process.stdout.write(
    `${arm} k=${k}: ${ok.length}/${pf.pools.length} executed, ${all.length - ok.length} failed, ` +
      `latency p50 ${percentile(
        ok.map((r) => r.latency_ms),
        0.5,
      )}ms p95 ${percentile(
        ok.map((r) => r.latency_ms),
        0.95,
      )}ms` +
      (arm === "cf-bge-reranker-base" ? `, ~${spent.toFixed(1)} neurons spent in this file` : "") +
      "\n",
  );
}

/** Paired bridge-nDCG@10 delta over the queries that declare bridge notes (empty when none do). */
function bridgePaired(base: QueryMetrics[], arm: QueryMetrics[]): Record<string, number> {
  const idx = base.flatMap((m, i) =>
    m.bridge_ndcg_at_10 === null || arm[i]?.bridge_ndcg_at_10 === null ? [] : [i],
  );
  if (idx.length === 0) return {};
  const s = summarizePaired(
    idx.map((i) => base[i]?.bridge_ndcg_at_10 ?? 0),
    idx.map((i) => arm[i]?.bridge_ndcg_at_10 ?? 0),
  );
  return { delta: +s.delta.toFixed(4), p: +s.p.toFixed(4), wins: s.wins, losses: s.losses };
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function stageScore(): void {
  const [goldenPath, poolsPath] = pos;
  const resultPaths = (flag("--results") ?? "").split(",").filter(Boolean);
  const outDir = flag("--out-dir");
  const gateClasses = new Set((flag("--gate-classes") ?? "").split(",").filter(Boolean));
  const gateHop = flag("--gate-hop");
  if (!goldenPath || !poolsPath || !outDir)
    die(
      "usage: score <golden> <pools.json> --results a.json,b.json --out-dir <dir> [--gate-classes c1,c2]",
    );
  mkdirSync(outDir, { recursive: true });
  const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath, "utf8")));
  const pf = JSON.parse(readFileSync(poolsPath, "utf8")) as PoolFile;
  const poolById = new Map(pf.pools.map((p) => [p.id, p]));
  // Labels were normalized by GoldenSetSchema on load; computeQueryMetrics normalizes the results.
  const queries = golden.queries.filter((q) => poolById.has(q.id));
  const metricsOf = (q: GoldenQuery, order: RankedChunk[]): QueryMetrics =>
    computeQueryMetrics(q, order);

  interface Row {
    key: string;
    arm: string;
    k: number;
    mode: "rerank" | "rrf" | "gated";
    /** Query ids this row covers (an arm with failed queries is scored on the intersection). */
    ids: string[];
    arm_m: QueryMetrics[];
    base_m: QueryMetrics[];
    latency: number[];
    chars: number[];
  }
  const rows: Row[] = [];
  const resultFiles = resultPaths.map((p) => JSON.parse(readFileSync(p, "utf8")) as ResultFile);
  const ks = [...new Set(resultFiles.map((r) => r.k))];
  // Dense control per K (truncated pool) and the production graph control.
  const denseFor = (q: GoldenQuery, k: number): QueryMetrics =>
    metricsOf(q, denseOrder(truncatePool(poolById.get(q.id) as Pool, k)));
  if (Object.keys(pf.graph).length > 0) {
    const ids = queries.filter((q) => pf.graph[q.id]).map((q) => q.id);
    const qs = queries.filter((q) => ids.includes(q.id));
    rows.push({
      key: "graph_rrf (production order, control)",
      arm: "graph_rrf",
      k: 0,
      mode: "rerank",
      ids,
      arm_m: qs.map((q) => metricsOf(q, pf.graph[q.id] as RankedChunk[])),
      base_m: qs.map((q) => denseFor(q, pf.k)),
      latency: [],
      chars: [],
    });
  }
  for (const rf of resultFiles) {
    const label = rf.title_prefix ? `${rf.arm}+title` : rf.arm;
    const done = queries.filter((q) => rf.perQuery[q.id]?.outcome === "executed");
    const qs = done;
    const hitsOf = (q: GoldenQuery): ScoreHit[] => (rf.perQuery[q.id] as QueryResult).hits;
    const poolOf = (q: GoldenQuery): Pool => truncatePool(poolById.get(q.id) as Pool, rf.k);
    const common = {
      arm: label,
      k: rf.k,
      ids: qs.map((q) => q.id),
      base_m: qs.map((q) => denseFor(q, rf.k)),
      latency: qs.map((q) => (rf.perQuery[q.id] as QueryResult).latency_ms),
      chars: qs.map((q) => (rf.perQuery[q.id] as QueryResult).chars_sent),
    };
    rows.push({
      ...common,
      key: `${label} k=${rf.k}`,
      mode: "rerank",
      arm_m: qs.map((q) => metricsOf(q, rerankOrder(poolOf(q), hitsOf(q)))),
    });
    rows.push({
      ...common,
      key: `${label} k=${rf.k} +rrf`,
      mode: "rrf",
      arm_m: qs.map((q) => metricsOf(q, rrfFuseOrder(poolOf(q), hitsOf(q), 10))),
    });
    if (gateClasses.size > 0)
      rows.push({
        ...common,
        key: `${label} k=${rf.k} gated[${[...gateClasses].join("+")}]`,
        mode: "gated",
        arm_m: qs.map((q) => metricsOf(q, gatedOrder(poolOf(q), hitsOf(q), gateClasses))),
      });
    // Oracle ceiling, NOT deployable: the hop label comes from the golden set, which no live query has.
    if (gateHop)
      rows.push({
        ...common,
        key: `${label} k=${rf.k} oracle-hop[rerank ${gateHop} only]`,
        mode: "gated",
        arm_m: qs.map((q) =>
          metricsOf(
            q,
            hopClass(q) === gateHop ? rerankOrder(poolOf(q), hitsOf(q)) : denseOrder(poolOf(q)),
          ),
        ),
      });
  }

  const byId = new Map(queries.map((q) => [q.id, q]));
  const summary: Array<Record<string, unknown>> = [];
  // BH family: the pure-rerank primary comparisons within one K (one nDCG@10 test per arm).
  const bhByK = new Map<number, Map<string, boolean>>();
  for (const k of ks) {
    const fam = rows.filter((r) => r.mode === "rerank" && r.k === k);
    const ps = fam.map(
      (r) =>
        summarizePaired(
          r.base_m.map((m) => m.ndcg_at_10),
          r.arm_m.map((m) => m.ndcg_at_10),
        ).p,
    );
    const dec = bhDecisions(ps);
    bhByK.set(k, new Map(fam.map((r, i) => [r.key, dec[i] ?? false])));
  }
  for (const r of rows) {
    const agg = aggregateMetrics(r.arm_m);
    const bagg = aggregateMetrics(r.base_m);
    const s = summarizePaired(
      r.base_m.map((m) => m.ndcg_at_10),
      r.arm_m.map((m) => m.ndcg_at_10),
    );
    const bh = bhByK.get(r.k)?.get(r.key) ?? false;
    const slice = (pick: (q: GoldenQuery, p: Pool) => string): Record<string, unknown> => {
      const groups = new Map<string, number[]>();
      r.ids.forEach((id, i) => {
        const q = byId.get(id) as GoldenQuery;
        const g = pick(q, poolById.get(id) as Pool);
        groups.set(g, [...(groups.get(g) ?? []), i]);
      });
      const out: Record<string, unknown> = {};
      for (const [g, idx] of [...groups.entries()].sort()) {
        const ps = summarizePaired(
          idx.map((i) => (r.base_m[i] as QueryMetrics).ndcg_at_10),
          idx.map((i) => (r.arm_m[i] as QueryMetrics).ndcg_at_10),
        );
        out[g] = {
          n: idx.length,
          dense: +ps.meanBase.toFixed(4),
          arm: +ps.meanArm.toFixed(4),
          delta: +ps.delta.toFixed(4),
          p: +ps.p.toFixed(4),
          wins: ps.wins,
          losses: ps.losses,
        };
      }
      return out;
    };
    summary.push({
      key: r.key,
      arm: r.arm,
      k: r.k,
      mode: r.mode,
      n: s.n,
      ndcg: { dense: +bagg.mean_ndcg_at_10.toFixed(4), arm: +agg.mean_ndcg_at_10.toFixed(4) },
      recall: { dense: +bagg.mean_recall_at_10.toFixed(4), arm: +agg.mean_recall_at_10.toFixed(4) },
      mrr: { dense: +bagg.mean_mrr_at_10.toFixed(4), arm: +agg.mean_mrr_at_10.toFixed(4) },
      bridge_ndcg: {
        dense: +bagg.mean_bridge_ndcg_at_10.toFixed(4),
        arm: +agg.mean_bridge_ndcg_at_10.toFixed(4),
        n: agg.bridge_query_count,
        ...bridgePaired(r.base_m, r.arm_m),
      },
      paired_ndcg: {
        delta: +s.delta.toFixed(4),
        p: +s.p.toFixed(4),
        lower95: +s.lower.toFixed(4),
        nonInferior: s.nonInferior,
        sigmaD: +s.sigmaD.toFixed(4),
        mde: +s.mde.toFixed(4),
        wins: s.wins,
        losses: s.losses,
      },
      verdict: r.mode === "rerank" && r.k > 0 ? corpusVerdict(s, bh) : null,
      by_hop: slice((q) => hopClass(q)),
      by_route: slice((_q, p) => p.route_class),
      by_category: slice((q) => q.categories?.[0] ?? "none"),
      latency_ms: r.latency.length
        ? { p50: percentile(r.latency, 0.5), p95: percentile(r.latency, 0.95) }
        : null,
      neurons_per_search: r.arm.startsWith("cf-bge-reranker-base")
        ? +mean(r.chars.map(estimateNeurons)).toFixed(2)
        : null,
    });
    // One history.ts artifact per row (graph = this arm, baseline = dense control).
    const slug = r.key.replace(/[^a-z0-9.+-]+/gi, "_");
    writeFileSync(
      join(outDir, `artifact-${slug}.json`),
      JSON.stringify({
        flags: [`rerank-arm:${r.arm}`, `k${r.k}`, r.mode],
        perQuery: r.ids.map((id, i) => ({
          id,
          baseline: r.base_m[i],
          graph: r.arm_m[i],
          hard: false,
          z1: 0,
        })),
      }),
    );
  }
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  const line = (s: Record<string, unknown>): string => {
    const nd = s.ndcg as { dense: number; arm: number };
    const pd = s.paired_ndcg as { delta: number; p: number; lower95: number; mde: number };
    return `${String(s.key).padEnd(52)} n=${String(s.n).padEnd(3)} nDCG ${nd.dense.toFixed(4)} -> ${nd.arm.toFixed(4)}  d ${pd.delta >= 0 ? "+" : ""}${pd.delta.toFixed(4)} p=${pd.p.toFixed(4)} lo95 ${pd.lower95.toFixed(3)} MDE ${pd.mde.toFixed(3)} ${s.verdict ?? ""}`;
  };
  process.stdout.write(`${summary.map(line).join("\n")}\n`);
}

if (cmd === "pools") await stagePools();
else if (cmd === "rerank") await stageRerank();
else if (cmd === "score") stageScore();
else die("usage: rerank-arms.ts pools|rerank|score ...");
