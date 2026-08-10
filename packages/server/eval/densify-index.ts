// THE-532: rebuild the kNN derived-edge set on an existing eval index at a given (k, floor).
//
// knnK and knnMinSim are INDEX-time parameters — they decide which `similar_to` edges exist, so a
// sweep over them cannot be done from the search side. This script is the index-side half; the
// search-side half (derivedWeight) is an env var on eval/run.ts.
//
// WHY IT CALLS THE DENSIFICATION FUNCTIONS DIRECTLY RATHER THAN indexVault.
//
// The first version routed through indexVault with `densify: {...}`, which is how production does
// it. That took 48+ MINUTES per cell and was the single reason this sweep looked infeasible.
// Measured, the KNN is not the cost: one vecKnn on this 12,386-chunk index runs a median 10.2 ms,
// so the whole pass should be ~2.1 minutes. The other ~46 were indexVault doing its full
// reconcile — walking every note, hashing it, re-embedding drift, writing transactions — none of
// which a sweep over edge parameters needs, because the chunks and their vectors do not change
// between cells.
//
// computeKnnEdges + reconcileDerivedEdges are exactly what indexVault calls internally for this
// pass, so going direct runs the same code on the same inputs, minus the reindex.
//
// `--settle` keeps the old behaviour for the ONE place it is genuinely needed: absorbing vault
// drift once, before the control arm, so every cell measures the same corpus.
//
// It DELETES the existing similar_to edges before rebuilding, deliberately: with edges already
// present, a reconcile would diff against the previous cell's set rather than build this cell's,
// silently measuring the wrong configuration.
//
// usage:
//   bun eval/densify-index.ts <config.json> --k 8 --floor 0.0
//   bun eval/densify-index.ts <config.json> --settle          # one-time drift absorb
import { join } from "node:path";
import { loadConfig } from "../src/config/load";
import { openDatabase } from "../src/db/open";
import { createEmbeddingProvider } from "../src/embeddings";
import { computeKnnEdges, reconcileDerivedEdges } from "../src/search/derived-edges";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const configPath = process.argv[2];
if (!configPath || configPath.startsWith("--")) {
  process.stderr.write(
    "usage: bun eval/densify-index.ts <config.json> [--k <n> --floor <f> | --settle]\n",
  );
  process.exit(2);
}
const settleOnly = process.argv.includes("--settle");
const k = Number(arg("k") ?? 8);
const floor = Number(arg("floor") ?? 0);
if (!settleOnly) {
  if (!Number.isInteger(k) || k < 1) throw new Error(`--k must be a positive integer, got ${k}`);
  if (!Number.isFinite(floor) || floor < 0 || floor > 1)
    throw new Error(`--floor must be in [0,1], got ${floor}`);
}

const config = loadConfig(configPath);
const vault = config.vaults[0];
if (!vault) throw new Error("config.vaults is empty");
const db = await openDatabase(join(config.cacheDir, "cache.db"));
const chunks = (db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;

if (settleOnly) {
  // The expensive path, run ONCE: a full reconcile so the corpus stops moving under the sweep.
  const t0 = performance.now();
  // THE-460 fix B: createEmbeddingProvider suffixes provider.id with `@<revision>` when
  // config.embeddings.revision is set, so the fingerprint MUST fold the same value in — otherwise
  // this harness and the server compute different fingerprints against the same cache.db and each
  // DROPs and rebuilds what the other just built.
  //
  // THE-683 replaced the loose `revision` argument with a built manifest, and this call was left
  // passing the old field for nine days: `eval/` was outside tsconfig.json's `include`, so no gate
  // could see that `revision` no longer existed and that the now-REQUIRED `representation` was
  // absent. Built here the same way `runtime/indexing-wiring.ts` and `eval/perf/harness.ts` build
  // it, so all three derive one identity rather than three that must be kept in step.
  const settleProvider = createEmbeddingProvider(config.embeddings);
  await indexVault({
    db,
    provider: settleProvider,
    representation: buildRepresentationManifest(settleProvider, config.embeddings),
    vaultId: vault.id,
    root: vault.path,
    isReadable: () => true,
  });
  const after = (db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
  process.stdout.write(
    `${JSON.stringify({ mode: "settle", chunks_before: chunks, chunks_after: after, ms: Math.round(performance.now() - t0) })}\n`,
  );
  db.close?.();
  process.exit(0);
}

const before = db
  .prepare("SELECT count(*) AS n FROM vault_edges WHERE vault_id = ? AND edge_type = 'similar_to'")
  .get(vault.id) as { n: number };
db.prepare("DELETE FROM vault_edges WHERE vault_id = ? AND edge_type = 'similar_to'").run(vault.id);
process.stderr.write(`cleared ${before.n} existing similar_to edge(s)\n`);

const t0 = performance.now();
const desired = computeKnnEdges(db, vault.id, { k, minSim: floor });
const stats = reconcileDerivedEdges(db, vault.id, desired, ["similar_to"]);
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
  `${JSON.stringify({ k, floor, edges: after.n, densify_ms: Math.round(ms), inserted: stats.inserted, deleted: stats.deleted, chunks })}\n`,
);
db.close?.();
