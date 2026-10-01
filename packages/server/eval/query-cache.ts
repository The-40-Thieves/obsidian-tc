// Eval for retrieval.cache: the in-process query-product cache, ON versus OFF, through the real tool
// dispatch path (registry.dispatch -> handler -> cacheContextFor -> cachedGraphSearch), against a COPY
// of a real index. It measures three things the cache's own unit tests cannot: latency on repeated
// queries, byte-identity of every response against the cache-off response, and bytes held.
//
//   bun eval/query-cache.ts <config.json> <golden-set> --query-vecs <vecs.json> --mode <mode>
//        --json <out.json> [--tool vault_graph_search] [--distinct 250] [--repeat-rate 0.3]
//        [--reps 5] [--embed stub|live] [--seed 20260930]
//
//   latency    a seeded stream (eval/query-cache-lib.ts buildStream) replayed REPS times per arm, arms
//              alternating order; per-call dispatch wall time, whole-response identity vs OFF
//   isolation  callers A (unrestricted) and B (folder-restricted) interleaved on ONE shared ON cache
//   bump       replay, bump the vault generation, replay: the bump must turn every entry into a miss
//   memory     bytes per cached entry at final_top_k 10/30/100, and the heap held at maxEntries
//   embed      single real embeddings through the provider (the round trip a hit skips)
//
// `--embed stub` answers the query embedding from precomputed vectors (cost ~0 in BOTH arms, so the
// win it shows is the DB + fusion work alone); `live` calls the configured provider. The artifact is
// shaped like `eval/run.ts --json` so `eval/history.ts record` accepts it: `baseline` is OFF, `graph`
// is ON, scored on the golden labels. No query text or note path is written to the artifact.
import { readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { serialize } from "node:v8";
import { parse as parseYaml } from "yaml";
import { FolderAcl } from "../src/acl";
import { loadConfig } from "../src/config/load";
import { openConfiguredDatabase } from "../src/db/open";
import type { Database } from "../src/db/types";
import { createEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { compileEgressFilter } from "../src/plane/egress-filter";
import { bumpGeneration } from "../src/search/generation";
import { createRetrievalCaches, type RetrievalCaches } from "../src/search/query_cache";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { computeQueryMetrics, GoldenSetSchema, type RankedChunk } from "./metrics";
import {
  buildStream,
  differingKeys,
  foldersCovering,
  median,
  summarize,
  underFolders,
} from "./query-cache-lib";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [configPath, goldenPath] = argv;
const vecsPath = flag("--query-vecs");
const mode = flag("--mode");
const out = flag("--json");
const tool = flag("--tool") ?? "vault_graph_search";
const embedMode = flag("--embed") ?? "stub";
const distinct = Number(flag("--distinct") ?? 250);
const repeatRate = Number(flag("--repeat-rate") ?? 0.3);
const reps = Number(flag("--reps") ?? 5);
const seed = Number(flag("--seed") ?? 20260930);
if (!configPath || !goldenPath || !vecsPath || !mode || !out) {
  process.stderr.write(
    "usage: bun eval/query-cache.ts <config.json> <golden-set> --query-vecs <vecs.json> --mode latency|isolation|bump|memory|embed --json <out.json> [--tool T] [--distinct N] [--repeat-rate R] [--reps N] [--embed stub|live] [--seed S] [--cache-entries N]\n",
  );
  process.exit(2);
}

const MAX_ENTRIES = 64; // the shipped retrieval.cache.maxEntries
const TTL_MS = 3_600_000; // never binds: repeats are placed by call gap, not by clock (see prereg)

const config = loadConfig(configPath);
const vault = config.vaults[0];
if (!vault) throw new Error("config.vaults is empty");
const { id: VAULT_ID, path: VAULT_PATH } = vault;
const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath, "utf8")));
const queries = golden.queries.slice(0, distinct);
const vecs = new Map<string, number[]>(
  Object.entries(JSON.parse(readFileSync(vecsPath, "utf8")) as Record<string, number[]>),
);
const baseProvider = createEmbeddingProvider(config.embeddings, {
  excludeFilter: compileEgressFilter(config.egress.excludePaths),
  cacheDir: config.cacheDir,
});
// `id`, model and dimensions still come from the real provider so the stored-model filter matches.
const stubProvider = Object.assign(Object.create(baseProvider), {
  embed: async (texts: string[], o?: { input?: "query" | "document" }): Promise<number[][]> =>
    o?.input === "query"
      ? texts.map((t) => {
          const v = vecs.get(t);
          if (!v) throw new Error("no precomputed vector for a query");
          return v;
        })
      : baseProvider.embed(texts, o),
});
let embedCalls = 0;
const provider = embedMode === "live" ? baseProvider : stubProvider;
const countingProvider = Object.assign(Object.create(provider), {
  embed: (texts: string[], o?: { input?: "query" | "document" }) => {
    if (o?.input === "query") embedCalls++;
    return provider.embed(texts, o);
  },
});

const db: Database = await openConfiguredDatabase(config, "cache.db");
const OPEN_ACL = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
const callerA: CallerContext = {
  caller: "eval-a",
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: VAULT_ID,
  db,
  acl: OPEN_ACL,
};

function makeRegistry(caches?: RetrievalCaches): ToolRegistry {
  const registry = new ToolRegistry({});
  registerM7Tools(registry, {
    vaultRegistry: new VaultRegistry([{ id: VAULT_ID, path: VAULT_PATH }]),
    embeddingProvider: countingProvider,
    reranker: null,
    roles: null,
    retrieval: config.retrieval,
    ranking: config.ranking,
    ...(caches ? { retrievalCaches: caches } : {}),
  });
  return registry;
}
const newCaches = (entries = MAX_ENTRIES) =>
  createRetrievalCaches({ maxEntries: entries, ttlMs: TTL_MS });
// isolation and bump replay a working set larger than 64 entries; a cache that evicts it before the
// replay would make both arms vacuous (no hit to isolate or invalidate), so they size it explicitly.
const workingSetEntries = Number(flag("--cache-entries") ?? MAX_ENTRIES);

function inputFor(q: string, topK?: number): Record<string, unknown> {
  switch (tool) {
    case "search_and_read":
      return { vault: VAULT_ID, query: q, k: 10 };
    case "vault_context":
      return { vault: VAULT_ID, query: q };
    default:
      return { vault: VAULT_ID, query: q, ...(topK ? { final_top_k: topK } : {}) };
  }
}

interface Timed {
  ms: number;
  json: string;
  data: Record<string, unknown>;
}
async function call(
  registry: ToolRegistry,
  ctx: CallerContext,
  q: string,
  topK?: number,
  toolName = tool,
): Promise<Timed> {
  const input = toolName === tool ? inputFor(q, topK) : { vault: VAULT_ID, query: q };
  const t0 = performance.now();
  const r = await registry.dispatch(toolName, input, ctx);
  const ms = performance.now() - t0;
  if (!r.ok) throw new Error(`${toolName}: ${r.error.code}: ${r.error.message}`);
  return { ms, json: JSON.stringify(r.data), data: r.data as Record<string, unknown> };
}

/** The retrieved list of one response, for golden scoring. Tool-specific; empty when absent. */
function ranked(data: Record<string, unknown>): RankedChunk[] {
  const list = (data.results ?? data.notes ?? data.items ?? []) as Array<{
    chunk_id?: string;
    path?: string;
  }>;
  return list.map((r, i) => ({ chunk_id: r.chunk_id ?? `${i}`, path: r.path ?? "" }));
}
const hasQuery = (qi: number) => queries[qi] as (typeof queries)[number];

function perQueryFor(off: Array<Record<string, unknown>>, on: Array<Record<string, unknown>>) {
  // Scored over the first off.length queries: the isolation and bump modes replay a prefix only.
  return queries.slice(0, off.length).map((q, i) => ({
    id: q.id,
    baseline: computeQueryMetrics(q, ranked(off[i] as Record<string, unknown>)),
    graph: computeQueryMetrics(q, ranked(on[i] as Record<string, unknown>)),
    hard: false,
    z1: 0,
  }));
}

function heapUsed(): number {
  const g = globalThis as { Bun?: { gc: (sync: boolean) => void }; gc?: () => void };
  for (let i = 0; i < 2; i++) g.Bun ? g.Bun.gc(true) : g.gc?.();
  return process.memoryUsage().heapUsed;
}

const result: Record<string, unknown> = {
  mode,
  tool,
  embed: embedMode,
  seed,
  loadavgStart: loadavg(),
  chunks: (
    db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?").get(VAULT_ID) as { n: number }
  ).n,
};
let perQuery: ReturnType<typeof perQueryFor> = [];

// Untimed warm pass over every distinct query on the OFF path: page cache, prepared statements and
// the per-caller ACL path-set build are not charged to an arm.
const offRegistry = makeRegistry();
async function warm(): Promise<void> {
  for (const q of queries) await call(offRegistry, callerA, q.query_text);
}

if (mode === "latency") {
  await warm();
  const stream = buildStream(queries.length, repeatRate, seed);
  const subsets = {
    all: () => true,
    repeat: (c: { repeat: boolean }) => c.repeat,
    first: (c: { repeat: boolean }) => !c.repeat,
  };
  type Rep = {
    ms: number[];
    json: string[];
    data: Array<Record<string, unknown>>;
    stats?: unknown;
    embeds: number;
  };
  const run = async (registry: ToolRegistry, caches?: RetrievalCaches): Promise<Rep> => {
    const rep: Rep = { ms: [], json: [], data: [], embeds: 0 };
    const e0 = embedCalls;
    for (const c of stream) {
      const t = await call(registry, callerA, hasQuery(c.query).query_text);
      rep.ms.push(t.ms);
      rep.json.push(t.json);
      rep.data.push(t.data);
    }
    rep.embeds = embedCalls - e0;
    if (caches) rep.stats = { results: caches.results.stats(), vectors: caches.vectors.stats() };
    return rep;
  };
  const offReps: Rep[] = [];
  const onReps: Rep[] = [];
  for (let k = 0; k < reps; k++) {
    const order = k % 2 === 0 ? ["off", "on"] : ["on", "off"];
    for (const arm of order) {
      if (arm === "off") offReps.push(await run(offRegistry));
      else {
        const caches = newCaches();
        onReps.push(await run(makeRegistry(caches), caches));
      }
    }
  }
  const pick = (r: Rep, f: (c: { repeat: boolean }) => boolean) =>
    r.ms.filter((_, i) => f(stream[i] as { repeat: boolean }));
  const latency: Record<string, Record<string, unknown>> = {};
  for (const [name, f] of Object.entries(subsets)) {
    const per = (reps_: Rep[]) => reps_.map((r) => summarize(pick(r, f)));
    const off = per(offReps);
    const on = per(onReps);
    const agg = (xs: ReturnType<typeof summarize>[], key: "p50" | "p95" | "mean") => ({
      median: median(xs.map((x) => x[key])),
      min: Math.min(...xs.map((x) => x[key])),
      max: Math.max(...xs.map((x) => x[key])),
    });
    const paired = onReps.map((r, k) => {
      const o = offReps[k] as Rep;
      return median(
        r.ms
          .map((v, i) => v - (o.ms[i] as number))
          .filter((_, i) => f(stream[i] as { repeat: boolean })),
      );
    });
    latency[name] = {
      n: off[0]?.n,
      off: { p50: agg(off, "p50"), p95: agg(off, "p95"), mean: agg(off, "mean") },
      on: { p50: agg(on, "p50"), p95: agg(on, "p95"), mean: agg(on, "mean") },
      pairedMedianDeltaMs: { median: median(paired), perRep: paired },
    };
  }
  // Identity: every ON rep against the FIRST OFF rep, and OFF reps against each other (the control: if
  // the OFF path is not byte-stable the ON comparison means nothing).
  const base = offReps[0] as Rep;
  const tally = (reps_: Rep[], skipFirst: boolean) => {
    let whole = 0;
    const keys: Record<string, number> = {};
    let repeatDiffs = 0;
    let total = 0;
    reps_.forEach((r, k) => {
      if (skipFirst && k === 0) return;
      r.json.forEach((j, i) => {
        total++;
        if (j !== base.json[i]) {
          whole++;
          if ((stream[i] as { repeat: boolean }).repeat) repeatDiffs++;
          for (const key of differingKeys(r.data[i], base.data[i]))
            keys[key] = (keys[key] ?? 0) + 1;
        }
      });
    });
    return {
      calls: total,
      wholeDiffs: whole,
      onRepeatCallDiffs: repeatDiffs,
      differingKeyCounts: keys,
    };
  };
  result.stream = {
    length: stream.length,
    repeats: stream.filter((c) => c.repeat).length,
    repeatRate,
    distinct: queries.length,
  };
  result.latency = latency;
  result.identity = { onVsOff: tally(onReps, false), offVsOff: tally(offReps, true) };
  result.cacheStats = onReps.map((r) => r.stats);
  result.embedCallsPerRep = { off: offReps.map((r) => r.embeds), on: onReps.map((r) => r.embeds) };
  // Hit rate from rep 0's own counters.
  const rs = ((onReps[0] as Rep).stats as { results: { hits: number; misses: number } }).results;
  result.hitRate = rs.hits / (rs.hits + rs.misses);
  // First sightings, rep 0, for golden scoring.
  const firstIdx = new Map<number, number>();
  stream.forEach((c, i) => {
    if (!c.repeat) firstIdx.set(c.query, i);
  });
  perQuery = perQueryFor(
    queries.map((_, qi) => base.data[firstIdx.get(qi) as number] as Record<string, unknown>),
    queries.map(
      (_, qi) => (onReps[0] as Rep).data[firstIdx.get(qi) as number] as Record<string, unknown>,
    ),
  );
} else if (mode === "isolation") {
  // Callers A and B differ in exactly one thing: B holds a folder whitelist. One shared ON cache.
  const counts = new Map(
    (
      db
        .prepare("SELECT path, COUNT(*) AS n FROM chunks WHERE vault_id = ? GROUP BY path")
        .all(VAULT_ID) as Array<{ path: string; n: number }>
    ).map((r) => [r.path, r.n]),
  );
  const folders = foldersCovering(counts, 0.5);
  const callerB: CallerContext = {
    ...callerA,
    caller: "eval-b",
    acl: new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: folders.map((f) => `${f}/**`),
    }),
  };
  const n = Math.min(120, queries.length);
  const seq: Array<{ qi: number; who: "A" | "B" }> = [];
  for (let pass = 0; pass < 2; pass++)
    for (let qi = 0; qi < n; qi++) {
      seq.push({ qi, who: "A" });
      seq.push({ qi, who: "B" });
    }
  const ctxOf = (w: "A" | "B") => (w === "A" ? callerA : callerB);
  // Warm both callers on the OFF path (B builds its ACL path set once).
  for (let qi = 0; qi < n; qi++) {
    await call(offRegistry, callerA, hasQuery(qi).query_text);
    await call(offRegistry, callerB, hasQuery(qi).query_text);
  }
  const off: Timed[] = [];
  for (const s of seq) off.push(await call(offRegistry, ctxOf(s.who), hasQuery(s.qi).query_text));
  const caches = newCaches(workingSetEntries);
  const onRegistry = makeRegistry(caches);
  const on: Timed[] = [];
  for (const s of seq) on.push(await call(onRegistry, ctxOf(s.who), hasQuery(s.qi).query_text));
  let diffs = 0;
  const keys: Record<string, number> = {};
  let bOutside = 0;
  let abDiffer = 0;
  let bEqualsAWhereTheyDiffer = 0;
  seq.forEach((s, i) => {
    const a = on[i] as Timed;
    const b = off[i] as Timed;
    if (a.json !== b.json) {
      diffs++;
      for (const key of differingKeys(a.data, b.data)) keys[key] = (keys[key] ?? 0) + 1;
    }
    if (s.who === "B") {
      for (const r of [...ranked(a.data), ...ranked(b.data)])
        if (!underFolders(r.path, folders)) bOutside++;
      const aSame = on[i - 1] as Timed;
      if (aSame.json !== a.json) abDiffer++;
      // A cross-caller hit would hand B an A response where the two truly differ in OFF.
      if ((off[i - 1] as Timed).json !== b.json && a.json === aSame.json) bEqualsAWhereTheyDiffer++;
    }
  });
  result.isolation = {
    restrictedFolders: folders.length,
    calls: seq.length,
    wholeDiffsOnVsOff: diffs,
    differingKeyCounts: keys,
    restrictedResultsOutsideReadableSet: bOutside,
    queriesWhereAandBDiffer: abDiffer,
    crossCallerHits: bEqualsAWhereTheyDiffer,
    cacheStats: { results: caches.results.stats(), vectors: caches.vectors.stats() },
  };
  const callerAIdx = Array.from({ length: n }, (_, qi) => 2 * qi);
  perQuery = perQueryFor(
    callerAIdx.map((i) => (off[i] as Timed).data),
    callerAIdx.map((i) => (on[i] as Timed).data),
  );
  result.perQueryLimitedTo = n;
} else if (mode === "bump") {
  const n = Math.min(100, queries.length);
  const caches = newCaches(workingSetEntries);
  const onRegistry = makeRegistry(caches);
  const pass = async (registry: ToolRegistry) => {
    const t: Timed[] = [];
    for (let qi = 0; qi < n; qi++) t.push(await call(registry, callerA, hasQuery(qi).query_text));
    return t;
  };
  await warm();
  const offBefore = await pass(offRegistry);
  const on1 = await pass(onRegistry);
  const s1 = caches.results.stats();
  const on2 = await pass(onRegistry);
  const s2 = caches.results.stats();
  const generationAfterBump = bumpGeneration(db, VAULT_ID);
  const on3 = await pass(onRegistry);
  const s3 = caches.results.stats();
  const offAfter = await pass(offRegistry);
  const cmp = (a: Timed[], b: Timed[]) => {
    let whole = 0;
    const keys: Record<string, number> = {};
    a.forEach((t, i) => {
      if (t.json !== (b[i] as Timed).json) {
        whole++;
        for (const key of differingKeys(t.data, (b[i] as Timed).data))
          keys[key] = (keys[key] ?? 0) + 1;
      }
    });
    return { wholeDiffs: whole, differingKeyCounts: keys };
  };
  result.bump = {
    calls: n,
    generationAfterBump,
    pass1: { hits: s1.hits, misses: s1.misses },
    pass2HitsDelta: s2.hits - s1.hits,
    pass2MissesDelta: s2.misses - s1.misses,
    pass3HitsDelta: s3.hits - s2.hits,
    pass3MissesDelta: s3.misses - s2.misses,
    pass1VsOffBefore: cmp(on1, offBefore),
    pass2VsOffBefore: cmp(on2, offBefore),
    pass3VsOffAfter: cmp(on3, offAfter),
    // Content did not change, so a correct post-bump answer equals the pre-bump one too.
    pass3VsPass1: cmp(on3, on1),
  };
  perQuery = perQueryFor(
    offAfter.map((t) => t.data),
    on3.map((t) => t.data),
  );
  result.perQueryLimitedTo = n;
} else if (mode === "memory") {
  await warm();
  const sizes: Record<string, unknown> = {};
  for (const topK of [10, 30, 100]) {
    const caches = newCaches();
    const results: number[] = [];
    const vectors: number[] = [];
    // Capture what the cache stores, without changing src: wrap the instances' set().
    for (const [store, bucket] of [
      [caches.results, results],
      [caches.vectors, vectors],
    ] as const) {
      const orig = store.set.bind(store) as (k: string, v: unknown) => void;
      (store as { set: (k: string, v: unknown) => void }).set = (k, v) => {
        bucket.push(serialize(v).byteLength);
        orig(k, v);
      };
    }
    const registry = makeRegistry(caches);
    const rows: number[] = [];
    for (const q of queries) {
      const t = await call(registry, callerA, q.query_text, topK);
      rows.push(((t.data.results ?? t.data.notes ?? []) as unknown[]).length);
    }
    const stat = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return {
        n: s.length,
        median: summarize(s).p50,
        p95: summarize(s).p95,
        max: s[s.length - 1],
        total: s.reduce((a, b) => a + b, 0),
      };
    };
    const top64 = (xs: number[]) =>
      [...xs]
        .sort((a, b) => b - a)
        .slice(0, MAX_ENTRIES)
        .reduce((a, b) => a + b, 0);
    sizes[`finalTopK${topK}`] = {
      resultsEntryBytes: stat(results),
      vectorsEntryBytes: stat(vectors),
      meanRowsPerResponse: rows.reduce((a, b) => a + b, 0) / rows.length,
      first64ResultsBytes: results.slice(0, MAX_ENTRIES).reduce((a, b) => a + b, 0),
      worst64ResultsBytes: top64(results),
      worst64VectorsBytes: top64(vectors),
    };
  }
  result.memory = sizes;
  // Heap actually held by 64 resident entries at the default final_top_k (JS engine overhead included).
  const heap: Record<string, number> = {};
  for (const topK of [30, 100]) {
    const caches = newCaches();
    const registry = makeRegistry(caches);
    for (const q of queries.slice(0, MAX_ENTRIES))
      await call(offRegistry, callerA, q.query_text, topK);
    const before = heapUsed();
    for (const q of queries.slice(0, MAX_ENTRIES))
      await call(registry, callerA, q.query_text, topK);
    const after = heapUsed();
    heap[`finalTopK${topK}`] = after - before;
    caches.results.clear();
    caches.vectors.clear();
  }
  result.heapHeldBytesAt64Entries = heap;
  const offD = await Promise.all(queries.map((q) => call(offRegistry, callerA, q.query_text)));
  perQuery = perQueryFor(
    offD.map((t) => t.data),
    offD.map((t) => t.data),
  );
} else if (mode === "embed") {
  const ms: number[] = [];
  for (const q of queries.slice(0, 30)) {
    const t0 = performance.now();
    await baseProvider.embed([q.query_text], { input: "query" });
    ms.push(performance.now() - t0);
  }
  result.embedRoundTripMs = summarize(ms);
  perQuery = [];
} else {
  throw new Error(`unknown --mode ${mode}`);
}

result.loadavgEnd = loadavg();
writeFileSync(
  out,
  `${JSON.stringify({ flags: [`query-cache-${mode}`, `tool=${tool}`, `embed=${embedMode}`, ...(mode === "latency" ? [`repeat=${repeatRate}`] : [])], ...result, perQuery })}\n`,
);
process.stderr.write(`${JSON.stringify({ ...result, perQuery: undefined })}\n`);
db.close?.();
