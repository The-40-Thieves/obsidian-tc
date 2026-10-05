// THE-440 — load GPU-computed nomic vectors (raw little-endian float32, N*768, chunk-id order) into
// a working index's chunk_embeddings, then drop vec_chunks so eval/run.ts scores them via the
// brute-force cosine path. The .f32 layout IS the chunk_embeddings blob layout, so each 3072-byte
// slice writes in directly. Pair with --query-vecs on run.ts (queries embedded by the same nomic).
//
// Usage: bun eval/load-gpu-vecs.ts <config.json> <ids.json> <vecs.f32>
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config/load";
import { openConfiguredDatabase } from "../src/db/open";
import { resolveEmbeddings } from "../src/providers/registry";
import { loadVec } from "../src/search/vec";

const [configPath, idsPath, vecsPath] = process.argv.slice(2);
if (!configPath || !idsPath || !vecsPath) {
  process.stderr.write("usage: bun eval/load-gpu-vecs.ts <config.json> <ids.json> <vecs.f32>\n");
  process.exit(2);
}

async function main(): Promise<void> {
  const config = loadConfig(configPath as string);
  const dim = config.embeddings.dimensions;
  const bytesPer = dim * 4;
  // provider.id, taken FROM THE PROVIDER. It is NOT `${provider}:${model}`: the "local" embedder
  // folds quantization and revision in too (`local:nomic-embed-text-v1.5:fp32`), so the old concat
  // silently addressed a model string nothing had ever written and updated zero rows. It happened
  // to be right for `ollama:`, the only provider this was ever run against.
  const model = resolveEmbeddings(config.embeddings, { cacheDir: config.cacheDir }).provider.id;
  const ids = JSON.parse(readFileSync(idsPath as string, "utf8")) as string[];
  const buf = readFileSync(vecsPath as string);
  if (buf.length !== ids.length * bytesPer) {
    throw new Error(
      `size mismatch: ${buf.length} bytes vs ${ids.length} ids * ${bytesPer} = ${ids.length * bytesPer}`,
    );
  }
  const db = await openConfiguredDatabase(config, "cache.db");
  // UPDATE-only by default (unchanged). `--insert` upserts, which is what a provider CHANGE needs:
  // the PK is (chunk_id, model), so vectors for a model id nothing has written yet have no row to
  // update. The FK on chunks(id) still refuses an id that is not a real chunk.
  const INSERT = process.argv.includes("--insert");
  const upd = INSERT
    ? db.prepare(
        "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) " +
          "VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(chunk_id, model) DO UPDATE SET " +
          "embedding = excluded.embedding, generated_at = excluded.generated_at, is_active = 1",
      )
    : db.prepare(
        "UPDATE chunk_embeddings SET embedding = ?, generated_at = ? WHERE chunk_id = ? AND model = ?",
      );
  const now = 1_700_000_000_000; // fixed (Date.now avoided for reproducibility); value is cosmetic
  let n = 0;
  db.exec("BEGIN");
  try {
    for (let i = 0; i < ids.length; i++) {
      const slice = buf.subarray(i * bytesPer, (i + 1) * bytesPer);
      const r = INSERT
        ? upd.run(ids[i], model, dim, Buffer.from(slice), now)
        : upd.run(Buffer.from(slice), now, ids[i], model);
      n += (r as { changes?: number }).changes ?? 0;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  if (n === 0) {
    throw new Error(
      `wrote 0 rows for model "${model}" — nothing in chunk_embeddings carries that id. ` +
        "Pass --insert if this is a provider change (no rows exist yet), or check that the config's " +
        "embeddings block is the one the existing vectors were written under.",
    );
  }
  loadVec(db);
  db.exec("DROP TABLE IF EXISTS vec_chunks");
  process.stdout.write(`loaded ${ids.length} vecs (${n} rows updated), dropped vec_chunks\n`);
  db.close?.();
}

void main();
