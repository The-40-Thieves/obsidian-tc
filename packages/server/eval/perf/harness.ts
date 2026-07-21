import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../../src/db/open";
import { provisionCacheDb } from "../../src/db/provision";
import type { Database } from "../../src/db/types";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../../src/embeddings";
import { type IndexStats, indexVault } from "../../src/search/indexer";
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
}
export function countingProvider(base: EmbeddingProvider): CountingProvider {
  const wrapped: CountingProvider = {
    id: base.id,
    provider: base.provider,
    model: base.model,
    dimensions: base.dimensions,
    calls: 0,
    texts: 0,
    embed(texts, opts) {
      wrapped.calls += 1;
      wrapped.texts += texts.length;
      return base.embed(texts, opts);
    },
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
  cleanup: () => void;
}

/** Build + index a seeded synthetic vault on the REAL bun storage path. */
export async function buildVault(sc: Scenario): Promise<VaultCtx> {
  const rnd = mulberry32(sc.seed);
  const root = mkdtempSync(join(tmpdir(), `obtc-perf-${sc.name}-`));

  // A fixed pool of distinct bodies; notes cycle through it so `dupGroups` distinct
  // bodies back `notes` files -> duplicate-body set is exact and seed-stable.
  const bodies: string[] = [];
  for (let i = 0; i < sc.dupGroups; i++) {
    const paras: string[] = [];
    for (let p = 0; p < sc.paragraphs; p++) paras.push(paragraph(rnd));
    bodies.push(`# Body ${i}\n\n${paras.join("\n\n")}`);
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
    writeFileSync(abs, `${body}\n\n## Links\n\n${links.join(" ")}\n`);
  }

  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  const provider = countingProvider(fakeEmbeddingProvider({ dimensions: 32, model: "fake-perf" }));
  const stats = await indexVault({
    db,
    provider,
    vaultId: sc.name,
    root,
    isReadable: () => true,
    chunkContext: false,
  });

  const chunkCount = (db.prepare("SELECT count(*) c FROM chunks").get() as { c: number }).c;
  return {
    db,
    root,
    vaultId: sc.name,
    provider,
    stats,
    chunkCount,
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
