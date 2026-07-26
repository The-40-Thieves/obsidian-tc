// THE-532: rebuild the kNN derived-edge set on an existing eval index at a given (k, floor).
//
// knnK and knnMinSim are INDEX-time parameters — they decide which `similar_to` edges exist, so a
// sweep over them cannot be done from the search side. This script is the index-side half; the
// search-side half (derivedWeight) is an env var on eval/run.ts.
//
// It DELETES the existing similar_to edges first, deliberately. indexVault only runs the full
// kNN pass when the vault has none (`countDerivedEdges(...) === 0`); with edges already present
// and no content change it takes the incremental branch and would leave the previous cell's edge
// set in place, silently measuring the wrong configuration. Deleting is what makes each cell a
// clean rebuild rather than a mutation of its predecessor.
//
// usage:
//   bun eval/densify-index.ts <config.json> --k 8 --floor 0.0
import { join } from "node:path";
import { loadConfig } from "../src/config/load";
import { openDatabase } from "../src/db/open";
import { createEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const configPath = process.argv[2];
if (!configPath || configPath.startsWith("--")) {
  process.stderr.write("usage: bun eval/densify-index.ts <config.json> --k <n> --floor <f>\n");
  process.exit(2);
}
const k = Number(arg("k") ?? 8);
const floor = Number(arg("floor") ?? 0);
if (!Number.isInteger(k) || k < 1) throw new Error(`--k must be a positive integer, got ${k}`);
if (!Number.isFinite(floor) || floor < 0 || floor > 1)
  throw new Error(`--floor must be in [0,1], got ${floor}`);

const config = loadConfig(configPath);
const vault = config.vaults[0];
if (!vault) throw new Error("config.vaults is empty");
const db = await openDatabase(join(config.cacheDir, "cache.db"));

const before = db
  .prepare("SELECT count(*) AS n FROM vault_edges WHERE vault_id = ? AND edge_type = 'similar_to'")
  .get(vault.id) as { n: number };
db.prepare("DELETE FROM vault_edges WHERE vault_id = ? AND edge_type = 'similar_to'").run(vault.id);
process.stderr.write(`cleared ${before.n} existing similar_to edge(s)\n`);

const t0 = performance.now();
const stats = await indexVault({
  db,
  provider: createEmbeddingProvider(config.embeddings),
  vaultId: vault.id,
  root: vault.path,
  isReadable: () => true,
  densify: { knnEdges: true, knnK: k, knnMinSim: floor },
});
const ms = performance.now() - t0;

const after = db
  .prepare("SELECT count(*) AS n FROM vault_edges WHERE vault_id = ? AND edge_type = 'similar_to'")
  .get(vault.id) as { n: number };

// A cell that built no edges would make the eval below it a silent no-op reporting "densification
// made no difference" — the measures-nothing-while-green shape. Fail instead.
if (after.n === 0)
  throw new Error(
    `densify(k=${k}, floor=${floor}) produced ZERO similar_to edges — the eval below this would report a no-op as a null result`,
  );

process.stdout.write(
  `${JSON.stringify({ k, floor, edges: after.n, densify_ms: Math.round(ms), chunks_upserted: stats.chunks_upserted })}\n`,
);
db.close?.();
