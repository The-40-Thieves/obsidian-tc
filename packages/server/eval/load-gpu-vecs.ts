// THE-440 — load GPU-computed vectors (raw little-endian float32, N*dim, chunk-id order) into a
// working index's chunk_embeddings, then mark vec_chunks stale so the next index pass rebuilds it
// from them in full. The .f32 layout IS the chunk_embeddings blob layout, so each slice writes in
// directly. Pair with --query-vecs on run.ts (queries embedded by the same model).
//
// The model id written under is the PROVIDER's id (gpu-embed-lib.ts's gpuVecsModelId), not a
// provider:model concat. UPDATE-only by default; `--insert` upserts, for a provider change that has
// no rows yet. Writing zero rows is an error.
//
// Usage: bun eval/load-gpu-vecs.ts <config.json> <ids.json> <vecs.f32> [--insert]
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config/load";
import { openConfiguredDatabase } from "../src/db/open";
import { invalidateVecIndex } from "../src/search/vec";
import { gpuVecsModelId, loadGpuVecs } from "./gpu-embed-lib";

const [configPath, idsPath, vecsPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!configPath || !idsPath || !vecsPath) {
  process.stderr.write(
    "usage: bun eval/load-gpu-vecs.ts <config.json> <ids.json> <vecs.f32> [--insert]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const config = loadConfig(configPath as string);
  const model = gpuVecsModelId(config.embeddings, config.cacheDir);
  const ids = JSON.parse(readFileSync(idsPath as string, "utf8")) as string[];
  const vecs = readFileSync(vecsPath as string);
  const db = await openConfiguredDatabase(config, "cache.db");
  const written = loadGpuVecs(db, {
    model,
    dim: config.embeddings.dimensions,
    ids,
    vecs,
    insert: process.argv.includes("--insert"),
  });
  invalidateVecIndex(db);
  process.stdout.write(
    `loaded ${ids.length} vecs under "${model}" (${written} rows written), vec_chunks invalidated — ` +
      "run `obsidian-tc index` to rebuild the dense index\n",
  );
  db.close?.();
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
