// THE-447 measurement harness — seed a synthetic activation signal over the golden corpus so the
// bubble-safe activation composition (dark behind activationRerank + bubbleSafe) can be A/B'd on the
// eval, which otherwise has NO retrieval history (and must never log — THE-187 hygiene).
//
// Mode ORACLE (default): give every EXPECTED chunk (chunks of a query's seed/target/bridge notes)
// recent, positively-cited retrieval events -> high cached_activation_score. This is the CEILING:
// a PERFECT activation signal that knows the relevant chunks. Because bubble-safe moves each item by
// AT MOST one position, the oracle bounds the mechanism's best case — if even a perfect signal barely
// moves nDCG, THE-447 is inherently capped and stays off. Real prod activation (frequency/recency +
// citation feedback) would be noisier, so the true effect is <= this.
//
// Writes experiential.db INTO the config's cacheDir so `eval/run.ts --activation` reads it. Then:
//   bun eval/run.ts <cfg> <golden> --json off.json
//   bun eval/run.ts <cfg> <golden> --activation --bubble-safe --json on.json
//   bun eval/compare.ts off.json on.json
//
// Usage: bun eval/seed-activation.ts <config.json> <golden.yaml> [--events N] [--decay D]
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config/load";
import { provisionExperientialDb } from "../src/db/experiential";
import { openDatabase } from "../src/db/open";
import { recomputeActivation } from "../src/experiential/activation";
import { GoldenSetSchema } from "./metrics";

const mig = (f: string) => ({
  version: f.slice(0, 12),
  sql: readFileSync(fileURLToPath(new URL(`../src/migrations/${f}.sql`, import.meta.url)), "utf8"),
});
const EXPERIENTIAL_MIGRATIONS = [
  mig("20260626_001_experiential_init"),
  mig("20260711_001_experiential_outcome"),
  mig("20260711_002_agent_episodes"),
  mig("20260712_001_preference_profile"),
  mig("20260712_002_access_views"),
  mig("20260712_003_forget_log"),
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [configPath, goldenPath] = argv.filter((a) => !a.startsWith("--"));
  const events = argv.includes("--events") ? Number(argv[argv.indexOf("--events") + 1]) : 3;
  const decay = argv.includes("--decay") ? Number(argv[argv.indexOf("--decay") + 1]) : undefined;
  if (!configPath || !goldenPath) {
    process.stderr.write(
      "usage: bun eval/seed-activation.ts <config.json> <golden.yaml> [--events N] [--decay D]\n",
    );
    process.exit(2);
  }
  const config = loadConfig(configPath);
  const vaultId = config.vaults[0]?.id ?? "main";
  const norm = (p: string): string => p.replace(/\\/g, "/");

  // Map every expected golden path -> its chunk ids (from the champion index).
  const cache = await openDatabase(join(config.cacheDir, "cache.db"));
  const chunkIdsForPath = cache.prepare("SELECT id FROM chunks WHERE vault_id = ? AND path = ?");
  const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath, "utf8")));
  const expected = new Set<string>();
  for (const q of golden.queries) {
    for (const p of [...q.seed_paths, ...q.target_paths, ...q.bridge_paths]) {
      for (const r of chunkIdsForPath.all(vaultId, norm(p)) as Array<{ id: string }>) {
        expected.add(r.id);
      }
    }
  }
  cache.close?.();

  // Provision experiential.db in the SAME cacheDir; reset the two tables the recompute reads/writes.
  const edb = await provisionExperientialDb(config.cacheDir, EXPERIENTIAL_MIGRATIONS);
  edb.exec("DELETE FROM chunk_retrievals");
  edb.exec("DELETE FROM vault_object_state");

  // Seed ORACLE retrievals: recent (last few hours), positively-cited events for every expected
  // chunk, so its ACT-R activation is high; every other chunk keeps a NULL score (bubble-safe inert).
  const now = Date.now();
  const ins = edb.prepare(
    "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, surface_type, query_text, rank_in_results, rerank_score, cited_in_response, citation_score, feedback, outcome) VALUES (?, ?, ?, 'seed', 'oracle', 'seed', 1, 1.0, 1, 1.0, 1, 1)",
  );
  edb.exec("BEGIN");
  try {
    for (const chunkId of expected) {
      for (let e = 0; e < events; e++) {
        ins.run(randomUUID(), chunkId, now - e * 3_600_000); // 1h apart, all recent
      }
    }
    edb.exec("COMMIT");
  } catch (err) {
    edb.exec("ROLLBACK");
    throw err;
  }

  const stats = recomputeActivation(edb, now, decay !== undefined ? { decay } : {});
  const dist = edb
    .prepare(
      "SELECT COUNT(*) n, MIN(cached_activation_score) lo, MAX(cached_activation_score) hi, AVG(cached_activation_score) avg FROM vault_object_state WHERE cached_activation_score IS NOT NULL",
    )
    .get() as { n: number; lo: number; hi: number; avg: number };
  process.stdout.write(
    `seeded ORACLE activation: ${expected.size} expected chunks x ${events} events -> ` +
      `recomputed ${stats.chunks} chunks; score n=${dist.n} min=${dist.lo?.toFixed(3)} ` +
      `max=${dist.hi?.toFixed(3)} avg=${dist.avg?.toFixed(3)}\n` +
      `experiential.db written to ${config.cacheDir}. Now A/B: --activation --bubble-safe vs off.\n`,
  );
  edb.close?.();
}

void main();
