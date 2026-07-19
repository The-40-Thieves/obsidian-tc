// THE-440 — load GPU-computed nomic vectors (raw little-endian float32, N*768, chunk-id order) into
// a working index's chunk_embeddings, then drop vec_chunks so eval/run.ts scores them via the
// brute-force cosine path. The .f32 layout IS the chunk_embeddings blob layout, so each 3072-byte
// slice writes in directly. Pair with --query-vecs on run.ts (queries embedded by the same nomic).
//
// Usage: bun eval/load-gpu-vecs.ts <config.json> <ids.json> <vecs.f32>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/load";
import { openDatabase } from "../src/db/open";
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
  const model = `${config.embeddings.provider}:${config.embeddings.model}`;
  const ids = JSON.parse(readFileSync(idsPath as string, "utf8")) as string[];
  const buf = readFileSync(vecsPath as string);
  if (buf.length !== ids.length * bytesPer) {
    throw new Error(
      `size mismatch: ${buf.length} bytes vs ${ids.length} ids * ${bytesPer} = ${ids.length * bytesPer}`,
    );
  }
  const db = await openDatabase(join(config.cacheDir, "cache.db"));
  const upd = db.prepare(
    "UPDATE chunk_embeddings SET embedding = ?, generated_at = ? WHERE chunk_id = ? AND model = ?",
  );
  const now = 1_700_000_000_000; // fixed (Date.now avoided for reproducibility); value is cosmetic
  let n = 0;
  db.exec("BEGIN");
  try {
    for (let i = 0; i < ids.length; i++) {
      const slice = buf.subarray(i * bytesPer, (i + 1) * bytesPer);
      const r = upd.run(Buffer.from(slice), now, ids[i], model);
      n += (r as { changes?: number }).changes ?? 0;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  loadVec(db as never);
  db.exec("DROP TABLE IF EXISTS vec_chunks");
  process.stdout.write(`loaded ${ids.length} vecs (${n} rows updated), dropped vec_chunks\n`);
  db.close?.();
}

void main();
