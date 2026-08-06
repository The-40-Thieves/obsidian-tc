import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../../src/db/open";
import { provisionCacheDb } from "../../src/db/provision";
import type { Database, Statement } from "../../src/db/types";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../../src/embeddings";
import { estimateTokens } from "../../src/search/chunk";
import { type IndexStats, indexVault } from "../../src/search/indexer";
import { buildRepresentationManifest } from "../../src/search/representation";
import type { Scenario } from "./scenarios";

/** Deterministic PRNG (Mulberry32). No Date/Math.random in corpus generation. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "vault",
  "chunk",
  "embed",
  "graph",
  "recall",
  "bridge",
  "index",
  "query",
  "token",
  "vector",
  "sparse",
  "dense",
  "rerank",
  "fusion",
  "activation",
  "scope",
];

function paragraph(rnd: () => number, n = 24): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)] as string);
  return out.join(" ");
}

/** Counts embed() calls + total texts embedded, for dup-ratio + embed-throughput collectors. */
export interface CountingProvider extends EmbeddingProvider {
  calls: number;
  texts: number;
  /** THE-458: estimated tokens actually sent to the provider, for `embed.tokens_per_s`. Uses
   *  PRODUCTION's `estimateTokens` (search/chunk.ts) rather than a harness-local approximation —
   *  a throughput number computed with a different estimator than the one that decides batching
   *  would measure a quantity the server never acts on. */
  tokens: number;
}
export function countingProvider(base: EmbeddingProvider): CountingProvider {
  const wrapped: CountingProvider = {
    id: base.id,
    provider: base.provider,
    model: base.model,
    dimensions: base.dimensions,
    calls: 0,
    texts: 0,
    tokens: 0,
    embed(texts, opts) {
      wrapped.calls += 1;
      wrapped.texts += texts.length;
      for (const t of texts) wrapped.tokens += estimateTokens(t);
      return base.embed(texts, opts);
    },
  };
  return wrapped;
}

/** THE-581: a vec0 KNN query. Densification's cost is driven by how many OUTER per-chunk vecKnn
 *  calls run (that is the unit THE-486's "100x fewer chunks" and THE-533's bound are both expressed
 *  in), so the metric counts EXECUTIONS of this statement shape, not preparations — a cached
 *  statement is prepared once and run per chunk. */
const VEC_KNN_SQL = /FROM\s+vec_chunks\b[\s\S]*\bMATCH\b/i;

/** Any transaction start, in any mode. Deliberately NOT `sql === "BEGIN"`: THE-585 (#5) moved the
 *  index write paths to `BEGIN IMMEDIATE`, and an exact-string test silently stopped counting them.
 *  Because `index.txn_count` is lower-is-better, that miss would have surfaced as a spectacular
 *  improvement rather than a broken metric — the perf gate would have applauded it. */
const BEGIN_STMT = /^\s*BEGIN\b/i;

/** Counts write-transaction starts (`exec("BEGIN")`) issued through this connection, for
 *  THE-503's `index.txn_count` metric: how many transactions indexVault's own batching (THE-500)
 *  actually used to write this vault, as a "fewer is better" figure rather than an exact-match
 *  invariant a legitimate batching improvement could never register on.
 *
 *  THE-581 adds `vecKnnCalls` on the same seam. Counting here rather than instrumenting
 *  src/search/vec.ts keeps the production path free of measurement hooks: the harness already owns
 *  this connection, and every vec0 KNN necessarily crosses it. */
export interface CountingDatabase extends Database {
  writeTxnCount: number;
  vecKnnCalls: number;
  /** THE-419: cumulative wall time inside vec0 KNN `.all()` calls, milliseconds.
   *
   *  The call COUNT (above) is a property of the traversal and is deterministic; this is a TIMING
   *  and is not. It exists because THE-419's gate — "a MEASURED large-vault vector-latency
   *  bottleneck" — was unmeasurable as written: nothing in eval/perf recorded vector latency at
   *  all, so neither the gate nor a regression against it could ever fire. Counting calls does not
   *  substitute: ANN's whole proposition is lowering the cost PER call, which a call count cannot
   *  see by construction. */
  vecKnnTotalMs: number;
}
export function countingDatabase(base: Database): CountingDatabase {
  // Wrap a prepared statement so each .all() on a vec0 KNN increments the counter. Only `all` is
  // wrapped because a KNN is only ever read that way; run/get pass straight through.
  const countIfKnn = (sql: string, stmt: Statement): Statement => {
    if (!VEC_KNN_SQL.test(sql)) return stmt;
    return {
      run: (...p: unknown[]) => stmt.run(...p),
      get: (...p: unknown[]) => stmt.get(...p),
      all: (...p: unknown[]) => {
        // THE-419: time the call, not the preparation. Measured around `.all()` because that is the
        // execution, and a cached statement prepares once and runs per chunk — timing preparation
        // would report near-zero and look like a fast index.
        const t0 = performance.now();
        try {
          return stmt.all(...p);
        } finally {
          // `finally` so a throwing query still records its cost. A KNN that fails slowly is the
          // exact shape a latency gate should catch, and an early return would hide it.
          wrapped.vecKnnTotalMs += performance.now() - t0;
          wrapped.vecKnnCalls += 1;
        }
      },
    };
  };
  const wrapped: CountingDatabase = {
    writeTxnCount: 0,
    vecKnnCalls: 0,
    vecKnnTotalMs: 0,
    exec(sql: string) {
      if (BEGIN_STMT.test(sql)) wrapped.writeTxnCount += 1;
      base.exec(sql);
    },
    prepare: (sql: string) => countIfKnn(sql, base.prepare(sql)),
    prepareCached: base.prepareCached
      ? (sql: string) =>
          countIfKnn(sql, (base.prepareCached as NonNullable<Database["prepareCached"]>)(sql))
      : undefined,
    loadExtension: base.loadExtension
      ? (path: string) => (base.loadExtension as NonNullable<Database["loadExtension"]>)(path)
      : undefined,
    close: base.close ? () => (base.close as NonNullable<Database["close"]>)() : undefined,
  };
  return wrapped;
}

export interface VaultCtx {
  db: Database;
  root: string;
  vaultId: string;
  provider: CountingProvider;
  stats: IndexStats;
  chunkCount: number;
  /** Real write-transaction count indexVault used to build this vault (THE-503, family 7). */
  writeTxnCount: number;
  /** THE-581: vec0 KNN executions during the build. Deterministic given the seeded corpus, and the
   *  unit densification's cost is actually expressed in. Non-zero only for a densify scenario —
   *  a plain index does no vector KNN. */
  vecKnnCalls: number;
  /** THE-419: cumulative vec0 KNN wall time for this build, milliseconds. Divided by `vecKnnCalls`
   *  it is the per-call latency THE-419's scale gate is expressed in. Zero for a non-densify
   *  scenario, exactly like the call count. */
  vecKnnTotalMs: number;
  /** THE-581: the scenario that produced this vault, so a collector can tell whether densification
   *  was supposed to run and refuse to report a silent skip as a clean measurement. */
  scenario: Scenario;
  /** THE-581: wall time of the indexVault call alone (excludes corpus generation, which `buildMs`
   *  in run.ts includes). For a densify scenario this is the whole build WITH densification, not
   *  densification in isolation — indexVault exposes no hook to time the pass by itself. Since
   *  `densify` and `small` share a corpus by construction, the densification cost is the difference
   *  between their index_ms, which is a cross-scenario read the gate does not do today. */
  indexMs: number;
  cleanup: () => void;
}

/** THE-581: how many distinct topic tags the densify corpus spreads notes across. 7 over 100 notes
 *  gives ~14 notes per topic — enough co-occurrence to build a real edge set, while staying under
 *  the indexer's default maxTagFanout of 25 so the metric measures densification rather than the
 *  fanout clamp. */
const DENSIFY_TOPICS = 7;

/** Deterministic frontmatter tags, or "" for scenarios without densification (which must keep
 *  producing byte-identical files to before this ticket). Tags are a function of the note index
 *  only — no PRNG draw — so the corpus stays seed-stable and the tag graph is reproducible. */
function tagFrontmatter(sc: Scenario, n: number): string {
  if (!sc.densify) return "";
  return `---\ntags: [topic-${n % DENSIFY_TOPICS}, group-${n % sc.dupGroups}]\n---\n\n`;
}

/** Build + index a seeded synthetic vault on the REAL bun storage path. */
export async function buildVault(sc: Scenario): Promise<VaultCtx> {
  const rnd = mulberry32(sc.seed);
  const root = mkdtempSync(join(tmpdir(), `obtc-perf-${sc.name}-`));

  // A fixed pool of distinct bodies; notes cycle through it so `dupGroups` distinct
  // bodies back `notes` files -> duplicate-body set is exact and seed-stable.
  //
  // THE-459 fix: the shared WORDS vocabulary means paragraph text alone does not
  // distinguish body group i from group j (all groups draw from the same 16 words),
  // so a query for "Body i" never ranks group i's notes above the rest -> dead
  // family-9 recall/nDCG gate (see labelled.ts). Each group gets a DISTINCTIVE,
  // DETERMINISTIC sentinel token `zqmarker${i}` that is a function of the group
  // index i ONLY (never the note index n, never rnd) -> every note sharing group i
  // still gets a byte-identical body section, preserving the dedup that families
  // 4/5 depend on. The sentinel is its own line in the body's PARAGRAPH content
  // (not the `# Body ${i}` heading line) because chunkNote (src/search/chunk.ts)
  // strips ATX heading lines into `headings` metadata and excludes them from the
  // chunked/embedded `content` when chunkContext is off (as it is here) -- a
  // sentinel placed only in the heading never reaches BM25/embedding at all.
  const bodies: string[] = [];
  for (let i = 0; i < sc.dupGroups; i++) {
    const paras: string[] = [];
    for (let p = 0; p < sc.paragraphs; p++) paras.push(paragraph(rnd));
    bodies.push(`# Body ${i}\n\nzqmarker${i}\n\n${paras.join("\n\n")}`);
  }
  for (let n = 0; n < sc.notes; n++) {
    const body = bodies[n % sc.dupGroups] as string;
    const links: string[] = [];
    for (let l = 0; l < sc.linkFanout; l++) {
      links.push(`[[note-${Math.floor(rnd() * sc.notes)}]]`);
    }
    const rel = `note-${n}.md`;
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    // Links live under their own heading, in a SEPARATE chunk from the body: the chunker
    // (src/search/chunk.ts) makes one chunk per heading section, and body-sha dedup keys on
    // that section's raw content. If the link line shared the body's section, its per-note
    // random targets would make every note's chunk content distinct and no dedup would ever
    // fire. Isolating it keeps the `dupGroups` body sections byte-identical (and dedup-able)
    // while the per-note link section still varies.
    //
    // THE-581: densify scenarios prepend FRONTMATTER tags. Frontmatter specifically, because
    // parseNote (src/vault/tags.ts) strips it before the chunker sees the body — so the chunk
    // content, the dedup groups, and the embeddings stay byte-identical to the untagged scenario,
    // and only the note-level tag metadata differs. An untagged corpus would make tag
    // co-occurrence produce zero edges, i.e. a scenario that "runs" densification while measuring
    // nothing, which is the bug this ticket exists to close rather than reproduce.
    writeFileSync(abs, `${tagFrontmatter(sc, n)}${body}\n\n## Links\n\n${links.join(" ")}\n`);
  }

  const rawDb = await openDatabase(":memory:");
  provisionCacheDb(rawDb); // schema setup — not counted; only indexVault's own write txns are.
  const db = countingDatabase(rawDb);
  const provider = countingProvider(fakeEmbeddingProvider({ dimensions: 32, model: "fake-perf" }));
  const indexT0 = performance.now();
  const stats = await indexVault({
    db,
    provider,
    vaultId: sc.name,
    root,
    isReadable: () => true,
    chunkContext: false,
    representation: buildRepresentationManifest(provider, { chunkContext: false }),
    // THE-581: the missing option. Densification is opt-in and off by default, so omitting this —
    // as every scenario did before — meant the pass never ran and no metric could observe it.
    ...(sc.densify ? { densify: sc.densify } : {}),
  });
  const indexMs = performance.now() - indexT0;

  const chunkCount = (db.prepare("SELECT count(*) c FROM chunks").get() as { c: number }).c;
  return {
    db,
    root,
    vaultId: sc.name,
    provider,
    stats,
    chunkCount,
    writeTxnCount: db.writeTxnCount,
    vecKnnCalls: db.vecKnnCalls,
    vecKnnTotalMs: db.vecKnnTotalMs,
    scenario: sc,
    indexMs,
    cleanup: () => {
      // Idempotent close: collectors (e.g. collectLifecycle, family 13) close `db` themselves to
      // time shutdown drain, and orchestration may call this cleanup afterward. A second
      // better-sqlite3 close() throws, so swallow it here — closing an already-closed handle is
      // a no-op by intent, not an error.
      try {
        db.close?.();
      } catch {
        // already closed — safe to ignore
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface Quantiles {
  p50: number;
  p95: number;
  p99: number;
}
export function quantiles(nums: number[]): Quantiles {
  const s = [...nums].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

/** Warmup + measured wall-time quantiles over `n` iterations of `fn`. */
export async function timedQuantiles(
  fn: () => Promise<unknown> | unknown,
  n = 20,
  warmup = 3,
): Promise<Quantiles> {
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return quantiles(samples);
}
