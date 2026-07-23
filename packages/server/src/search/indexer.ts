// Chunk-store writer: turns notes into persisted chunks + embeddings, and keeps
// the store incremental. A chunk's id is stable for a (vault, path, position), so
// re-indexing skips chunks whose content hash is unchanged, re-embeds changed
// ones, and prunes chunks that no longer exist in the note. chunk_embeddings is
// deleted explicitly (not relying on FK cascade, which node:sqlite tests run with
// foreign_keys off). vec_chunks is kept in lock-step only when the extension loaded.
import { err, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { tableExists } from "../db/introspect";
import { cachedPrepare, type Database } from "../db/types";
import type { EmbeddingProvider } from "../embeddings";
import { parseNote } from "../vault/frontmatter";
import { type ExtractedLink, extractLinks } from "../vault/links";
import { readNote } from "../vault/notes-io";
import { contentHash, resolveVaultPath, walkVault } from "../vault/paths";
import { noteTags } from "../vault/tags";
import { chunkNote, enrichChunkText } from "./chunk";
import { deleteChunkColbert, ensureChunkColbert, upsertChunkColbert } from "./chunk_colbert";
import { deleteChunkFtsRow, ensureChunkFts, upsertChunkFtsRow } from "./chunk_fts";
import type { ColbertMatrix } from "./colbert";
import {
  computeKnnEdges,
  computeKnnEdgesForPaths,
  countDerivedEdges,
  knnNeighborScope,
  notesWithTagChanges,
  reconcileDerivedEdges,
  reconcileDerivedEdgesScoped,
  tagCooccurrenceEdges,
  tagCooccurrenceEdgesForNotes,
  tagCooccurrenceScope,
} from "./derived-edges";
import { desiredEdges, reconcileVaultEdges } from "./edges";
import {
  buildNoteRecord,
  deleteNoteRow,
  ensureNotesFts,
  hasNotesTable,
  type NoteRecord,
  noteRowHash,
  upsertNoteRow,
} from "./fts";
import { bumpGeneration } from "./generation";
import {
  CHUNKER_VERSION,
  ENRICHMENT_VERSION,
  VEC_DISTANCE_METRIC,
  VEC_SCHEMA_GEN,
} from "./representation";
import { scanSecrets } from "./secrets";
import { deleteChunkSparse, ensureChunkSparse, type SparseVec, upsertChunkSparse } from "./sparse";
import { blobToFloats, ensureVecChunks, floatBlob, upsertVec } from "./vec";

export interface IndexStats {
  notes_seen: number;
  notes_indexed: number;
  chunks_upserted: number;
  chunks_deleted: number;
  chunks_unchanged: number;
  edges_inserted: number;
  edges_deleted: number;
  secrets_skipped: number;
  vec_enabled: boolean;
  /** THE-291 (additive): FTS5 availability + notes-metadata write counts. */
  fts_enabled: boolean;
  notes_upserted: number;
  notes_deleted: number;
  /** THE-390 (additive): notes skipped this pass because the embed provider rejected one of
   *  their chunks even as a single-text request; retried automatically next reconcile. */
  notes_embed_failed: number;
  /** THE-499: chunks whose embedding was reused from an identical-body sibling this pass (dedup),
   *  aggregated instead of logged per-chunk. */
  chunks_dedup_reused: number;
  model: string;
  dimensions: number;
}

/** A chunk that was (re)embedded this pass; handed to the optional index hook. */
export interface IndexedChunk {
  id: string;
  path: string;
  content: string;
  embedding: number[];
}

/** THE-233 W-INGEST seam: notified of newly-embedded chunks. W-WORKERS wires the
 *  contradiction-check enqueue here at integration; default is no hook. */
export type IndexHook = (chunks: IndexedChunk[]) => void;

// Stable, content-independent id for a chunk slot. Re-chunking the same note
// reproduces these ids, so content_hash alone decides re-embed vs. skip.
export function chunkId(vaultId: string, path: string, index: string): string {
  const key = [vaultId, path, index].join(" ");
  return "chk_".concat(contentHash(key).slice(0, 24));
}

interface ExistingRow {
  id: string;
  content_hash: string;
  /** THE-531: the model of this chunk's ACTIVE embedding, or null when it has none. A mismatch with
   *  the current provider forces a re-embed even when content_hash is unchanged. */
  active_model: string | null;
}

// A note's chunk after secret-gating, carrying its stable chunk id. embedText (THE-406) is the
// context-enriched text that is embedded + BM25-indexed INSTEAD of content when
// embeddings.chunkContext is on; content stays the raw display text everywhere.
// bodySha is contentHash() over the RAW body (c.content, PRE-enrichment) — the cross-path
// dedup key; skipEmbed marks a chunk whose identical body was already embedded at another path
// this run, so it is STORED but its embedding is reused/skipped (migration 20260719_001).
type PlannedChunk = ReturnType<typeof chunkNote>[number] & {
  id: string;
  embedText?: string;
  bodySha: string;
  skipEmbed?: boolean;
};

// THE-408: enrichChunkText moved to ./chunk (import-cycle-free for chunk_fts); re-exported here
// for existing importers (tests, scripts).
export { enrichChunkText } from "./chunk";

// A note's pending writes, computed (including the embed() network call) WITHOUT touching the
// database or opening a transaction, so many plans can be applied inside one transaction.
interface NoteWritePlan {
  path: string;
  existing: ExistingRow[];
  desiredIds: Set<string>;
  toEmbed: PlannedChunk[];
  vectors: number[][];
  /** THE-388: filled by embedPlans only when the provider emits embedFull() (bge-m3), parallel to
   *  vectors; written to chunk_sparse / chunk_colbert. Absent for dense-only providers. */
  sparse?: SparseVec[];
  colbert?: ColbertMatrix[];
  ts: number;
}

interface PlanResult {
  plan: NoteWritePlan | null;
  unchanged: number;
  secretsSkipped: number;
  /** THE-291: secret-flagged chunk contents, excised from the note's FTS copy. */
  flagged: string[];
  /** THE-499: number of chunks in this note whose embedding was dedup-reused from a sibling path. */
  dedupSkipped: number;
}

// Provider-sized embed sub-batch + how many to run in flight (THE-277) — the defaults used when a
// caller passes no embed config. GH #171/#172: a request is ALSO capped by estimated tokens
// (EMBED_MAX_BATCH_TOKENS), so a token-dense sub-batch can't overrun a stock local runner's budget
// and crash it regardless of the input count. THE-390: the token cap must stay UNDER the provider's
// loaded context — Ollama defaults to n_ctx 4096 and 400-rejects a request whose SUMMED tokens
// exceed it, and estimateTokens undercounts real tokenization (~2-2.5x on link-dense markdown).
// 2048 estimated keeps a batch inside a 4096 context with that drift; must match the
// EmbeddingsConfigSchema default.
const EMBED_BATCH = 512;
const EMBED_CONCURRENCY = 4;
const EMBED_MAX_BATCH_TOKENS = 2048;

// THE-487: token estimate for the embed batch budget. chars/4 is the right rule-of-thumb for prose,
// but link-dense Markdown ([[...]], tables, URLs) fragments into ~2-2.5x more tokens, so a chars/4
// budget overflowed the provider's n_ctx and forced a bisect+retry. We tighten the divisor toward 3
// as the special-character density rises: prose stays at chars/4 (no batch-size regression), dense
// text is estimated conservatively (fewer overflows). Zero-dependency and still intentionally coarse —
// it only needs to keep a request under n_ctx, not be exact; a real tokenizer is the follow-up if
// measurement shows residual retries.
export function estimateEmbedTokens(text: string): number {
  const len = text.length;
  if (len === 0) return 0;
  const special = (text.match(/[^\w\s]/g) ?? []).length;
  // >12% non-word/non-space (brackets, pipes, slashes, punctuation) marks link/table-dense Markdown.
  const divisor = special / len > 0.12 ? 3 : 4;
  return Math.ceil(len / divisor);
}

// THE-501: preload the whole vault's lightweight chunk state (ids + hashes + active model) in ONE
// query, grouped by path, so a full reconcile plans every note without a per-note chunk query. Never
// loads content or vectors — memory stays bounded to identifiers and hashes.
export function preloadChunkState(db: Database, vaultId: string): Map<string, ExistingRow[]> {
  const rows = db
    .prepare(
      "SELECT c.path AS path, c.id AS id, c.content_hash AS content_hash, e.model AS active_model FROM chunks c LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 WHERE c.vault_id = ? ORDER BY c.path",
    )
    .all(vaultId) as Array<ExistingRow & { path: string }>;
  const byPath = new Map<string, ExistingRow[]>();
  for (const r of rows) {
    const list = byPath.get(r.path);
    const row: ExistingRow = {
      id: r.id,
      content_hash: r.content_hash,
      active_model: r.active_model,
    };
    if (list) list.push(row);
    else byPath.set(r.path, [row]);
  }
  return byPath;
}

// Compute a note's write plan WITHOUT embedding — NO network, NO database writes, NO transaction.
// Vectors are filled later by embedPlans, which batches the embed() calls across many notes so a
// reconcile does not pay one serial round-trip per note. Returns { plan: null } when the note is
// unchanged (nothing to prune or embed), so the caller opens no transaction for a warm re-index.
function computeNotePlan(
  db: Database,
  vaultId: string,
  path: string,
  raw: string,
  ts: number,
  enrich: boolean,
  /** Cross-path embedding dedup (migration 20260719_001): a per-RUN registry of content_hash -> the
   *  first walked path producing that EMBED text. Keying on content_hash (not the raw body_sha) is
   *  what makes dedup safe under contextual enrichment (THE-406): content_hash covers the title +
   *  breadcrumb + body actually embedded, so two identical bodies under DIFFERENT titles no longer
   *  collide and no longer share a (wrongly-titled) vector; with enrichment off it equals the raw-body
   *  hash, so cross-path dedup of identical bodies is unchanged. Purely in-memory, so it works even on
   *  a cache.db that predates the body_sha column. Callers on the batched indexVault path share ONE
   *  map across the whole walk; single-note paths pass a fresh (effectively empty) map. */
  dedupRegistry: Map<string, string> = new Map(),
  /** THE-454: enable cross-path embedding dedup only when applyNoteWrites can later COPY the
   *  sibling's stored vector to a skipEmbed chunk — i.e. when the body_sha column exists. Without
   *  it, embed every chunk, or a duplicate path would be left with no vector (dense-invisible). */
  dedupEnabled = false,
  /** THE-531: the active embedding model (provider.id). A chunk whose stored active embedding is from
   *  a DIFFERENT model is re-embedded even when its content_hash is unchanged, so a same-dimension
   *  model swap re-embeds the corpus on the next reconcile instead of silently shrinking it. Omitted
   *  -> content-hash-only gate (back-compat). */
  model?: string,
  /** THE-501: preloaded per-path chunk state for the whole vault (built once by preloadChunkState).
   *  When present, this note's slice is used and no per-note chunk query runs. Omitted -> per-note
   *  query (the single-note indexing path). */
  preloadedExisting?: Map<string, ExistingRow[]>,
): PlanResult {
  const body = parseNote(raw).body;
  // Secret-gate (THE-134 fold): a chunk whose content matches a credential shape is dropped
  // before embedding — never embedded, never stored, pruned if it existed. Class names only
  // are logged; the matched value is never logged or thrown.
  let secretsSkipped = 0;
  const flagged: string[] = [];
  // THE-406: with enrichment on, the content hash is computed over the ENRICHED text, so flipping
  // embeddings.chunkContext re-embeds every chunk on the next pass instead of silently serving
  // vectors built from a different representation.
  const desired = chunkNote(body)
    .map((c): PlannedChunk => {
      // body_sha keys on the RAW body (c.content), PRE-enrichment — it must NOT depend on the
      // path-salted embed text, so identical bodies at different paths collide (migration
      // 20260719_001).
      const bodySha = contentHash(c.content);
      if (!enrich) return { ...c, id: chunkId(vaultId, path, c.index), bodySha };
      const embedText = enrichChunkText(path, c.headings, c.content);
      return {
        ...c,
        id: chunkId(vaultId, path, c.index),
        embedText,
        contentHash: contentHash(embedText),
        bodySha,
      };
    })
    .filter((c) => {
      const scan = scanSecrets(c.content);
      if (scan.clean) return true;
      flagged.push(c.content);
      secretsSkipped += 1;
      process.stderr.write(
        `[ingest] secret-gate skipped ${path}#${c.index} (${scan.classes.join(", ")})\n`,
      );
      return false;
    });
  const desiredIds = new Set(desired.map((d) => d.id));
  // THE-531: LEFT JOIN the active embedding so we know each chunk's stored model, not just its
  // content_hash. A chunk with no active embedding yields active_model = null (re-embed).
  // THE-501: on a full reconcile the caller preloads the whole vault's chunk state in ONE query and
  // passes this note's slice, so computeNotePlan issues no per-note chunk query (N queries -> 1). The
  // single-note path passes no preload and keeps the targeted per-note query.
  const existing =
    preloadedExisting?.get(path) ??
    (db
      .prepare(
        "SELECT c.id AS id, c.content_hash AS content_hash, e.model AS active_model FROM chunks c LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 WHERE c.vault_id = ? AND c.path = ?",
      )
      .all(vaultId, path) as ExistingRow[]);
  const existingById = new Map(existing.map((e) => [e.id, e]));
  // Re-embed when the content changed OR (THE-531) the stored active model differs from the current
  // one. When `model` is undefined the model check is skipped (back-compat, content-hash-only gate).
  const toEmbed = desired.filter((d) => {
    const ex = existingById.get(d.id);
    if (!ex || ex.content_hash !== d.contentHash) return true;
    return model !== undefined && ex.active_model !== model;
  });
  const unchanged = desired.length - toEmbed.length;
  const willPrune = existing.some((e) => !desiredIds.has(e.id));
  // Cross-path embedding dedup (migration 20260719_001). Register EVERY desired chunk's raw-body
  // hash (changed or not) so a later path dedups against a body already indexed here — first walked
  // path wins. Then flag any TO-EMBED chunk whose body was first seen at a DIFFERENT path: it is
  // still STORED at this path (applyNoteWrites writes the chunk row), but its embedding is
  // reused/skipped — embedPlans never sends it to the provider and applyNoteWrites writes no
  // embedding row for it. Same-path repeats keep firstPath === path and are never skipped (an index
  // shift is change detection's job, not dedup's).
  // THE-499: count dedup reuse and let the caller aggregate it into a single per-pass summary,
  // instead of one synchronous stderr line per duplicate chunk (which could cost more than the dedup
  // and floods CI logs). Individual paths stay available behind OBSIDIAN_TC_DEBUG_DEDUP.
  let dedupSkipped = 0;
  if (dedupEnabled) {
    const debug = process.env.OBSIDIAN_TC_DEBUG_DEDUP !== undefined;
    for (const d of desired) {
      if (!dedupRegistry.has(d.contentHash)) dedupRegistry.set(d.contentHash, path);
    }
    for (const d of toEmbed) {
      const firstPath = dedupRegistry.get(d.contentHash);
      if (firstPath !== undefined && firstPath !== path) {
        d.skipEmbed = true;
        dedupSkipped += 1;
        if (debug) {
          process.stderr.write(
            `[ingest] embed-text dedup: ${path}#${d.index} reuses the embedding already computed for ` +
              `${firstPath} (identical embed text); the vector is copied, not recomputed\n`,
          );
        }
      }
    }
  }
  if (toEmbed.length === 0 && !willPrune) {
    return { plan: null, unchanged, secretsSkipped, flagged, dedupSkipped };
  }
  return {
    plan: { path, existing, desiredIds, toEmbed, vectors: [], ts },
    unchanged,
    secretsSkipped,
    flagged,
    dedupSkipped,
  };
}

/** THE-390: outcome of an embedPlans pass. `failed` lists plans with at least one chunk the
 *  provider rejected even as a single-text request (HTTP 400/413); their vectors are NOT
 *  populated and they must not be applied — the content-hash skip retries them next reconcile.
 *  `rejections` counts rejected requests that were bisected + retried (an operator signal that
 *  `embeddings.maxBatchTokens` sits over the provider context and the pass is paying retries). */
export interface EmbedReport {
  failed: NoteWritePlan[];
  rejections: number;
}

// A provider "request rejected" error — HTTP 400/413, most commonly Ollama refusing a request
// whose summed tokens exceed the model's loaded n_ctx (THE-390). Distinct from an outage
// (timeout / 5xx / network error), which must keep aborting the reconcile.
function isEmbedRejection(e: unknown): boolean {
  if (!(e instanceof ObsidianTcError) || e.code !== "embedding_provider_error") return false;
  const status = e.details?.status;
  return status === 400 || status === 413;
}

// One sub-batch's outputs, aligned to its input order; null marks a quarantined text.
interface SubBatchOut {
  dense: Array<number[] | null>;
  sparse?: Array<SparseVec | null>;
  colbert?: Array<ColbertMatrix | null>;
}

// Embed one sub-batch, bisecting on a provider rejection: the token budget is an ESTIMATE
// (chars/4 undercounts real tokenization), so a packed batch can overshoot the provider context
// and 400 — halve and retry instead of aborting the whole reconcile (THE-390). A single text
// still rejected alone is quarantined as null, never silently truncated. Any other error
// propagates unchanged: a dead backend must abort, not degrade into one failing request per text.
async function embedSubBatch(
  provider: EmbeddingProvider,
  batch: string[],
  useFull: boolean,
  counters: { rejections: number },
): Promise<SubBatchOut> {
  try {
    if (useFull && provider.embedFull) {
      const full = await provider.embedFull(batch);
      return {
        dense: full.map((f) => f.dense),
        sparse: full.map((f) => f.sparse),
        colbert: full.map((f) => f.colbert),
      };
    }
    return { dense: await provider.embed(batch) };
  } catch (e) {
    if (!isEmbedRejection(e)) throw e;
    counters.rejections += 1;
    if (batch.length === 1) {
      return useFull ? { dense: [null], sparse: [null], colbert: [null] } : { dense: [null] };
    }
    const mid = Math.ceil(batch.length / 2);
    const left = await embedSubBatch(provider, batch.slice(0, mid), useFull, counters);
    const right = await embedSubBatch(provider, batch.slice(mid), useFull, counters);
    return {
      dense: left.dense.concat(right.dense),
      ...(useFull
        ? {
            sparse: (left.sparse ?? []).concat(right.sparse ?? []),
            colbert: (left.colbert ?? []).concat(right.colbert ?? []),
          }
        : {}),
    };
  }
}

// Embed all of `plans`' to-embed chunks in provider-sized sub-batches under bounded concurrency
// (THE-277), then write the vectors back onto each plan IN ORDER. Batching across notes turns a
// reconcile's K serial per-note embed round-trips into ceil(total_chunks / batchSize) requests with
// a few in flight. Order is preserved: sub-batch i lands at results[i], concatenated in index order
// and sliced back to each plan by its toEmbed length. The write lock is never held across this.
export async function embedPlans(
  provider: EmbeddingProvider,
  plans: NoteWritePlan[],
  batchSize: number,
  concurrency: number,
  maxBatchTokens: number = EMBED_MAX_BATCH_TOKENS,
): Promise<EmbedReport> {
  const contents: string[] = [];
  // THE-406: embed the enriched text when present; c.content remains the stored display text.
  // Cross-path dedup (migration 20260719_001): a skipEmbed chunk's identical body is already embedded
  // at another path, so it is NOT sent to the provider — its vector slot is filled below.
  for (const p of plans)
    for (const c of p.toEmbed) {
      if (c.skipEmbed) continue;
      contents.push(c.embedText ?? c.content);
    }
  if (contents.length === 0) return { failed: [], rejections: 0 };
  // Pack sub-batches greedily under BOTH caps: at most `batchSize` inputs and at most
  // `maxBatchTokens` estimated tokens per request (GH #172 — a fixed 512-input batch packed ~87k
  // tokens into one call and crashed a stock local runner). A single text that alone exceeds the
  // token cap still goes in its own batch: never split, never dropped.
  const subBatches: string[][] = [];
  let cur: string[] = [];
  let curTokens = 0;
  for (const text of contents) {
    const t = estimateEmbedTokens(text);
    if (cur.length > 0 && (cur.length >= batchSize || curTokens + t > maxBatchTokens)) {
      subBatches.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(text);
    curTokens += t;
  }
  if (cur.length > 0) subBatches.push(cur);
  // THE-388: when the provider emits embedFull() (bge-m3), collect the sparse + ColBERT heads per
  // sub-batch alongside the dense vector; dense-only providers take the embed() path unchanged.
  const hasFull = typeof provider.embedFull === "function";
  const counters = { rejections: 0 };
  const results: SubBatchOut[] = new Array(subBatches.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < subBatches.length; i = next++) {
      results[i] = await embedSubBatch(provider, subBatches[i] as string[], hasFull, counters);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, subBatches.length) }, () => worker()),
  );
  const flatDense = results.flatMap((r) => r.dense);
  const flatSparse = hasFull ? results.flatMap((r) => r.sparse ?? []) : null;
  const flatColbert = hasFull ? results.flatMap((r) => r.colbert ?? []) : null;
  const failed: NoteWritePlan[] = [];
  // Walk each plan's chunks in order, consuming a provider vector only for the ones actually embedded
  // (skipEmbed chunks get an empty placeholder so vectors[] stays aligned to toEmbed; applyNoteWrites
  // writes no embedding for them). A skipEmbed placeholder never counts as a quarantine (migration
  // 20260719_001 + THE-390).
  let off = 0;
  for (const p of plans) {
    const dense: number[][] = [];
    const sparse: SparseVec[] = [];
    const colbert: ColbertMatrix[] = [];
    let quarantined = false;
    for (const c of p.toEmbed) {
      if (c.skipEmbed) {
        dense.push([]);
        if (flatSparse) sparse.push({} as SparseVec);
        if (flatColbert) colbert.push([] as unknown as ColbertMatrix);
        continue;
      }
      const v = flatDense[off];
      // A quarantined chunk (provider rejected it even alone) fails its whole NOTE: its vectors are
      // not applied and the caller must exclude the plan (THE-390).
      if (v === null || v === undefined) quarantined = true;
      dense.push((v ?? []) as number[]);
      if (flatSparse) sparse.push((flatSparse[off] ?? {}) as SparseVec);
      if (flatColbert) colbert.push((flatColbert[off] ?? []) as unknown as ColbertMatrix);
      off += 1;
    }
    if (quarantined) {
      failed.push(p);
    } else {
      p.vectors = dense;
      if (flatSparse) p.sparse = sparse;
      if (flatColbert) p.colbert = colbert;
    }
  }
  return { failed, rejections: counters.rejections };
}

// Single-note plan + embed (indexNote / index-on-write path). indexVault batches embeds instead.
async function planNoteWrites(
  db: Database,
  provider: EmbeddingProvider,
  vaultId: string,
  path: string,
  raw: string,
  ts: number,
  enrich: boolean,
): Promise<PlanResult> {
  // THE-531: pass the active model so an unchanged note whose vectors are from a superseded model is
  // still re-embedded.
  const res = computeNotePlan(db, vaultId, path, raw, ts, enrich, undefined, false, provider.id);
  if (res.plan) {
    const { failed } = await embedPlans(provider, [res.plan], EMBED_BATCH, EMBED_CONCURRENCY);
    // Index-on-write is a single note: a quarantined chunk means the note cannot be applied,
    // so keep the caller's existing best-effort failure semantics (counted as a write failure)
    // rather than writing a partial note.
    if (failed.length > 0) {
      throw err.embeddingProviderError(
        "provider rejected a single-chunk embed request (over its context?)",
        { provider: provider.provider, path },
      );
    }
  }
  return res;
}

/** Does the chunks table carry the body_sha column (migration 20260719_001)? A cache.db provisioned
 *  before that migration — or a bare fixture — lacks it; the INSERT then omits body_sha so the write
 *  path keeps working (the in-memory dedup registry is unaffected). Mirrors hasDerivedEdgeColumns. */
// THE-491: column presence only changes at migration time, and migrations run at open before any
// probe — so this is a per-connection constant. It was re-issuing PRAGMA table_info per NOTE
// (called at :684 in the write path and again per reconcile), so a 1000-note vault paid 1000+
// round trips to answer a fixed question. WeakMap keyed on the connection, matching the pattern
// hasNotesTable already uses in fts.ts, so a closed db's entry is collectable.
const bodyShaCache = new WeakMap<Database, boolean>();
const derivedEdgeCache = new WeakMap<Database, boolean>();

/** @internal exported for the memoization test; production callers use it directly. */
export function hasBodyShaColumn(db: Database): boolean {
  const cached = bodyShaCache.get(db);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const cols = db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    ok = cols.some((c) => c.name === "body_sha");
  } catch {
    ok = false;
  }
  bodyShaCache.set(db, ok);
  return ok;
}

// #280-followup: a chunk's contradiction flags are judged on its exact content; when the chunk is
// pruned or re-embedded (content changed) they are stale and must be dropped, or "open" rows accrue
// unbounded and pollute the synthesis / knowledge_challenge / reflect grounding (all read
// status='open'). Tied to chunk lifetime here, alongside the fts/vec/sparse/colbert cleanup.
const DELETE_CONTRADICTIONS_SQL =
  "DELETE FROM contradictions WHERE source_chunk_id = ? OR conflict_chunk_id = ?";

// THE-454: copy an identical EMBED TEXT's already-stored vectors onto a cross-path-dedup (skipEmbed)
// chunk so it stays retrievable by dense/sparse/ColBERT, not just FTS. The source is another chunk
// (c.id != target) with the same embed representation + model. It MUST match on content_hash (the
// enriched embed-text hash under THE-406), not body_sha alone: two identical raw bodies under
// DIFFERENT titles share a body_sha but embed different text, so copying by body_sha handed the second
// note the first note's (wrongly-titled) vector. body_sha stays in the predicate purely as the indexed
// access path (index chunks_body_sha); content_hash enforces correctness. The owner is visible because
// its plan was applied earlier in this same transaction (walk order) or committed in a prior run
// (THE-445 seed). If the owner has no stored embedding (e.g. it was quarantined), nothing is copied —
// the chunk degrades to FTS-only, no worse than before. Requires the body_sha column (guaranteed:
// skipEmbed is only set when it exists, see computeNotePlan dedupEnabled).
/** THE-488: the source vectors for a dedup copy, keyed by content_hash. `null` caches a MISS (the
 *  owner had no stored embedding) so a duplicate-heavy flush never re-queries a known-absent source. */
type DedupSource = {
  embedding: Uint8Array;
  dimensions: number;
  sparse: string | null;
  colbert: string | null;
} | null;
export type DedupCache = Map<string, DedupSource>;

// THE-488: fetch the owner chunk's stored vectors for a content_hash — one embedding SELECT plus, when
// the columns exist, one sparse and one colbert SELECT. Memoized by copyDedupVectors so this runs once
// per DISTINCT content_hash per flush, not once per deduped chunk.
function fetchDedupSource(
  db: Database,
  args: { vaultId: string; bodySha: string; contentHash: string; model: string; targetId: string },
  hasChunkSparse: boolean,
  hasChunkColbert: boolean,
): DedupSource {
  const emb = cachedPrepare(
    db,
    "SELECT e.embedding AS embedding, e.dimensions AS dimensions FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.vault_id = ? AND c.body_sha = ? AND c.content_hash = ? AND e.model = ? AND e.is_active = 1 AND c.id != ? LIMIT 1",
  ).get(args.vaultId, args.bodySha, args.contentHash, args.model, args.targetId) as
    | { embedding: Uint8Array; dimensions: number }
    | undefined;
  if (!emb) return null;
  const sparse = hasChunkSparse
    ? ((
        cachedPrepare(
          db,
          "SELECT s.weights AS weights FROM chunk_sparse s JOIN chunks c ON c.id = s.chunk_id WHERE c.vault_id = ? AND c.body_sha = ? AND c.content_hash = ? AND c.id != ? LIMIT 1",
        ).get(args.vaultId, args.bodySha, args.contentHash, args.targetId) as
          | { weights: string }
          | undefined
      )?.weights ?? null)
    : null;
  const colbert = hasChunkColbert
    ? ((
        cachedPrepare(
          db,
          "SELECT cb.vectors AS vectors FROM chunk_colbert cb JOIN chunks c ON c.id = cb.chunk_id WHERE c.vault_id = ? AND c.body_sha = ? AND c.content_hash = ? AND c.id != ? LIMIT 1",
        ).get(args.vaultId, args.bodySha, args.contentHash, args.targetId) as
          | { vectors: string }
          | undefined
      )?.vectors ?? null)
    : null;
  return { embedding: emb.embedding, dimensions: emb.dimensions, sparse, colbert };
}

function copyDedupVectors(
  db: Database,
  args: {
    targetId: string;
    bodySha: string;
    contentHash: string;
    vaultId: string;
    path: string;
    model: string;
    ts: number;
    hasVec: boolean;
    hasChunkSparse: boolean;
    hasChunkColbert: boolean;
  },
  cache: DedupCache,
): void {
  // THE-488: memoize the owner's vectors by content_hash for this flush. The source is the same owner
  // chunk for every duplicate of a content_hash, so the JOINs run once per distinct content_hash, not
  // once per deduped chunk (a hot repeated JOIN inside the write txn on template-heavy vaults).
  let src = cache.get(args.contentHash);
  if (src === undefined) {
    src = fetchDedupSource(db, args, args.hasChunkSparse, args.hasChunkColbert);
    cache.set(args.contentHash, src);
  }
  if (!src) return; // no stored embedding to copy — chunk degrades to FTS-only (unchanged behaviour)

  cachedPrepare(
    db,
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(chunk_id, model) DO UPDATE SET dimensions = excluded.dimensions, embedding = excluded.embedding, is_active = 1, generated_at = excluded.generated_at",
  ).run(args.targetId, args.model, src.dimensions, src.embedding, args.ts);
  // THE-531: the copied vector is under the current model, so retire any superseded-model row for the
  // target chunk (same "active = current representation" rule as the direct-embed path).
  cachedPrepare(
    db,
    "UPDATE chunk_embeddings SET is_active = 0 WHERE chunk_id = ? AND model != ? AND is_active = 1",
  ).run(args.targetId, args.model);
  if (args.hasVec)
    upsertVec(db, args.targetId, Array.from(blobToFloats(src.embedding)), {
      vaultId: args.vaultId,
      path: args.path,
      model: args.model,
    });
  // sparse + ColBERT are plain TEXT columns — write the memoized owner values onto the target.
  if (args.hasChunkSparse && src.sparse !== null)
    cachedPrepare(
      db,
      "INSERT INTO chunk_sparse (chunk_id, vault_id, weights) VALUES (?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET vault_id = excluded.vault_id, weights = excluded.weights",
    ).run(args.targetId, args.vaultId, src.sparse);
  if (args.hasChunkColbert && src.colbert !== null)
    cachedPrepare(
      db,
      "INSERT INTO chunk_colbert (chunk_id, vault_id, vectors) VALUES (?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET vault_id = excluded.vault_id, vectors = excluded.vectors",
    ).run(args.targetId, args.vaultId, src.colbert);
}

// Apply a note's write plan (prune + upserts). Contains NO transaction control — the CALLER owns
// BEGIN/COMMIT/ROLLBACK, so one transaction can batch many notes' applies.
function applyNoteWrites(
  db: Database,
  provider: EmbeddingProvider,
  vaultId: string,
  plan: NoteWritePlan,
  hasVec: boolean,
  hasChunkFts: boolean,
  hasChunkSparse: boolean,
  hasChunkColbert: boolean,
  /** migration 20260719_001: write the raw-body hash column only when it exists. */
  hasBodySha: boolean,
  /** THE-488: per-flush memo of dedup source vectors by content_hash, shared across the batch's notes
   *  so a duplicate's JOIN runs once per distinct content_hash. */
  dedupCache: DedupCache,
): { upserted: number; deleted: number } {
  // THE-316: static-arity SQL on the per-note reconcile write path — cache the compiled statements
  // by SQL text (cachedPrepare) so a 100-note flush recompiles these five once for the process, not
  // once per note. The vec0 DELETE is prepared only when the extension loaded — the table may not
  // exist otherwise.
  const delEmb = cachedPrepare(db, "DELETE FROM chunk_embeddings WHERE chunk_id = ?");
  // THE-531: when a chunk is re-embedded under the current model, deactivate any OTHER-model rows for
  // it — PRIMARY KEY (chunk_id, model) lets both coexist, so "active" must mean "current
  // representation", not "ever generated". A superseded row stays in the table (audit/rollback) but
  // is_active = 0 so retrieval and the vec rebuild ignore it.
  const deactivateOld = cachedPrepare(
    db,
    "UPDATE chunk_embeddings SET is_active = 0 WHERE chunk_id = ? AND model != ? AND is_active = 1",
  );
  const delChunk = cachedPrepare(db, "DELETE FROM chunks WHERE id = ?");
  const delVec = hasVec ? cachedPrepare(db, "DELETE FROM vec_chunks WHERE chunk_id = ?") : null;
  // body_sha rides the same upsert when the column exists (migration 20260719_001); cachedPrepare
  // keys on the SQL text, so the with/without-column variants compile independently and a pre-migration
  // cache.db never sees the extra column.
  // `contradictions` is an optional plane table — gate on a cheap in-memory sqlite_master check.
  const delContra = tableExists(db, "contradictions")
    ? cachedPrepare(db, DELETE_CONTRADICTIONS_SQL)
    : null;
  const upChunk = cachedPrepare(
    db,
    hasBodySha
      ? "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, body_sha, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chunk_index = excluded.chunk_index, headings = excluded.headings, content = excluded.content, content_hash = excluded.content_hash, body_sha = excluded.body_sha, token_count = excluded.token_count, updated_at = excluded.updated_at"
      : "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chunk_index = excluded.chunk_index, headings = excluded.headings, content = excluded.content, content_hash = excluded.content_hash, token_count = excluded.token_count, updated_at = excluded.updated_at",
  );
  const upEmb = cachedPrepare(
    db,
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(chunk_id, model) DO UPDATE SET dimensions = excluded.dimensions, embedding = excluded.embedding, is_active = 1, generated_at = excluded.generated_at",
  );
  let deleted = 0;
  for (const e of plan.existing) {
    if (plan.desiredIds.has(e.id)) continue;
    delEmb.run(e.id);
    delChunk.run(e.id);
    if (delVec) delVec.run(e.id);
    if (hasChunkFts) deleteChunkFtsRow(db, e.id);
    if (hasChunkSparse) deleteChunkSparse(db, e.id);
    if (hasChunkColbert) deleteChunkColbert(db, e.id);
    if (delContra) delContra.run(e.id, e.id);
    deleted += 1;
  }
  plan.toEmbed.forEach((d, i) => {
    // A re-embedded chunk changed content; its prior contradiction flags are stale. Drop them —
    // the onIndexed contradiction job re-detects against the new content.
    if (delContra) delContra.run(d.id, d.id);
    const vec = plan.vectors[i] ?? [];
    // Every chunk is STORED — the chunk row lands regardless of the dedup decision. body_sha is
    // passed only when the column exists.
    if (hasBodySha) {
      upChunk.run(
        d.id,
        vaultId,
        plan.path,
        d.index,
        JSON.stringify(d.headings),
        d.content,
        d.contentHash,
        d.bodySha,
        d.tokenCount,
        plan.ts,
        plan.ts,
      );
    } else {
      upChunk.run(
        d.id,
        vaultId,
        plan.path,
        d.index,
        JSON.stringify(d.headings),
        d.content,
        d.contentHash,
        d.tokenCount,
        plan.ts,
        plan.ts,
      );
    }
    // Cross-path dedup (migration 20260719_001): a reused/skipped body was never sent to the
    // provider this run. THE-454: instead of writing NO vector (which left the chunk invisible to
    // dense/sparse/ColBERT retrieval and stranded it when the owner was deleted), COPY the identical
    // body's already-stored vectors from the first walked path — same provider call cost, but every
    // path stays semantically retrievable.
    if (!d.skipEmbed) {
      upEmb.run(d.id, provider.id, provider.dimensions, floatBlob(vec), plan.ts);
      deactivateOld.run(d.id, provider.id); // THE-531: retire any superseded-model row for this chunk
      if (hasVec) upsertVec(db, d.id, vec, { vaultId, path: plan.path, model: provider.id });
    } else {
      copyDedupVectors(
        db,
        {
          targetId: d.id,
          bodySha: d.bodySha,
          contentHash: d.contentHash,
          vaultId,
          path: plan.path,
          model: provider.id,
          ts: plan.ts,
          hasVec,
          hasChunkSparse,
          hasChunkColbert,
        },
        dedupCache,
      );
    }
    // THE-406: BM25 matches on the same text the dense vector embeds (enriched when the flag is
    // on); bm25Chunks JOINs chunks for the raw display content, so search output is unchanged.
    if (hasChunkFts) upsertChunkFtsRow(db, d.id, vaultId, plan.path, d.embedText ?? d.content);
    // THE-395: an empty head (the serving runtime could not produce it) is skipped, not stored —
    // an all-empty chunk_sparse / chunk_colbert would only bloat scans with dead rows.
    const sp = plan.sparse?.[i];
    if (!d.skipEmbed && hasChunkSparse && sp && Object.keys(sp).length > 0)
      upsertChunkSparse(db, d.id, vaultId, sp);
    const cb = plan.colbert?.[i];
    if (!d.skipEmbed && hasChunkColbert && cb && cb.length > 0)
      upsertChunkColbert(db, d.id, vaultId, cb);
  });
  return { upserted: plan.toEmbed.length, deleted };
}

// Notify the index hook of a committed plan's (re)embedded chunks. Call only AFTER the plan's
// transaction has committed, so a consumer never observes an uncommitted (possibly rolled-back)
// chunk.
function fireIndexHook(onIndexed: IndexHook | undefined, plan: NoteWritePlan): void {
  if (!onIndexed) return;
  // Cross-path dedup (migration 20260719_001): a skipEmbed chunk carries no NEW embedding this run,
  // so it is not reported as a (re)embedded chunk.
  const embedded = plan.toEmbed
    .map((d, i) => ({ d, vec: plan.vectors[i] ?? [] }))
    .filter((x) => !x.d.skipEmbed);
  if (embedded.length > 0) {
    onIndexed(
      embedded.map(({ d, vec }) => ({
        id: d.id,
        path: plan.path,
        content: d.content,
        embedding: vec,
      })),
    );
  }
}

// Index a single note atomically: plan (incl. embed, outside the txn), then prune + upsert in one
// transaction. Used by the index-on-write / deindex paths; indexVault batches instead.
export async function indexNote(
  db: Database,
  provider: EmbeddingProvider,
  vaultId: string,
  path: string,
  raw: string,
  hasVec: boolean,
  now: () => number,
  onIndexed?: IndexHook,
  /** THE-406: embeddings.chunkContext — enrich the embedded/BM25 text with title + breadcrumb. */
  enrich = false,
): Promise<{ upserted: number; deleted: number; unchanged: number; secretsSkipped: number }> {
  const { plan, unchanged, secretsSkipped, flagged } = await planNoteWrites(
    db,
    provider,
    vaultId,
    path,
    raw,
    now(),
    enrich,
  );
  // THE-291: the metadata/FTS row rides the same write (skip empty content — a true delete goes
  // through deindexNote; an empty note has nothing to index).
  const hasNotes = hasNotesTable(db);
  const hasFts = hasNotes && ensureNotesFts(db, { now });
  const hasChunkFts = ensureChunkFts(db, { now, enrich });
  const hasEmbedFull = typeof provider.embedFull === "function";
  const hasChunkSparse = hasEmbedFull && ensureChunkSparse(db);
  const hasChunkColbert = hasEmbedFull && ensureChunkColbert(db);
  const hasBodySha = hasBodyShaColumn(db);
  const note: NoteRecord | null =
    hasNotes && raw !== "" ? buildNoteRecord(path, raw, flagged, null, now()) : null;
  if (!plan) {
    // Chunks unchanged; refresh the notes row only when missing/stale (backfill path).
    if (note && noteRowHash(db, vaultId, path) !== note.contentHash) {
      db.exec("BEGIN");
      try {
        upsertNoteRow(db, vaultId, note, hasFts, now());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    return { upserted: 0, deleted: 0, unchanged, secretsSkipped };
  }
  let result: { upserted: number; deleted: number };
  db.exec("BEGIN");
  try {
    result = applyNoteWrites(
      db,
      provider,
      vaultId,
      plan,
      hasVec,
      hasChunkFts,
      hasChunkSparse,
      hasChunkColbert,
      hasBodySha,
      new Map(), // THE-488: single-note path — a fresh (effectively empty) dedup cache
    );
    if (note) upsertNoteRow(db, vaultId, note, hasFts, now());
    // THE-496: this note's chunks/embeddings changed (the plan-null early return above skips a
    // no-op), so bump the vault generation inside the SAME transaction — the query cache must not
    // serve pre-mutation results.
    if (result.upserted > 0 || result.deleted > 0) bumpGeneration(db, vaultId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  fireIndexHook(onIndexed, plan);
  return { ...result, unchanged, secretsSkipped };
}

/**
 * THE-291: drop EVERYTHING indexed for a path — chunks, embeddings, vec rows, and the notes +
 * FTS metadata — in one transaction. The delete/move paths call this instead of the legacy
 * empty-content reindex (which cannot distinguish a deleted note from an empty one for the
 * notes table).
 */
export function deindexNote(
  db: Database,
  vaultId: string,
  path: string,
  hasVec: boolean,
  /** THE-408: embeddings.chunkContext — a divergence-rebuild fired from this path must match the
   *  index's enrichment. */
  enrich = false,
): void {
  const hasNotes = hasNotesTable(db);
  const hasFts = hasNotes && ensureNotesFts(db);
  const hasChunkFts = ensureChunkFts(db, { enrich });
  const hasChunkSparse = tableExists(db, "chunk_sparse");
  const hasChunkColbert = tableExists(db, "chunk_colbert");
  db.exec("BEGIN");
  try {
    // THE-316: static-arity SQL on the deindex write path (also driven once per note in the
    // stale-path sweep) — cache by SQL text so the sweep does not recompile these on every call.
    const rows = cachedPrepare(db, "SELECT id FROM chunks WHERE vault_id = ? AND path = ?").all(
      vaultId,
      path,
    ) as Array<{ id: string }>;
    const delEmb = cachedPrepare(db, "DELETE FROM chunk_embeddings WHERE chunk_id = ?");
    const delChunk = cachedPrepare(db, "DELETE FROM chunks WHERE id = ?");
    const delVec = hasVec ? cachedPrepare(db, "DELETE FROM vec_chunks WHERE chunk_id = ?") : null;
    // #280-followup: drop the deleted note's chunks' contradiction flags (plane table optional).
    const delContra = tableExists(db, "contradictions")
      ? cachedPrepare(db, DELETE_CONTRADICTIONS_SQL)
      : null;
    for (const r of rows) {
      delEmb.run(r.id);
      delChunk.run(r.id);
      if (delVec) delVec.run(r.id);
      if (hasChunkFts) deleteChunkFtsRow(db, r.id);
      if (hasChunkSparse) deleteChunkSparse(db, r.id);
      if (hasChunkColbert) deleteChunkColbert(db, r.id);
      if (delContra) delContra.run(r.id, r.id);
    }
    if (hasNotes) deleteNoteRow(db, vaultId, path, hasFts);
    // THE-496: a removed path drops chunks/edges from the searchable set, so bump the generation in
    // the same transaction when anything was actually deleted.
    if (rows.length > 0) bumpGeneration(db, vaultId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Does vault_edges carry the densification columns (migration 20260713_001: confidence +
 *  source_fingerprint)? A vault_edges provisioned BEFORE that migration — or a bare fixture — has neither,
 *  and the derived-edge upsert would throw and take the whole index pass down with it. No columns means no
 *  derived edge can exist, so there is nothing to reconcile and nothing to prune: skipping is safe. */
/** @internal exported for the memoization test; production callers use it directly. */
export function hasDerivedEdgeColumns(db: Database): boolean {
  const cached = derivedEdgeCache.get(db);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const cols = db.prepare("PRAGMA table_info(vault_edges)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    ok = names.has("confidence") && names.has("source_fingerprint");
  } catch {
    ok = false;
  }
  derivedEdgeCache.set(db, ok);
  return ok;
}

/** Per-note frontmatter tag sets (notes.tags is a JSON array). A note with unparseable tags contributes
 *  none — one bad row never aborts the index pass.
 *  @internal exported for the THE-486 delta-vs-full-recompute regression test; production callers use
 *  it directly. */
export function readNoteTags(db: Database, vaultId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = db.prepare("SELECT path, tags FROM notes WHERE vault_id = ?").all(vaultId) as Array<{
    path: string;
    tags: string | null;
  }>;
  for (const row of rows) {
    try {
      const parsed = row.tags ? (JSON.parse(row.tags) as unknown) : [];
      if (Array.isArray(parsed)) {
        out.set(
          row.path,
          parsed.filter((t): t is string => typeof t === "string"),
        );
      }
    } catch {
      // unparseable tags -> this note contributes none
    }
  }
  return out;
}

export interface IndexVaultArgs {
  db: Database;
  provider: EmbeddingProvider;
  vaultId: string;
  root: string;
  sub?: string;
  isReadable: (rel: string) => boolean;
  now?: () => number;
  onIndexed?: IndexHook;
  /** GH #171/#172: embed-batch tuning; each field falls back to its module default. Callers thread
   *  config.embeddings.{batchSize,concurrency,maxBatchTokens} here so a slow or small local runner
   *  can be tuned without touching code. */
  embed?: { batchSize?: number; concurrency?: number; maxBatchTokens?: number };
  /** THE-406: embeddings.chunkContext — embed + BM25-index each chunk with a note-title +
   *  heading-breadcrumb prefix (display content stays raw). Callers MUST thread the same value on
   *  every index path (boot reconcile, index_vault tool, index-on-write): the chunk content hash
   *  covers the enriched text, so mixed values would re-embed the same chunks back and forth. */
  chunkContext?: boolean;
  /** Graph densification (docs/plans/2026-07-13-graph-densification.md): build derived edges during
   *  index_vault. tagEdges = shared-frontmatter-tag co-occurrence; knnEdges = vec0 kNN neighbors.
   *  Off unless threaded from config.retrieval.densify. Full-state per kind (toggling off prunes). */
  densify?: {
    tagEdges?: boolean;
    knnEdges?: boolean;
    knnK?: number;
    knnMinSim?: number;
    maxTagFanout?: number;
  };
  /** THE-291: fires when the notes/FTS metadata pass has committed (independent of embed
   *  success), so the caller can flip metadata readiness even if the embed pass later fails. */
  onNotesPass?: () => void;
  /** THE-500: bound each write transaction by BOTH note count and accumulated raw bytes, so a batch
   *  of large notes cannot make one oversized transaction. Each falls back to its default
   *  (maxNotes 100, maxBytes 8 MiB). Embedding always runs OUTSIDE the write txn regardless. */
  batch?: { maxNotes?: number; maxBytes?: number };
}

// THE-500 defaults: 100 notes was the prior hardcoded flush size; 8 MiB caps a batch of large notes.
const DEFAULT_BATCH_MAX_NOTES = 100;
const DEFAULT_BATCH_MAX_BYTES = 8 * 1024 * 1024;

export async function indexVault(args: IndexVaultArgs): Promise<IndexStats> {
  const now = args.now ?? Date.now;
  // THE-460: fold the embedding provider/model/dims + the fixed representation constants +
  // whether chunkContext enrichment is on (it changes the embedded text) into one fingerprint,
  // so ANY representation change — not only a dimension change — rebuilds vec_chunks.
  const hasVec = ensureVecChunks(
    args.db,
    {
      provider: args.provider.provider,
      model: args.provider.model,
      dimensions: args.provider.dimensions,
      distanceMetric: VEC_DISTANCE_METRIC,
      enrichmentVersion: args.chunkContext === true ? ENRICHMENT_VERSION : 0,
      chunkerVersion: CHUNKER_VERSION,
      schemaGen: VEC_SCHEMA_GEN,
    },
    { now },
  );
  // THE-291: notes metadata + FTS ride the reconcile. The UNFILTERED walk backs the stale-path
  // sweep (ACL-invisible-but-present files must never be deindexed); the readable subset drives
  // indexing exactly as before.
  const hasNotes = hasNotesTable(args.db);
  const hasFts = hasNotes && ensureNotesFts(args.db, { now });
  const hasChunkFts = ensureChunkFts(args.db, { now, enrich: args.chunkContext === true });
  const hasEmbedFull = typeof args.provider.embedFull === "function";
  const hasChunkSparse = hasEmbedFull && ensureChunkSparse(args.db);
  const hasChunkColbert = hasEmbedFull && ensureChunkColbert(args.db);
  const hasBodySha = hasBodyShaColumn(args.db);
  // THE-486: whether this vault's vault_edges can even carry derived edges at all (pre-migration dbs
  // cannot) — computed ONCE up front (hasDerivedEdgeColumns memoizes per-db anyway) so the tag-delta
  // snapshot below is skipped entirely when densification could never run this pass.
  const derivedColumnsOk = hasDerivedEdgeColumns(args.db);
  const densifyTagsRequested =
    derivedColumnsOk && args.densify?.tagEdges === true && tableExists(args.db, "notes");
  const densifyKnnRequested = derivedColumnsOk && args.densify?.knnEdges === true;
  // THE-486: the tag-cooccurrence DELTA needs the PRE-pass tag state, so this must be read before any
  // note-row write in this pass commits (the walk below flushes notes inline). newNotesTagsWalked is
  // filled by the walk (fresh tags parsed straight from each readable note's raw content, no DB
  // round-trip needed); deletedPaths + changedChunkPaths are filled by the stale-path sweep and the
  // chunk-write flush respectively, further down.
  const oldNotesTagsSnapshot = densifyTagsRequested
    ? readNoteTags(args.db, args.vaultId)
    : new Map<string, string[]>();
  const newNotesTagsWalked = new Map<string, string[]>();
  // THE-486: notes whose chunk embeddings changed this pass (re-embedded, pruned, or the whole note
  // deleted) — the kNN delta's change signal. A note with no plan this pass had no embedding change.
  const changedChunkPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  // Cross-path embedding dedup (migration 20260719_001): ONE registry shared across the whole walk,
  // so an EMBED text produced under the first walked path is reused/skipped everywhere else this pass.
  // Keyed on content_hash (the enriched embed text under THE-406), not the raw body_sha, so distinctly
  // titled notes never share a vector. Purely in-memory — works even when the body_sha column is absent.
  const dedupRegistry = new Map<string, string>();
  // THE-445: seed the registry from embed texts already embedded in a PRIOR run, so content indexed
  // under an UNCHANGED path (never re-walked this pass, hence not registered below) still dedups a new
  // path carrying the same embed text. First path wins (deterministic by path). Gated on hasBodySha,
  // which mirrors when the copy path is active (dedupEnabled). Caveat: if a seeded first path's content
  // CHANGES this same run, a same-embed-text new path defers to a now-stale first path; it self-heals
  // on the next reindex (the new path then becomes the first).
  if (hasBodySha) {
    const seeded = args.db
      .prepare(
        "SELECT content_hash AS contentHash, path FROM chunks WHERE vault_id = ? ORDER BY path, chunk_index",
      )
      .all(args.vaultId) as Array<{ contentHash: string; path: string }>;
    for (const row of seeded) {
      if (!dedupRegistry.has(row.contentHash)) dedupRegistry.set(row.contentHash, row.path);
    }
  }
  const walked = walkVault(args.root, { sub: args.sub, extensions: [".md"] });
  const walkedSet = new Set(walked.map((e) => e.relPath));
  const statByPath = new Map(walked.map((e) => [e.relPath, { mtime: e.mtime, size: e.size }]));
  const notes = walked.map((e) => e.relPath).filter(args.isReadable);
  // THE-501: one bulk load of the vault's chunk state (ids/hashes/active-model), so computeNotePlan
  // plans every note from memory instead of a per-note query. Safe because each note owns its path's
  // chunks exclusively, so a note's slice is unaffected by earlier notes' writes in this pass.
  const preloadedExisting = preloadChunkState(args.db, args.vaultId);
  const stats: IndexStats = {
    notes_seen: notes.length,
    notes_indexed: 0,
    chunks_upserted: 0,
    chunks_deleted: 0,
    chunks_unchanged: 0,
    edges_inserted: 0,
    edges_deleted: 0,
    secrets_skipped: 0,
    vec_enabled: hasVec,
    fts_enabled: hasFts,
    notes_upserted: 0,
    notes_deleted: 0,
    notes_embed_failed: 0,
    chunks_dedup_reused: 0,
    model: args.provider.id,
    dimensions: args.provider.dimensions,
  };
  // Collect each note's links during the index walk so vault_edges is reconciled in one
  // full-state pass — the undirected links_to graph W-RETRIEVAL walks (THE-233 W-INGEST).
  const noteLinks = new Map<string, ExtractedLink[]>();
  // Two-phase batching: PLAN each note (including its embed() network call) with no transaction,
  // then APPLY a batch of plans in ONE transaction. The write lock is never held across a note's
  // embed, and a K-note reconcile pays ~ceil(N/BATCH) fsyncs instead of N. A batch is the atomic
  // unit — a mid-batch failure rolls the whole batch back; that only costs re-work (the reconcile
  // is idempotent, the content-hash skip re-converges next pass), never correctness. Safe because
  // indexVault is the sole writer on this single connection during the reconcile, so a plan's
  // pre-read `existing` snapshot cannot be raced before its apply.
  const BATCH = args.batch?.maxNotes ?? DEFAULT_BATCH_MAX_NOTES;
  const BATCH_MAX_BYTES = args.batch?.maxBytes ?? DEFAULT_BATCH_MAX_BYTES;
  let batch: NoteWritePlan[] = [];
  let batchBytes = 0; // THE-500: accumulated raw note bytes in the pending batch
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const applied = batch;
    batch = [];
    batchBytes = 0;
    // Batch the embed() calls across the whole batch (THE-277) BEFORE opening the write txn, so the
    // reconcile makes ceil(chunks/EMBED_BATCH) requests with a few in flight instead of one serial
    // round-trip per note. The write lock is still never held across a network call.
    const report = await embedPlans(
      args.provider,
      applied,
      args.embed?.batchSize ?? EMBED_BATCH,
      args.embed?.concurrency ?? EMBED_CONCURRENCY,
      args.embed?.maxBatchTokens ?? EMBED_MAX_BATCH_TOKENS,
    );
    if (report.rejections > 0) {
      process.stderr.write(
        `[index] vault "${args.vaultId}": ${report.rejections} embed request(s) exceeded the ` +
          `provider's context (HTTP 400/413) and were bisected + retried. Lower ` +
          `embeddings.maxBatchTokens to avoid the extra round-trips.\n`,
      );
    }
    // THE-390: a chunk the provider rejects even alone quarantines its NOTE — the rest of the
    // batch still applies and the reconcile completes (surfaced via stats + reconcile health;
    // the content-hash skip retries the note next pass). Deliberate consequence: a quarantined
    // note keeps serving its LAST-INDEXED chunks (stale-but-consistent) rather than being pruned
    // to a search hole or failing the whole reindex; its notes/FTS metadata may be newer, which
    // the notes pass already allows by design (THE-291 independence).
    let toApply = applied;
    if (report.failed.length > 0) {
      const failedSet = new Set(report.failed);
      toApply = applied.filter((p) => !failedSet.has(p));
      stats.notes_embed_failed += report.failed.length;
      const sample = report.failed
        .slice(0, 3)
        .map((p) => p.path)
        .join(", ");
      process.stderr.write(
        `[index] vault "${args.vaultId}": embed provider rejected ${report.failed.length} ` +
          `note(s) even at single-text size (${sample}${report.failed.length > 3 ? ", ..." : ""}) ` +
          `— skipped this pass. If this persists, the chunk exceeds the provider's context; ` +
          `use a larger-context embedding model.\n`,
      );
    }
    args.db.exec("BEGIN");
    // THE-488: one dedup-source cache for the WHOLE flush batch — duplicates span notes/paths, so the
    // memo must outlive a single applyNoteWrites call to collapse the repeated JOINs.
    const dedupCache: DedupCache = new Map();
    try {
      for (const plan of toApply) {
        const r = applyNoteWrites(
          args.db,
          args.provider,
          args.vaultId,
          plan,
          hasVec,
          hasChunkFts,
          hasChunkSparse,
          hasChunkColbert,
          hasBodySha,
          dedupCache,
        );
        stats.chunks_upserted += r.upserted;
        stats.chunks_deleted += r.deleted;
        if (r.upserted > 0 || r.deleted > 0) stats.notes_indexed += 1;
      }
      args.db.exec("COMMIT");
    } catch (e) {
      args.db.exec("ROLLBACK");
      throw e;
    }
    // THE-486: a committed plan means this note's chunk embeddings changed this pass (toEmbed
    // non-empty and/or a prune) — computeNotePlan never returns a plan otherwise (see its
    // toEmbed.length === 0 && !willPrune early return). This is the kNN delta's change signal,
    // reusing the SAME plan data fireIndexHook already reports rather than threading a new seam.
    for (const plan of toApply) changedChunkPaths.add(plan.path);
    for (const plan of toApply) fireIndexHook(args.onIndexed, plan);
  };
  // The two-transaction split (notes vs chunks) is a deliberate atomicity gap; it is safe ONLY because
  // the next index_vault self-heals either side (an absent chunk set re-embeds; a missing notes row is
  // rewritten). That invariant is pinned by test/index-selfheal.test.ts — do not break it.
  // THE-291: the notes/FTS pass is flushed INDEPENDENTLY of the chunk/embed pass, so a broken
  // embedding backend cannot block metadata/FTS readiness (they need no embeddings). Notes
  // batches commit inline during the walk; chunk plans still batch through the embed flush.
  let notesBatch: NoteRecord[] = [];
  const flushNotes = (): void => {
    if (!hasNotes || notesBatch.length === 0) return;
    const rows = notesBatch;
    notesBatch = [];
    args.db.exec("BEGIN");
    try {
      for (const rec of rows) upsertNoteRow(args.db, args.vaultId, rec, hasFts, now());
      args.db.exec("COMMIT");
    } catch (e) {
      args.db.exec("ROLLBACK");
      throw e;
    }
    stats.notes_upserted += rows.length;
  };
  for (const rel of notes) {
    const raw = readNote(resolveVaultPath(args.root, rel)).raw;
    noteLinks.set(rel, extractLinks(parseNote(raw).body));
    // THE-486: capture this pass's tags straight from the raw content (no DB round-trip) so the
    // tag-cooccurrence delta can diff against oldNotesTagsSnapshot below — a note's frontmatter tags
    // can change with NO chunk content change, so this must NOT be gated on `plan` existing.
    if (densifyTagsRequested) newNotesTagsWalked.set(rel, noteTags(raw).all);
    const { plan, unchanged, secretsSkipped, flagged, dedupSkipped } = computeNotePlan(
      args.db,
      args.vaultId,
      rel,
      raw,
      now(),
      args.chunkContext === true,
      dedupRegistry,
      hasBodySha, // THE-454: dedup (and thus vector-copy) only when the body_sha column exists
      args.provider.id, // THE-531: re-embed a model-superseded chunk even when content is unchanged
      preloadedExisting, // THE-501: plan from the bulk chunk-state load, no per-note query
    );
    stats.chunks_unchanged += unchanged;
    stats.secrets_skipped += secretsSkipped;
    stats.chunks_dedup_reused += dedupSkipped; // THE-499: aggregate, not per-chunk stderr
    if (hasNotes && raw !== "") {
      const rec = buildNoteRecord(rel, raw, flagged, statByPath.get(rel) ?? null, now());
      if (noteRowHash(args.db, args.vaultId, rel) !== rec.contentHash) {
        notesBatch.push(rec);
        if (notesBatch.length >= BATCH) flushNotes();
      }
    }
    if (plan) {
      batch.push(plan);
      // THE-500: flush on EITHER the note-count or the byte budget, so a run of large notes commits
      // as several bounded transactions rather than one oversized one.
      batchBytes += statByPath.get(rel)?.size ?? raw.length;
      if (batch.length >= BATCH || batchBytes >= BATCH_MAX_BYTES) await flush();
    }
  }
  flushNotes();
  // THE-291: stale-path sweep — ONLY on unscoped runs (a folder-scoped index_vault call must
  // never deindex the rest of the vault), and diffed against the UNFILTERED walk so files an
  // ACL-restricted caller cannot see are not destroyed.
  if (hasNotes && args.sub === undefined) {
    const known = args.db
      .prepare("SELECT path FROM notes WHERE vault_id = ?")
      .all(args.vaultId) as Array<{ path: string }>;
    for (const row of known) {
      if (!walkedSet.has(row.path)) {
        deindexNote(args.db, args.vaultId, row.path, hasVec, args.chunkContext === true);
        stats.notes_deleted += 1;
        // THE-486: a deleted note's chunk embeddings AND its tags are both gone — both delta
        // computations need to know, so its derived edges in both directions get pruned rather than
        // orphaned (a scope that omits it would never delete a stale edge pointing at it).
        deletedPaths.add(row.path);
        changedChunkPaths.add(row.path);
      }
    }
  }
  args.onNotesPass?.();
  await flush();
  // Edge maintenance is full-state (resolving targets needs the whole note universe), so it
  // runs once per indexVault pass, not per-note-write. Skipped gracefully when vault_edges is
  // absent (pre-integration, before W-SCHEMA lands).
  if (tableExists(args.db, "vault_edges")) {
    const edgeStats = reconcileVaultEdges(
      args.db,
      args.vaultId,
      desiredEdges(noteLinks, notes),
      now,
    );
    stats.edges_inserted = edgeStats.inserted;
    stats.edges_deleted = edgeStats.deleted;
    // Densification (docs/plans/2026-07-13-graph-densification.md): derived edges — shared-tag
    // co-occurrence + vec0 kNN neighbors — reconciled on their OWN edge_types, so the literal layer and
    // the LLM layer (semantically_similar_to, built out-of-band by the densify-llm runner) are never
    // touched here.
    //
    // THE-486: a flag OFF still reconciles to an EMPTY desired set via the FULL reconcileDerivedEdges —
    // that is what makes "turn the flag off" actually prune (the layer must not survive invisibly,
    // ready to reappear the moment the flag flips back on). A flag ON reconciles DELTA-only once a
    // baseline exists: only the notes/chunks this pass actually touched (plus, for kNN, their existing
    // edge-neighbors — see knnNeighborScope) are re-scored; edges entirely outside that scope are
    // assumed already correct and are never read or rewritten. The very FIRST on-pass (no rows of this
    // edge_type exist yet — "cold start", which also covers a flag just flipped from off, since off
    // always prunes to zero) has no delta baseline to build on and falls back to the full recompute,
    // exactly matching the old always-full behaviour for that one pass.
    // Guarded on the densification columns: reconciling unconditionally against a vault_edges that
    // predates migration 20260713_001 would throw on the upsert and kill the entire index pass.
    if (derivedColumnsOk) {
      const tagFanout = { maxTagFanout: args.densify?.maxTagFanout ?? 25 };
      if (!densifyTagsRequested) {
        reconcileDerivedEdges(args.db, args.vaultId, [], ["shared_tag"], now);
      } else if (countDerivedEdges(args.db, args.vaultId, "shared_tag") === 0) {
        // Cold start: build the FULL post-pass tag map the same way a from-scratch reconcile would —
        // readNoteTags reads notes AFTER this pass's upserts/deletes have all committed.
        const tagDesired = tagCooccurrenceEdges(readNoteTags(args.db, args.vaultId), tagFanout);
        reconcileDerivedEdges(args.db, args.vaultId, tagDesired, ["shared_tag"], now);
      } else {
        // THE-486 warm delta: the FULL post-pass tag map is the old snapshot overlaid with this pass's
        // walked notes' fresh tags, minus anything deleted — cheaper than re-reading the whole notes
        // table, and exactly what it would read anyway (every untouched note keeps its old value).
        const newNotesTagsFull = new Map(oldNotesTagsSnapshot);
        for (const [path, tags] of newNotesTagsWalked) newNotesTagsFull.set(path, tags);
        for (const path of deletedPaths) newNotesTagsFull.delete(path);
        const tagChangedNotes = notesWithTagChanges(oldNotesTagsSnapshot, newNotesTagsFull, [
          ...newNotesTagsWalked.keys(),
          ...deletedPaths,
        ]);
        // Mirrors the kNN branch below: NO note's tags changed this pass -> skip the call entirely
        // (not even the scope build runs), same "no scan on a true no-op" guarantee as acceptance
        // criterion 1, applied to the tag layer too.
        if (tagChangedNotes.size > 0) {
          const scope = tagCooccurrenceScope(
            oldNotesTagsSnapshot,
            newNotesTagsFull,
            tagChangedNotes,
          );
          const tagDesired = tagCooccurrenceEdgesForNotes(newNotesTagsFull, scope, tagFanout);
          reconcileDerivedEdgesScoped(
            args.db,
            args.vaultId,
            tagDesired,
            ["shared_tag"],
            scope,
            now,
          );
        }
      }

      const knnOpts = { k: args.densify?.knnK ?? 8, minSim: args.densify?.knnMinSim ?? 0 };
      if (!densifyKnnRequested) {
        reconcileDerivedEdges(args.db, args.vaultId, [], ["similar_to"], now);
      } else if (countDerivedEdges(args.db, args.vaultId, "similar_to") === 0) {
        const knnDesired = computeKnnEdges(args.db, args.vaultId, knnOpts);
        reconcileDerivedEdges(args.db, args.vaultId, knnDesired, ["similar_to"], now);
      } else if (changedChunkPaths.size > 0) {
        const scope = knnNeighborScope(args.db, args.vaultId, changedChunkPaths);
        const knnDesired = computeKnnEdgesForPaths(args.db, args.vaultId, scope, knnOpts);
        reconcileDerivedEdgesScoped(args.db, args.vaultId, knnDesired, ["similar_to"], scope, now);
      }
      // else: densifyKnnRequested but changedChunkPaths is empty — nothing this pass could have
      // invalidated any similar_to edge, so THE-486 acceptance criterion 1 applies: skip the call
      // entirely (not even a scope lookup runs) rather than paying any kNN scan on a warm no-op pass.
    }
  }
  // THE-496: bump the vault generation once per reconcile when anything result-affecting changed —
  // chunk upserts/deletes OR edge/densification changes. The bump is its own tiny transaction after
  // the flushes have committed; the idempotent reconcile re-bumps if a crash lands between the last
  // flush and here, and over-bumping is only a cache miss.
  const changed =
    stats.chunks_upserted > 0 ||
    stats.chunks_deleted > 0 ||
    stats.edges_inserted > 0 ||
    stats.edges_deleted > 0;
  if (changed) {
    args.db.exec("BEGIN");
    try {
      bumpGeneration(args.db, args.vaultId);
      args.db.exec("COMMIT");
    } catch (e) {
      args.db.exec("ROLLBACK");
      throw e;
    }
  }
  // THE-499: one aggregate dedup line per pass (was ~1 stderr line per duplicate chunk). Individual
  // paths are available behind OBSIDIAN_TC_DEBUG_DEDUP (emitted inline in computeNotePlan).
  if (stats.chunks_dedup_reused > 0) {
    process.stderr.write(
      `[index] vault "${args.vaultId}": dedup reused ${stats.chunks_dedup_reused} chunk embedding(s) from identical-body siblings (copied, not recomputed)\n`,
    );
  }
  return stats;
}
