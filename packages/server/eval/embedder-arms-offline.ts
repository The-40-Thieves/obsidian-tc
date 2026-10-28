// Offline (Modal-batched) embedder arms: the pure rules embedder-arms.ts applies to a GPU batch run.
// The harness exports each arm's chunk texts and query texts, the GPU script embeds them into raw
// float32 files, and the harness loads those files back, checking them against its own export first.
// No I/O and no network here: every rule is unit-testable (test/eval-embedder-arms-offline.test.ts).
import { join } from "node:path";
import type { Database } from "../src/db/types";
import type { EgressFilter } from "../src/plane/egress-filter";
import { invalidateVecIndex } from "../src/search/vec";
import {
  CONTROL_ARM,
  type Corpus,
  documentText,
  EMBEDDER_ARMS,
  type EmbedderArm,
  queryText,
} from "./embedder-arms-lib";
import { type ExportedChunkTexts, exportChunkTexts, loadGpuVecs } from "./gpu-embed-lib";

export const OFFLINE_LATENCY_NOTE = "batch-embedded off-box; per-query latency not applicable";
/** The false-discovery rate of the Benjamini-Hochberg correction over the decision family. */
export const BH_Q = 0.1;

/** The vectors file a GPU run writes for an arm: one width per file, named by its dimension. */
export const vecsFileFor = (exportDir: string, arm: EmbedderArm): string =>
  join(exportDir, `vecs-${arm.dims}.f32`);
export const queryVecsFileFor = (exportDir: string, arm: EmbedderArm): string =>
  join(exportDir, `qvecs-${arm.dims}.f32`);
export const poolsPathFor = (exp: string, arm: string): string => join(exp, `pools-${arm}.json`);

/** The Modal command that embeds an arm's chunk export. nomic is single-width; the EmbeddingGemma 2
 *  script writes both MRL widths in one run, so either arm's export gets both files. */
export function nextEmbedCommand(arm: EmbedderArm, exportDir: string): string {
  const texts = join(exportDir, "texts.jsonl");
  if (arm.family === "modal-nomic") {
    return `modal run eval/modal_embed_nomic.py --texts ${texts} --out ${vecsFileFor(exportDir, arm)}`;
  }
  return `modal run eval/modal_embed_gemma2.py --texts ${texts} --out-prefix ${join(exportDir, "vecs")} --dims 768,256 --log ${join(exportDir, "embed-log.json")}`;
}

/** The Modal command that embeds an arm's query export. Rows come back in query-ids.json order. */
export function nextQueryCommand(arm: EmbedderArm, exportDir: string): string {
  const queries = join(exportDir, "queries.jsonl");
  if (arm.family === "modal-nomic") {
    return `modal run eval/modal_embed_nomic.py --texts ${queries} --out ${queryVecsFileFor(exportDir, arm)}`;
  }
  return `modal run eval/modal_embed_gemma2.py --queries ${queries} --qout-prefix ${join(exportDir, "qvecs")} --dims 768,256`;
}

/** The chunk export for an arm: the same rows and egress rule as every other arm, with the arm's own
 *  document text. `chunkContext` is ignored once `textOf` is given. */
export function armChunkTexts(
  db: Database,
  vaultIds: readonly string[],
  arm: EmbedderArm,
  egress: EgressFilter,
): ExportedChunkTexts {
  return exportChunkTexts(db, vaultIds, {
    chunkContext: true,
    egress,
    textOf: (c) => documentText(arm, { path: c.path, headings: c.headings, content: c.content }),
  });
}

/** One `{"key","text"}` line per raw query, the text through the arm's query side. */
export function queryExportLines(arm: EmbedderArm, rawQueries: readonly string[]): string[] {
  return rawQueries.map((key) => JSON.stringify({ key, text: queryText(arm, key) }));
}

/** The ids the caller hands back must be the fresh export's ids, in order. A mismatch names the
 *  first differing position and never echoes an id. */
export function assertIdsMatch(fresh: readonly string[], given: unknown): void {
  if (!Array.isArray(given) || !given.every((x) => typeof x === "string")) {
    throw new Error("ids file must be a JSON array of chunk ids");
  }
  if (given.length !== fresh.length) {
    throw new Error(`ids: ${given.length} given, ${fresh.length} in the fresh export`);
  }
  const at = fresh.findIndex((id, i) => given[i] !== id);
  if (at >= 0) {
    throw new Error(
      `ids differ from the fresh export at position ${at}; the export order changed, re-run the export`,
    );
  }
}

/** Raw little-endian float32 bytes as rows of `dims`. A width that does not divide the buffer is refused. The
 *  copy makes the view 4-byte aligned whatever the caller's offset was. */
function f32Matrix(vecs: Uint8Array, dims: number): { f: Float32Array; rows: number } {
  const rowBytes = dims * 4;
  if (vecs.length % rowBytes !== 0) {
    throw new Error(`width: ${vecs.length} bytes is not a whole number of ${dims}-dim rows`);
  }
  return { f: new Float32Array(new Uint8Array(vecs).buffer), rows: vecs.length / rowBytes };
}

/** Names the first row with a NaN or an Infinity. */
function assertFiniteRows(f: Float32Array, dims: number, label: string): void {
  for (let r = 0; r < f.length / dims; r++) {
    if (!f.subarray(r * dims, (r + 1) * dims).every(Number.isFinite))
      throw new Error(`${label} row ${r} has a non-finite value`);
  }
}

/** Query vectors from a GPU run, keyed by raw query, as the HTTP path writes them. Checks the keys
 *  against the fresh export, the row count and width against the arm, and every value for finiteness. */
export function assembleQueryVecs(opts: {
  dims: number;
  exportKeys: readonly string[];
  qids: unknown;
  vecs: Uint8Array;
}): Record<string, number[]> {
  const { dims, exportKeys, qids, vecs } = opts;
  if (!Array.isArray(qids) || !qids.every((x) => typeof x === "string")) {
    throw new Error("query ids must be a JSON array of query keys");
  }
  if (qids.length !== exportKeys.length) {
    throw new Error(`query ids: ${qids.length} given, ${exportKeys.length} in the fresh export`);
  }
  const at = exportKeys.findIndex((k, i) => qids[i] !== k);
  if (at >= 0) throw new Error(`query ids differ from the fresh export at position ${at}`);
  const { f, rows } = f32Matrix(vecs, dims);
  if (rows !== exportKeys.length) {
    throw new Error(`query vectors: ${rows} rows, ${exportKeys.length} keys`);
  }
  const out: Record<string, number[]> = {};
  exportKeys.forEach((key, r) => {
    const row = Array.from(f.subarray(r * dims, (r + 1) * dims));
    if (!row.every(Number.isFinite))
      throw new Error(`query vector row ${r} has a non-finite value`);
    out[key] = row;
  });
  return out;
}

/** Loads a GPU run's document vectors into an arm's index copy and returns the rows now under `model`. Every check
 *  runs BEFORE the first write: the ids the run consumed must equal the fresh export's (a renamed note keeps the
 *  count but moves the rows, which would load each vector onto its neighbour), the vectors must be finite, and the
 *  copy may hold no rows under the model for chunks outside the export. Throws when the count is not the export's. */
export function loadOfflineDocVecs(
  db: Database,
  o: {
    arm: EmbedderArm;
    model: string;
    fresh: readonly string[];
    givenIds: unknown;
    vecs: Uint8Array;
  },
): number {
  assertIdsMatch(o.fresh, o.givenIds);
  const { f, rows } = f32Matrix(o.vecs, o.arm.dims);
  if (rows !== o.fresh.length) {
    throw new Error(`doc vectors: ${rows} rows, ${o.fresh.length} chunks in the fresh export`);
  }
  assertFiniteRows(f, o.arm.dims, "doc vector");
  const inExport = new Set(o.fresh);
  const stored = db
    .prepare("SELECT chunk_id FROM chunk_embeddings WHERE model = ?")
    .all(o.model) as Array<{ chunk_id: string }>;
  const stale = stored.filter((r) => !inExport.has(r.chunk_id)).length;
  if (stale > 0) {
    throw new Error(
      `${stale} stored row(s) under ${o.model} are not in this export (a stale copy); re-run index on a fresh copy`,
    );
  }
  loadGpuVecs(db, { model: o.model, dim: o.arm.dims, ids: o.fresh, vecs: o.vecs, insert: true });
  invalidateVecIndex(db);
  const done = (
    db.prepare("SELECT count(*) AS c FROM chunk_embeddings WHERE model = ?").get(o.model) as {
      c: number;
    }
  ).c;
  if (done !== o.fresh.length) {
    throw new Error(`${done} rows under ${o.model} after the load, ${o.fresh.length} chunks`);
  }
  return done;
}

/** The flags that re-run `index` with a GPU run's document vectors. gemma2's script writes its consumed ids
 *  and embed log beside the vectors; nomic's writes neither, so its export ids.json is the reference. */
export function indexRerunArgs(arm: EmbedderArm, exportDir: string): string {
  const base = `--vecs ${vecsFileFor(exportDir, arm)}`;
  if (arm.family === "modal-nomic") return `${base} --ids ${join(exportDir, "ids.json")}`;
  return `${base} --ids ${join(exportDir, "vecs-ids.json")} --embed-log ${join(exportDir, "embed-log.json")}`;
}

/** The flags that re-run `queries` with a GPU run's query vectors. */
export function queryRerunArgs(arm: EmbedderArm, exportDir: string): string {
  const base = `--qvecs ${queryVecsFileFor(exportDir, arm)}`;
  if (arm.family === "modal-nomic") return `${base} --qids ${join(exportDir, "query-ids.json")}`;
  return `${base} --qids ${join(exportDir, "qvecs-ids.json")}`;
}

/** The BH family a score run corrected over: the decision-bearing arms it was given, with m and q, recorded per
 *  label set so the verdict can be re-derived from the summary alone. */
export function bhFamilyRecord(arms: readonly string[]): { arms: string[]; m: number; q: number } {
  return { arms: [...arms], m: arms.length, q: BH_Q };
}

/** Decision-bearing arms with a pools file in the experiment that `--arms` left out. A score over a smaller family
 *  than the one that was run would correct over the wrong m, so the caller warns about each name returned. */
export function omittedDecisionArms(
  armNames: readonly string[],
  exp: string,
  exists: (path: string) => boolean,
): string[] {
  return EMBEDDER_ARMS.filter(
    (a) => a.decisionBearing && !armNames.includes(a.name) && exists(poolsPathFor(exp, a.name)),
  ).map((a) => a.name);
}

export interface EmbedLogBatch {
  n: number;
  chars: number;
  ms: number;
  retries: number;
}

/** The GPU script's `{shards:[{n, chars, ms}]}` as the batches score reads. A GPU run retries
 *  nothing here, so retries is zero. No embed log gives no batches. */
export function embedLogBatches(embedLog: unknown): EmbedLogBatch[] {
  if (embedLog === undefined) return [];
  const shards = (embedLog as { shards?: unknown } | null)?.shards;
  if (!Array.isArray(shards)) throw new Error("embed log has no shards array");
  return shards.map((s, i) => {
    const { n, chars, ms } = s as Record<string, unknown>;
    if (![n, chars, ms].every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new Error(`embed log shard ${i} needs numeric n, chars and ms`);
    }
    return { n, chars, ms, retries: 0 } as EmbedLogBatch;
  });
}

/** The embed log score reads, the same shape the HTTP path writes. */
export function buildArmEmbedLog(o: {
  arm: EmbedderArm;
  corpus: Corpus;
  chunks: number;
  batches: EmbedLogBatch[];
}): Record<string, unknown> {
  return {
    arm: o.arm.name,
    corpus: o.corpus,
    model: o.arm.model,
    dims: o.arm.dims,
    chunks: o.chunks,
    batches: o.batches,
  };
}

/** Latency of a batch-embedded query set: no per-query timing exists, so every figure is null. */
export function queryLatencyRecord(
  arm: EmbedderArm,
  corpus: Corpus,
  n: number,
): Record<string, unknown> {
  return {
    arm: arm.name,
    corpus,
    n,
    p50_ms: null,
    p95_ms: null,
    mean_ms: null,
    ms: [],
    note: OFFLINE_LATENCY_NOTE,
  };
}

/** The `query_embed_ms` figure score records: null when there is no latency, never Math.round(null). */
export function queryEmbedMs(
  lat: { p50_ms: number | null; p95_ms: number | null } | undefined,
): { p50: number; p95: number } | null {
  if (!lat || lat.p50_ms === null || lat.p95_ms === null) return null;
  return { p50: Math.round(lat.p50_ms), p95: Math.round(lat.p95_ms) };
}

/** The first named arm (the control always included: its pools are the baseline) with no pools file, as a message
 *  naming the arm and the expected path. */
export function missingPoolsError(
  exp: string,
  armNames: readonly string[],
  exists: (path: string) => boolean,
): string | null {
  for (const name of [CONTROL_ARM, ...armNames]) {
    const path = poolsPathFor(exp, name);
    if (!exists(path)) {
      return `score: arm "${name}" has no pools file at ${path}; run rerank-arms.ts pools for it first`;
    }
  }
  return null;
}
