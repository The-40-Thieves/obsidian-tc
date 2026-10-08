// Embedder-arms eval: does another embedding model beat the shipped one (bge-m3, 1024d) for retrieval?
//
// Stages, each resumable and each writing plain JSON under one experiment directory:
//   index    copy a source index, re-embed every chunk with one arm (same chunking, same chunk text), and
//            record per-batch embed latency. The copy is the arm's own index; nothing else is touched.
//   queries  embed every golden query with the arm's query side, one call per query, recording latency.
//   score    metrics, paired statistics against the control, the pre-registered verdict and the cost table
//            over the per-arm pools that `rerank-arms.ts pools` wrote from each arm's index copy.
//
//   bun eval/embedder-arms.ts index   <source-config.json> --arm <name> --exp-dir D [--corpus public|private]
//   bun eval/embedder-arms.ts queries <golden> [<golden> ...] --arm <name> --exp-dir D [--corpus public|private]
//   bun eval/rerank-arms.ts   pools   D/arms/<arm>/config.json <golden> --out D/pools-<arm>.json \
//        --query-vecs D/qvecs-<arm>.json --kind public|private --k 50
//   bun eval/embedder-arms.ts score   --exp-dir D --golden strict=<path>,lenient=<path> --out-dir D/score
//
// Gemini arms read their key from the environment by NAME. The free-tier key (GEMINI_API_KEY) is refused
// for `--corpus private`, which needs a paid project's key under GEMINI_API_KEY_PAID. An empty variable of
// the same name in the shell shadows `--env-file`; start bun under `env -u GEMINI_API_KEY`.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config/load";
import { openConfiguredDatabase } from "../src/db/open";
import { compileEgressFilter, isExcludedPath } from "../src/plane/egress-filter";
import { loadVec } from "../src/search/vec";
import {
  armByName,
  BGE_M3_NEURONS_PER_M_TOKENS,
  backoffMs,
  CONTROL_ARM,
  type Corpus,
  cosine,
  documentText,
  EMBEDDER_ARMS,
  type EmbedderArm,
  type EmbedKind,
  embedCostUsd,
  geminiBatchBody,
  geminiRequest,
  isDailyQuota,
  neuronsToUsd,
  pairedAgainstControl,
  parseGeminiEmbeddings,
  privatePhaseDecision,
  queryText,
  type RetrievalRow,
  recallAtK,
  resolveGeminiKey,
} from "./embedder-arms-lib";
import {
  aggregateMetrics,
  computeQueryMetrics,
  GoldenSetSchema,
  type QueryMetrics,
} from "./metrics";
import { bhDecisions, corpusVerdict, percentile } from "./rerank-arms-lib";

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
const corpusFlag = (): Corpus => {
  const c = flag("--corpus") ?? "public";
  if (c !== "public" && c !== "private") die("--corpus must be public or private");
  return c;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const GATEWAY = process.env.EMBEDDER_ARMS_GATEWAY ?? "http://100.78.123.100:4001/v1";

interface CallStat {
  n: number;
  chars: number;
  ms: number;
  retries: number;
}

/** POST with the retry schedule. A per-day quota is not waited out: the run stops, resumable. */
async function postRetry(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ json: unknown; ms: number; retries: number }> {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    let res: Response | undefined;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      /* network error or timeout: retried below */
    }
    const ms = performance.now() - t0;
    if (res?.ok) return { json: await res.json(), ms, retries: attempt };
    const status = res?.status ?? 0;
    const text = res ? (await res.text()).slice(0, 300) : "network error";
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable || attempt >= 7) throw new Error(`HTTP ${status}: ${text}`);
    if (status === 429 && isDailyQuota(text))
      throw new Error(`daily quota exhausted (HTTP 429): ${text}`);
    const ra = Number(res?.headers.get("retry-after"));
    const wait = backoffMs(attempt, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    process.stderr.write(`  HTTP ${status}; retry ${attempt + 1} in ${Math.round(wait / 1000)}s\n`);
    await sleep(wait);
  }
}

type Embedder = (texts: string[], kind: EmbedKind) => Promise<{ vecs: number[][]; stat: CallStat }>;

function buildEmbedder(arm: EmbedderArm, corpus: Corpus): Embedder {
  if (arm.family === "gateway-bge") {
    const key = process.env.LITELLM_AGENT_KEY;
    if (!key) die("LITELLM_AGENT_KEY is not set");
    return async (texts) => {
      const r = await postRetry(
        `${GATEWAY}/embeddings`,
        { authorization: `Bearer ${key}` },
        { model: arm.model, input: texts },
      );
      const data = (r.json as { data?: Array<{ embedding: number[] }> }).data ?? [];
      if (data.length !== texts.length || data.some((d) => d.embedding.length !== arm.dims))
        throw new Error("gateway returned the wrong number or width of vectors");
      return {
        vecs: data.map((d) => d.embedding),
        stat: {
          n: texts.length,
          chars: texts.reduce((a, t) => a + t.length, 0),
          ms: r.ms,
          retries: r.retries,
        },
      };
    };
  }
  const key = resolveGeminiKey(corpus, process.env);
  const headers = { "x-goog-api-key": key };
  return async (texts, kind) => {
    const stat = (r: { ms: number; retries: number }): CallStat => ({
      n: texts.length,
      chars: texts.reduce((a, t) => a + t.length, 0),
      ms: r.ms,
      retries: r.retries,
    });
    if (texts.length === 1 && kind === "query") {
      const r = await postRetry(
        `${GEMINI}/models/${arm.model}:embedContent`,
        headers,
        geminiRequest(arm, texts[0] as string, kind),
      );
      const e = (r.json as { embedding?: { values: number[] } }).embedding;
      return {
        vecs: parseGeminiEmbeddings({ embeddings: e ? [e] : [] }, 1, arm.dims),
        stat: stat(r),
      };
    }
    const r = await postRetry(
      `${GEMINI}/models/${arm.model}:batchEmbedContents`,
      headers,
      geminiBatchBody(arm, texts, kind),
    );
    return { vecs: parseGeminiEmbeddings(r.json, texts.length, arm.dims), stat: stat(r) };
  };
}

const armDir = (exp: string, arm: EmbedderArm): string => join(exp, "arms", arm.name);
const f32 = (v: number[]): Buffer => Buffer.from(new Float32Array(v).buffer);

async function stageIndex(): Promise<void> {
  const [srcConfig] = pos;
  const exp = flag("--exp-dir");
  const armName = flag("--arm");
  if (!srcConfig || !exp || !armName)
    die(
      "usage: index <source-config.json> --arm <name> --exp-dir D [--corpus public|private] [--batch 100] [--interval-ms 1500] [--limit N]",
    );
  const arm = armByName(armName);
  const corpus = corpusFlag();
  const batch = Number(flag("--batch") ?? (arm.family === "gateway-bge" ? 16 : 100));
  const intervalMs = Number(flag("--interval-ms") ?? 1500);
  const limit = flag("--limit") ? Number(flag("--limit")) : undefined;
  const src = loadConfig(srcConfig);
  const dir = armDir(exp, arm);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "cache.db");
  const fresh = !existsSync(dbPath);
  if (fresh) copyFileSync(join(src.cacheDir, "cache.db"), dbPath);
  const raw = JSON.parse(readFileSync(srcConfig, "utf8")) as Record<string, unknown>;
  const model = `openai:${arm.model}`;
  const config = {
    ...raw,
    cacheDir: dir,
    embeddings: {
      provider: "openai",
      apiKeyEnv: "LITELLM_AGENT_KEY",
      model: arm.model,
      dimensions: arm.dims,
      baseUrl: GATEWAY,
      timeoutMs: 600000,
      batchSize: 16,
      concurrency: 1,
    },
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  const cfg = loadConfig(join(dir, "config.json"));
  const vault = cfg.vaults[0];
  if (!vault) throw new Error("config.vaults is empty");
  const db = await openConfiguredDatabase(cfg, "cache.db");
  if (fresh && arm.family !== "gateway-bge") db.exec("DELETE FROM chunk_embeddings");
  const filter = compileEgressFilter(cfg.egress.excludePaths);
  const all = (
    db
      .prepare(
        "SELECT id, path, headings, content FROM chunks WHERE vault_id = ? ORDER BY path, chunk_index",
      )
      .all(vault.id) as Array<{ id: string; path: string; headings: string; content: string }>
  ).filter((c) => !isExcludedPath(filter, c.path));
  const logPath = join(exp, `embed-log-${arm.name}.json`);
  const log: {
    arm: string;
    corpus: Corpus;
    model: string;
    dims: number;
    chunks: number;
    batches: CallStat[];
    verify?: { n: number; min_cosine: number; mean_cosine: number };
  } = existsSync(logPath)
    ? JSON.parse(readFileSync(logPath, "utf8"))
    : { arm: arm.name, corpus, model: arm.model, dims: arm.dims, chunks: all.length, batches: [] };
  const embed = buildEmbedder(arm, corpus);
  const textOf = (c: (typeof all)[number]): string =>
    documentText(arm, {
      path: c.path,
      headings: JSON.parse(c.headings) as string[],
      content: c.content,
    });

  if (arm.family === "gateway-bge") {
    // The control keeps its production vectors. A sample is re-embedded through this harness's own path
    // and compared with what the index stores, which proves the chunk text and the transport match.
    const n = Number(flag("--verify-sample") ?? 24);
    if (!log.verify && n > 0) {
      const step = Math.max(1, Math.floor(all.length / n));
      const sample = all.filter((_, i) => i % step === 0).slice(0, n);
      const stored = db.prepare(
        "SELECT embedding FROM chunk_embeddings WHERE chunk_id = ? AND model = ?",
      );
      const cos: number[] = [];
      for (let i = 0; i < sample.length; i += batch) {
        const part = sample.slice(i, i + batch);
        const r = await embed(part.map(textOf), "document");
        log.batches.push(r.stat);
        part.forEach((c, j) => {
          const row = stored.get(c.id, model) as { embedding?: Buffer } | undefined;
          if (row?.embedding)
            cos.push(
              cosine(
                Array.from(
                  new Float32Array(row.embedding.buffer, row.embedding.byteOffset, arm.dims),
                ),
                r.vecs[j] as number[],
              ),
            );
        });
      }
      log.verify = {
        n: cos.length,
        min_cosine: Math.min(...cos),
        mean_cosine: cos.reduce((a, b) => a + b, 0) / cos.length,
      };
    }
  } else {
    const have = new Set(
      (
        db.prepare("SELECT chunk_id FROM chunk_embeddings WHERE model = ?").all(model) as Array<{
          chunk_id: string;
        }>
      ).map((r) => r.chunk_id),
    );
    const todo = all.filter((c) => !have.has(c.id)).slice(0, limit);
    // GH #1160: idx_chunk_embeddings_active is UNIQUE per chunk. This arm's DB was copied from the
    // source cache (gateway-bge keeps its rows), so retire the other models' active rows BEFORE the
    // insert — INSERT OR REPLACE alone would DELETE the conflicting active row instead of refusing.
    const retire = db.prepare(
      "UPDATE chunk_embeddings SET is_active = 0 WHERE chunk_id = ? AND model != ? AND is_active = 1",
    );
    const ins = db.prepare(
      "INSERT OR REPLACE INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, ?)",
    );
    for (let i = 0; i < todo.length; i += batch) {
      const part = todo.slice(i, i + batch);
      const r = await embed(part.map(textOf), "document");
      log.batches.push(r.stat);
      db.exec("BEGIN");
      for (const [j, c] of part.entries()) {
        retire.run(c.id, model);
        ins.run(c.id, model, arm.dims, f32(r.vecs[j] as number[]), Date.now());
      }
      db.exec("COMMIT");
      writeFileSync(logPath, JSON.stringify(log));
      process.stderr.write(
        `  ${arm.name}: ${Math.min(i + batch, todo.length)}/${todo.length} (${Math.round(r.stat.ms)} ms, ${r.stat.retries} retries)\n`,
      );
      await sleep(intervalMs);
    }
  }
  // Brute-force cosine over chunk_embeddings for EVERY arm, so an arm differs only in its vectors.
  loadVec(db);
  db.exec("DROP TABLE IF EXISTS vec_chunks");
  const done = (
    db.prepare("SELECT count(*) AS c FROM chunk_embeddings WHERE model = ?").get(model) as {
      c: number;
    }
  ).c;
  writeFileSync(logPath, JSON.stringify(log));
  db.close?.();
  process.stdout.write(`index ${arm.name}: ${done}/${all.length} chunks embedded under ${model}\n`);
  if (done < all.length) process.exit(3);
}

async function stageQueries(): Promise<void> {
  const exp = flag("--exp-dir");
  const armName = flag("--arm");
  if (pos.length === 0 || !exp || !armName)
    die(
      "usage: queries <golden> [<golden> ...] --arm <name> --exp-dir D [--corpus public|private] [--interval-ms 800]",
    );
  const arm = armByName(armName);
  const corpus = corpusFlag();
  const intervalMs = Number(flag("--interval-ms") ?? 800);
  const texts = [
    ...new Set(
      pos.flatMap((p) =>
        GoldenSetSchema.parse(parseYaml(readFileSync(p, "utf8"))).queries.map((q) => q.query_text),
      ),
    ),
  ];
  const embed = buildEmbedder(arm, corpus);
  await embed([queryText(arm, "warm up")], "query"); // connection and TLS setup stay out of the latency figures
  const vecs: Record<string, number[]> = {};
  const lat: number[] = [];
  for (const t of texts) {
    const r = await embed([queryText(arm, t)], "query");
    vecs[t] = r.vecs[0] as number[];
    lat.push(r.stat.ms);
    await sleep(intervalMs);
  }
  writeFileSync(join(exp, `qvecs-${arm.name}.json`), JSON.stringify(vecs));
  writeFileSync(
    join(exp, `query-latency-${arm.name}.json`),
    JSON.stringify({
      arm: arm.name,
      corpus,
      n: lat.length,
      p50_ms: percentile(lat, 0.5),
      p95_ms: percentile(lat, 0.95),
      mean_ms: lat.reduce((a, b) => a + b, 0) / lat.length,
      ms: lat,
    }),
  );
  process.stdout.write(
    `queries ${arm.name}: ${lat.length} embedded, p50 ${Math.round(percentile(lat, 0.5))} ms, p95 ${Math.round(percentile(lat, 0.95))} ms\n`,
  );
}

interface PoolFile {
  pools: Array<{ id: string; candidates: Array<{ chunk_id: string; path: string }> }>;
  graph: Record<string, Array<{ chunk_id: string; path: string }>>;
}

const r4 = (x: number): number => +x.toFixed(4);

function stageScore(): void {
  const exp = flag("--exp-dir");
  const outDir = flag("--out-dir");
  const goldens = (flag("--golden") ?? "")
    .split(",")
    .filter(Boolean)
    .map((s) => s.split("=") as [string, string]);
  const armNames = (flag("--arms") ?? EMBEDDER_ARMS.map((a) => a.name).join(",")).split(",");
  if (!exp || !outDir || goldens.length === 0)
    die(
      "usage: score --exp-dir D --golden strict=<path>,lenient=<path> --out-dir D/score [--arms a,b,c]",
    );
  mkdirSync(outDir, { recursive: true });
  const pools = new Map<string, PoolFile>();
  for (const n of armNames)
    pools.set(n, JSON.parse(readFileSync(join(exp, `pools-${n}.json`), "utf8")) as PoolFile);
  const readJson = <T>(p: string): T | undefined =>
    existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : undefined;

  const rows: Array<Record<string, unknown>> = [];
  const decisionRows: Record<string, RetrievalRow[]> = {};
  for (const [labels, path] of goldens) {
    const queries = GoldenSetSchema.parse(parseYaml(readFileSync(path, "utf8"))).queries;
    const score = (
      name: string,
      order: "dense" | "graph",
    ): { m: QueryMetrics[]; r50: number[] } => {
      const pf = pools.get(name) as PoolFile;
      const byId = new Map(pf.pools.map((p) => [p.id, p]));
      const ms: QueryMetrics[] = [];
      const r50: number[] = [];
      for (const q of queries) {
        const ranked =
          order === "dense" ? (byId.get(q.id)?.candidates ?? []) : (pf.graph[q.id] ?? []);
        ms.push(computeQueryMetrics(q, ranked));
        r50.push(
          recallAtK(
            q,
            ranked.map((c) => c.path),
            50,
          ),
        );
      }
      return { m: ms, r50 };
    };
    const control = score(CONTROL_ARM, "dense");
    const controlGraph = score(CONTROL_ARM, "graph");
    const fam = armNames.map(armByName).filter((a) => a.decisionBearing);
    const famP = fam.map(
      (a) =>
        pairedAgainstControl(
          control.m.map((m) => m.ndcg_at_10),
          score(a.name, "dense").m.map((m) => m.ndcg_at_10),
        ).p,
    );
    const bh = new Map(fam.map((a, i) => [a.name, bhDecisions(famP)[i] ?? false]));
    for (const name of armNames) {
      const arm = armByName(name);
      const dense = score(name, "dense");
      const graph = score(name, "graph");
      const agg = aggregateMetrics(dense.m);
      const pair = (b: number[], a: number[]) => {
        const s = pairedAgainstControl(b, a);
        return {
          delta: r4(s.delta),
          p: r4(s.p),
          lower95: r4(s.lower),
          mde: r4(s.mde),
          sigmaD: r4(s.sigmaD),
          wins: s.wins,
          losses: s.losses,
        };
      };
      const sN = pairedAgainstControl(
        control.m.map((m) => m.ndcg_at_10),
        dense.m.map((m) => m.ndcg_at_10),
      );
      const verdict = name === CONTROL_ARM ? null : corpusVerdict(sN, bh.get(name) ?? sN.p < 0.05);
      if (arm.decisionBearing && verdict) {
        const mine = decisionRows[name] ?? [];
        mine.push({ labels, verdict, delta: sN.delta, lower95: sN.lower });
        decisionRows[name] = mine;
      }
      const lat = readJson<{ p50_ms: number; p95_ms: number }>(
        join(exp, `query-latency-${name}.json`),
      );
      rows.push({
        labels,
        arm: name,
        n: queries.length,
        decision_bearing: arm.decisionBearing,
        ndcg10: r4(agg.mean_ndcg_at_10),
        mrr10: r4(agg.mean_mrr_at_10),
        recall10: r4(agg.mean_recall_at_10),
        recall50: r4(dense.r50.reduce((a, b) => a + b, 0) / dense.r50.length),
        vs_control:
          name === CONTROL_ARM
            ? null
            : {
                ndcg10: pair(
                  control.m.map((m) => m.ndcg_at_10),
                  dense.m.map((m) => m.ndcg_at_10),
                ),
                mrr10: pair(
                  control.m.map((m) => m.mrr_at_10),
                  dense.m.map((m) => m.mrr_at_10),
                ),
                recall10: pair(
                  control.m.map((m) => m.recall_at_10),
                  dense.m.map((m) => m.recall_at_10),
                ),
                recall50: pair(control.r50, dense.r50),
              },
        bh_rejected: bh.get(name) ?? null,
        verdict,
        graph_rrf_ndcg10: r4(aggregateMetrics(graph.m).mean_ndcg_at_10),
        graph_rrf_vs_control_graph:
          name === CONTROL_ARM
            ? null
            : pair(
                controlGraph.m.map((m) => m.ndcg_at_10),
                graph.m.map((m) => m.ndcg_at_10),
              ),
        query_embed_ms: lat ? { p50: Math.round(lat.p50_ms), p95: Math.round(lat.p95_ms) } : null,
      });
      writeFileSync(
        join(outDir, `artifact-${name}-${labels}.json`),
        JSON.stringify({
          flags: [`embedder-arm:${name}`, `labels:${labels}`],
          perQuery: queries.map((q, i) => ({
            id: q.id,
            baseline: control.m[i],
            graph: dense.m[i],
            hard: false,
            z1: 0,
          })),
        }),
      );
    }
  }
  const decision = privatePhaseDecision(decisionRows);
  const docLat = Object.fromEntries(
    EMBEDDER_ARMS.flatMap((a) => {
      const l = readJson<{ batches: CallStat[] }>(join(exp, `embed-log-${a.name}.json`));
      if (!l || l.batches.length === 0) return [];
      const chars = l.batches.reduce((s, b) => s + b.chars, 0);
      const n = l.batches.reduce((s, b) => s + b.n, 0);
      const ms = l.batches.reduce((s, b) => s + b.ms, 0);
      return [
        [
          a.name,
          {
            texts: n,
            est_tokens: Math.round(chars / 4),
            wall_s: r4(ms / 1000),
            ms_per_text: r4(ms / n),
            batch_p50_ms: Math.round(
              percentile(
                l.batches.map((b) => b.ms),
                0.5,
              ),
            ),
            batch_p95_ms: Math.round(
              percentile(
                l.batches.map((b) => b.ms),
                0.95,
              ),
            ),
            retries: l.batches.reduce((s, b) => s + b.retries, 0),
          },
        ],
      ];
    }),
  );
  const bgeUsdPerM = neuronsToUsd(BGE_M3_NEURONS_PER_M_TOKENS);
  const cost = {
    note: "USD, input tokens only. Vault = 2.9M tokens; daily volume 10k to 250k tokens. Gemini free tier is $0 but Google may use the content, so it is public-corpus only.",
    per_million_tokens: {
      "bge-m3": r4(bgeUsdPerM),
      "gemini-embedding-2 standard": 0.2,
      "gemini-embedding-2 batch": 0.1,
      "gemini-embedding-001": null,
    },
    full_reembed_2_9M_tokens: {
      "bge-m3": r4(embedCostUsd(2.9e6, { perMTokens: bgeUsdPerM, source: "" })),
      "gemini-embedding-2 standard": r4(embedCostUsd(2.9e6, { perMTokens: 0.2, source: "" })),
      "gemini-embedding-2 batch": r4(embedCostUsd(2.9e6, { perMTokens: 0.1, source: "" })),
    },
    per_day: Object.fromEntries(
      [1e4, 2.5e5].map((t) => [
        `${t / 1000}k tokens`,
        {
          "bge-m3": r4(embedCostUsd(t, { perMTokens: bgeUsdPerM, source: "" })),
          "gemini-embedding-2 standard": r4(embedCostUsd(t, { perMTokens: 0.2, source: "" })),
          "gemini-embedding-2 batch": r4(embedCostUsd(t, { perMTokens: 0.1, source: "" })),
        },
      ]),
    ),
  };
  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify({ private_phase: decision, rows, doc_embed: docLat, cost }, null, 2),
  );
  for (const r of rows) {
    const v = (r.vs_control as { ndcg10: { delta: number; p: number; lower95: number } } | null)
      ?.ndcg10;
    process.stdout.write(
      `${String(r.labels).padEnd(8)} ${String(r.arm).padEnd(27)} nDCG@10 ${r.ndcg10} MRR ${r.mrr10} R@10 ${r.recall10} R@50 ${r.recall50}${v ? `  d ${v.delta >= 0 ? "+" : ""}${v.delta} p=${v.p} lo95 ${v.lower95} ${r.verdict}` : ""}\n`,
    );
  }
  process.stdout.write(`private phase: ${decision.run ? "YES" : "NO"} (${decision.reason})\n`);
}

if (cmd === "index") await stageIndex();
else if (cmd === "queries") await stageQueries();
else if (cmd === "score") stageScore();
else die("usage: embedder-arms.ts index|queries|score ...");
