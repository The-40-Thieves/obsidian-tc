// The testable core of the off-box (GPU) embedding workflow: export-chunk-texts.ts writes every
// chunk's embed-text, eval/modal_embed_nomic.py embeds it, load-gpu-vecs.ts writes the vectors back.
// The two CLIs are thin argv wrappers over this file so the rules below are pinned by
// test/eval-gpu-embed.test.ts instead of by a run against a real vault.
import type { Database } from "../src/db/types";
import { type EgressFilter, isExcludedPath } from "../src/plane/egress-filter";
import { resolveEmbeddings } from "../src/providers/registry";
import type { EmbeddingsConfigLike } from "../src/providers/types";
import { enrichChunkText } from "../src/search/chunk";

export interface ExportedChunkTexts {
  /** Chunk ids in the order the `.f32` rows must come back in. */
  ids: string[];
  /** One `{"chunk_id","text"}` JSON line per id, same order. */
  lines: string[];
  /** Chunks withheld because their path is egress-excluded. */
  excluded: number;
}

/** Every chunk's embed-text for the given vaults, in one stable order (vault, path, chunk_index).
 *  The text is the SHIPPED representation: enrichChunkText when `chunkContext` is on, bare content
 *  when it is off. The query side is enriched either way, so exporting the wrong one produces
 *  vectors that look fine and retrieve badly. Egress-excluded paths never leave the machine, the
 *  same rule `obsidian-tc index` applies before embedding. */
export function exportChunkTexts(
  db: Database,
  vaultIds: readonly string[],
  opts: { chunkContext: boolean; egress: EgressFilter },
): ExportedChunkTexts {
  const ids: string[] = [];
  const lines: string[] = [];
  let excluded = 0;
  const select = db.prepare(
    "SELECT id, path, headings, content FROM chunks WHERE vault_id = ? ORDER BY path, chunk_index",
  );
  for (const vaultId of vaultIds) {
    const rows = select.all(vaultId) as Array<{
      id: string;
      path: string;
      headings: string;
      content: string;
    }>;
    for (const r of rows) {
      if (isExcludedPath(opts.egress, r.path)) {
        excluded++;
        continue;
      }
      let headings: string[] = [];
      try {
        headings = JSON.parse(r.headings) as string[];
      } catch {
        headings = []; // unparseable headings: title-only is the right enrichment
      }
      const text = opts.chunkContext ? enrichChunkText(r.path, headings, r.content) : r.content;
      ids.push(r.id);
      lines.push(JSON.stringify({ chunk_id: r.id, text }));
    }
  }
  return { ids, lines, excluded };
}

/** The `chunk_embeddings.model` value to address: `provider.id`, asked of the provider. It is NOT
 *  `${provider}:${model}` — the local embedder folds quantization and revision in
 *  (`local:nomic-embed-text-v1.5:fp32`). */
export function gpuVecsModelId(embeddings: EmbeddingsConfigLike, cacheDir?: string): string {
  return resolveEmbeddings(embeddings, { cacheDir }).provider.id;
}

export interface LoadGpuVecsOptions {
  /** `chunk_embeddings.model` to write under — see gpuVecsModelId. */
  model: string;
  dim: number;
  /** Chunk ids; row i of `vecs` belongs to ids[i] (the positional contract with the embedder). */
  ids: readonly string[];
  /** Raw little-endian float32, ids.length * dim, row-major. */
  vecs: Uint8Array;
  /** Upsert (a provider change has no row to UPDATE) instead of UPDATE-only. */
  insert: boolean;
  /** Cosmetic `generated_at`; fixed by default so a load is reproducible. */
  now?: number;
}

/** Write the vectors into chunk_embeddings and return the number of rows written. Throws, with
 *  nothing committed, on a size mismatch or when zero rows were written: a model id nothing carries
 *  makes the UPDATE a silent no-op that would otherwise report success.
 *
 *  `idx_chunk_embeddings_active` is UNIQUE per chunk, so `insert` retires the chunk's other-model
 *  rows BEFORE activating this one. */
export function loadGpuVecs(db: Database, opts: LoadGpuVecsOptions): number {
  const bytesPer = opts.dim * 4;
  if (opts.vecs.length !== opts.ids.length * bytesPer) {
    throw new Error(
      `size mismatch: ${opts.vecs.length} bytes vs ${opts.ids.length} ids * ${bytesPer} = ${opts.ids.length * bytesPer}`,
    );
  }
  const now = opts.now ?? 1_700_000_000_000;
  const write = opts.insert
    ? db.prepare(
        "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) " +
          "VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(chunk_id, model) DO UPDATE SET " +
          "embedding = excluded.embedding, generated_at = excluded.generated_at, is_active = 1",
      )
    : db.prepare(
        "UPDATE chunk_embeddings SET embedding = ?, generated_at = ? WHERE chunk_id = ? AND model = ?",
      );
  const retire = db.prepare(
    "UPDATE chunk_embeddings SET is_active = 0 WHERE chunk_id = ? AND model != ? AND is_active = 1",
  );
  let written = 0;
  db.exec("BEGIN");
  try {
    for (let i = 0; i < opts.ids.length; i++) {
      const id = opts.ids[i] as string;
      const blob = Buffer.from(opts.vecs.subarray(i * bytesPer, (i + 1) * bytesPer));
      if (opts.insert) retire.run(id, opts.model);
      const r = opts.insert
        ? write.run(id, opts.model, opts.dim, blob, now)
        : write.run(blob, now, id, opts.model);
      written += r.changes ?? 0;
    }
    if (written === 0) {
      throw new Error(
        `wrote 0 rows for model "${opts.model}" — nothing in chunk_embeddings carries that id. ` +
          "Pass --insert if this is a provider change (no rows exist yet), or check that the config's " +
          "embeddings block is the one the existing vectors were written under.",
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return written;
}
