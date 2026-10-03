// WP3 slice 1 (docs/plans/2026-07-30-codebase-refactor-map.md): the external-provider phase,
// moved verbatim out of indexer.ts. This file performs embedding PROVIDER CALLS ONLY — no DB
// reads, no DB writes, no transaction. It depends on note-plan.ts (for estimateEmbedTokens) and
// types.ts; indexer.ts (persistence + orchestration) depends on this file, never the reverse.
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import type { EmbeddingProvider } from "../../embeddings";
import type { ColbertMatrix } from "../colbert";
import type { SparseVec } from "../sparse";
import { estimateEmbedTokens } from "./note-plan";
import type { EmbedReport, NoteWritePlan } from "./types";

// Provider-sized embed sub-batch + how many to run in flight (THE-277) — the defaults used when a
// caller passes no embed config. GH #171/#172: a request is ALSO capped by estimated tokens
// (EMBED_MAX_BATCH_TOKENS), so a token-dense sub-batch can't overrun a stock local runner's budget
// and crash it regardless of the input count. THE-390: the token cap must stay UNDER the provider's
// loaded context — Ollama defaults to n_ctx 4096 and 400-rejects a request whose SUMMED tokens
// exceed it, and estimateTokens undercounts real tokenization (~2-2.5x on link-dense markdown).
// 2048 estimated keeps a batch inside a 4096 context with that drift; must match the
// EmbeddingsConfigSchema default.
export const EMBED_BATCH = 512;
export const EMBED_CONCURRENCY = 4;
export const EMBED_MAX_BATCH_TOKENS = 2048;

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
  /** THE-934 fix round 1: parallel to `batch` -- the vault path each text was drawn from. Every
   *  text here already passed note-plan.ts's exclusion filter (embedPlans below never pushes an
   *  excludedFromEmbed/skipEmbed chunk's text), so declaring these is always safe -- it is the
   *  embedding PORT guard's (embeddings/index.ts) OWN backstop check, not a second filter. */
  sourcePaths: string[],
  useFull: boolean,
  counters: { rejections: number },
): Promise<SubBatchOut> {
  try {
    if (useFull && provider.embedFull) {
      const full = await provider.embedFull(batch, { input: "document", sourcePaths });
      return {
        dense: full.map((f) => f.dense),
        sparse: full.map((f) => f.sparse),
        colbert: full.map((f) => f.colbert),
      };
    }
    return { dense: await provider.embed(batch, { input: "document", sourcePaths }) };
  } catch (e) {
    if (!isEmbedRejection(e)) throw e;
    counters.rejections += 1;
    if (batch.length === 1) {
      return useFull ? { dense: [null], sparse: [null], colbert: [null] } : { dense: [null] };
    }
    const mid = Math.ceil(batch.length / 2);
    const left = await embedSubBatch(
      provider,
      batch.slice(0, mid),
      sourcePaths.slice(0, mid),
      useFull,
      counters,
    );
    const right = await embedSubBatch(
      provider,
      batch.slice(mid),
      sourcePaths.slice(mid),
      useFull,
      counters,
    );
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
  /** GH #995: checked (and yielded to) between provider calls below — see the worker loop's own
   *  comment for why this is the seam a shutdown needs, not a higher one. Absent -> unabortable,
   *  matching every call site before this ticket (only the boot reconcile passes one). */
  signal?: AbortSignal,
  /** GH #995 follow-up: awaited before each sub-batch's provider call, when set. Only threaded by
   *  the boot/promotion reconcile (runtime/plane-wiring.ts's createReconcileRunner) — explicit
   *  index_vault and index-on-write never pass one, so they stay unpaced (absent -> no wait,
   *  byte-identical to before this ticket). See search/indexing/embed-pace.ts's `waitForIdle`. */
  pace?: (signal?: AbortSignal) => Promise<void>,
): Promise<EmbedReport> {
  const contents: string[] = [];
  // THE-934: parallel to `contents` — the vault path each text came from, one entry per pushed
  // text (a plan's toEmbed chunks all share `p.path`).
  const contentPaths: string[] = [];
  // THE-406: embed the enriched text when present; c.content remains the stored display text.
  // Cross-path dedup (migration 20260719_001): a skipEmbed chunk's identical body is already embedded
  // at another path, so it is NOT sent to the provider — its vector slot is filled below.
  for (const p of plans)
    for (const c of p.toEmbed) {
      // THE-934: skipEmbed (dedup reuse) and excludedFromEmbed (egress.excludePaths) both mean
      // "never send this to the provider" — the chokepoint for index-time embedding.
      if (c.skipEmbed || c.excludedFromEmbed) continue;
      contents.push(c.embedText ?? c.content);
      contentPaths.push(p.path);
    }
  if (contents.length === 0) return { failed: [], rejections: 0 };
  // Pack sub-batches greedily under BOTH caps: at most `batchSize` inputs and at most
  // `maxBatchTokens` estimated tokens per request (GH #172 — a fixed 512-input batch packed ~87k
  // tokens into one call and crashed a stock local runner). A single text that alone exceeds the
  // token cap still goes in its own batch: never split, never dropped.
  const subBatches: string[][] = [];
  const subBatchPaths: string[][] = [];
  let cur: string[] = [];
  let curPaths: string[] = [];
  let curTokens = 0;
  for (const [i, text] of contents.entries()) {
    const t = estimateEmbedTokens(text);
    if (cur.length > 0 && (cur.length >= batchSize || curTokens + t > maxBatchTokens)) {
      subBatches.push(cur);
      subBatchPaths.push(curPaths);
      cur = [];
      curPaths = [];
      curTokens = 0;
    }
    cur.push(text);
    curPaths.push(contentPaths[i] as string);
    curTokens += t;
  }
  if (cur.length > 0) {
    subBatches.push(cur);
    subBatchPaths.push(curPaths);
  }
  // THE-388: when the provider emits embedFull() (bge-m3), collect the sparse + ColBERT heads per
  // sub-batch alongside the dense vector; dense-only providers take the embed() path unchanged.
  const hasFull = typeof provider.embedFull === "function";
  const counters = { rejections: 0 };
  const results: SubBatchOut[] = new Array(subBatches.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < subBatches.length; i = next++) {
      if (signal?.aborted) return;
      // GH #995 follow-up: pace BEFORE issuing this sub-batch's provider call, not after — the
      // point is to never START the next batch while a tool call is in flight, not to interrupt
      // one already running (embedSubBatch itself is not abortable mid-call).
      if (pace) {
        await pace(signal);
        if (signal?.aborted) return;
      }
      results[i] = await embedSubBatch(
        provider,
        subBatches[i] as string[],
        subBatchPaths[i] as string[],
        hasFull,
        counters,
      );
      // GH #995: a real embed call here (the in-process ONNX/native path, in particular) can run
      // for its whole duration as SYNCHRONOUS JS-thread work that resolves via a microtask chain
      // with no macrotask in between — `await`ing it alone does not hand control back to libuv,
      // so a SIGTERM queued during the call is not even DELIVERED to the process's signal handler
      // until every sub-batch across the whole reconcile has run (reproduced in
      // test/shutdown-boot-embed.test.ts). `setImmediate` forces a real event-loop turn between
      // sub-batches, bounding that delivery latency to one sub-batch's duration, and the abort
      // check right after it lets a shutdown already in progress stop issuing further provider
      // calls instead of running the rest of this batch to completion.
      //
      // Gated on `signal` being present: with no signal there is nothing to abort or deliver, and
      // unconditionally forcing a macrotask turn here changed observable timing for every
      // unsignaled caller (every call site except the boot reconcile) — a real regression caught
      // by index-vault-in-flight.test.ts's `pollUntil`, which polls purely across microtask ticks
      // (a real event-loop turn never resolves within its own bound). Absent -> byte-identical to
      // before this ticket, matching every other `signal` check in this file.
      if (signal) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal.aborted) return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, subBatches.length) }, () => worker()),
  );
  // Aborted mid-flight: `results` may have holes (a worker returned before filling its slot).
  // Quiet no-op, matching every other `signal.aborted` check in this codebase (e.g.
  // plane-wiring.ts's createReconcileRunner) — the caller (index-vault.ts's flush()) re-checks the
  // signal itself and drops the whole batch rather than writing a partial embed result; the next
  // reconcile re-plans and re-embeds these same notes from scratch.
  if (signal?.aborted) return { failed: [], rejections: counters.rejections };
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
      if (c.skipEmbed || c.excludedFromEmbed) {
        dense.push([]);
        if (flatSparse) sparse.push({});
        if (flatColbert) colbert.push([]);
        continue;
      }
      const v = flatDense[off];
      // A quarantined chunk (provider rejected it even alone) fails its whole NOTE: its vectors are
      // not applied and the caller must exclude the plan (THE-390).
      if (v === null || v === undefined) quarantined = true;
      dense.push(v ?? []);
      if (flatSparse) sparse.push(flatSparse[off] ?? {});
      if (flatColbert) colbert.push(flatColbert[off] ?? []);
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
