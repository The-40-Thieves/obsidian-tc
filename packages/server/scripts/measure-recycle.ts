// Measures the child-process embedder recycle policy (GH #1433) against the in-process host. It drives
// the real burst-end wiring (one indexVault full reconcile of a 300-note vault, then 20 index-on-write
// bursts) through the real host, and prints one ROW line per sample and one RESULT line.
//
// Usage (run from packages/server, on a machine with the embedder-local build and a model cache):
//   MEASURE_CACHE=/path/to/cache bun scripts/measure-recycle.ts child-process
//   MEASURE_CACHE=/path/to/cache bun scripts/measure-recycle.ts in-process
// MEASURE_MODEL (default nomic-embed-text-v1.5) and MEASURE_DIMS (default 768) pick the model. The
// budget is the loaded size + 150 MB, as in the #1433 measurement. Child RSS is read through
// host.snapshot() after each stats() call, so the sample shows what the policy itself sees.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { runEmbedderChild } from "../src/embeddings/host/child-main";
import { createChildProcessHost } from "../src/embeddings/host/child-process";
import { createInProcessHost } from "../src/embeddings/host/in-process";
import { embedderRecycleTotals } from "../src/embeddings/host/recycle-policy";
import { registerHost } from "../src/embeddings/host/registry";
import { markCliEntry, selfSpawnArgv } from "../src/embeddings/host/spawn-argv";
import { MetricsRecorder } from "../src/metrics/registry";
import { loadLocalEmbedderProvider } from "../src/providers/local-embedder-registry";
import { wireIndexCoordinator } from "../src/runtime/indexing-wiring";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { openMemoryDb } from "../test/helpers";

// The vitest-free equivalent of test/m2-helpers makeM2Vault (which imports vitest).
function makeVault(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "obtc-measure-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const db = openMemoryDb();
  provisionCacheDb(db);
  return { root, id: "test", db, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

if (process.env.OBSIDIAN_TC_EMBEDDER_HOST === "1") {
  await runEmbedderChild({ input: process.stdin, output: process.stdout });
  process.exit(0);
}
markCliEntry();

const MODE = process.argv[2] === "in-process" ? "in-process" : "child-process";
const MODEL = process.env.MEASURE_MODEL ?? "nomic-embed-text-v1.5";
const DIMS = Number(process.env.MEASURE_DIMS ?? 768);
const MIB = 1024 * 1024;
const cacheDir = process.env.MEASURE_CACHE ?? "/tmp/obtc-measure-cache";
const init = {
  model: MODEL,
  quantized: true,
  modelsRoot: join(cacheDir, "models", "embedder-local"),
  cacheDir,
};

const owner = {};
const host =
  MODE === "child-process"
    ? createChildProcessHost({ argv: selfSpawnArgv(), init, timeoutMs: 600_000 })
    : createInProcessHost(() => loadLocalEmbedderProvider(init));
registerHost(owner, host);

const provider = {
  id: `local:${MODEL}:q8`,
  provider: "local",
  model: MODEL,
  dimensions: DIMS,
  embed: (texts: string[], opts?: unknown) => host.embed(texts, opts as never),
};

const rows: Record<string, unknown>[] = [];
const parentMb = () => Math.round(process.memoryUsage().rss / MIB);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function snap(phase: string, extra: Record<string, unknown> = {}): Promise<void> {
  await host.stats();
  const s = host.snapshot();
  rows.push({
    phase,
    parent_mb: parentMb(),
    child_mb: s.rssBytes === undefined ? null : Math.round(s.rssBytes / MIB),
    child_state: s.state,
    child_pid: s.pid ?? null,
    restarts: s.restarts,
    recycles: s.recycles,
    ...extra,
  });
}

// Parent RSS timeline, sampled every 200 ms for the whole run.
const timeline: number[] = [];
const sampler = setInterval(() => timeline.push(parentMb()), 200);

const t0 = Date.now();
await provider.embed(["warm up the embedder"]);
await snap("loaded");
const loaded = host.snapshot();
const loadedMb = Math.ceil((process.memoryUsage().rss + (loaded.rssBytes ?? 0)) / MIB);
const budgetMb = loadedMb + 150;
rows.push({ phase: "budget-set", loaded_mb: loadedMb, budget_mb: budgetMb });

// 300 notes, each six paragraphs of seeded pseudo-text.
const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike".split(
  " ",
);
let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const noteBody = (i: number, rev: number) =>
  Array.from({ length: 6 }, () =>
    Array.from({ length: 60 }, () => words[Math.floor(rand() * words.length)]).join(" "),
  ).join("\n\n") + `\n\nnote ${i} revision ${rev}`;
const files: Record<string, string> = {};
for (let i = 0; i < 300; i++) files[`notes/n${i}.md`] = noteBody(i, 0);
const v = makeVault(files);

const wiring = wireIndexCoordinator({
  db: v.db,
  metrics: new MetricsRecorder(),
  embeddingProvider: provider as never,
  hasVec: false,
  chunkContext: false,
  indexing: {
    writeConcurrency: 2,
    writeConcurrencyPerVault: 2,
    queueMax: 1000,
    memoryBudgetMb: MODE === "child-process" ? budgetMb : undefined,
  },
  vaults: [{ id: v.id, path: v.root }],
  watch: { enabled: false, debounceMs: 0 },
  sqlHooksFor: () => ({}),
  indexHealth: { writeFailures: 0, frontmatterFailures: new Map(), indexQueueBackpressures: 0 },
  acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths: ["**"] }),
  aclByVault: new Map(),
  makeOnIndexed: () => undefined,
} as never);

const r0 = Date.now();
const stats = await indexVault({
  db: v.db,
  provider: provider as never,
  vaultId: v.id,
  root: v.root,
  isReadable: () => true,
  representation: buildRepresentationManifest(provider as never, {}),
  embed: { memoryBudgetMb: MODE === "child-process" ? budgetMb : undefined },
});
await sleep(1500); // the burst-end recycle is fire-and-forget
await snap("after-full-reconcile", {
  notes: stats.notes_indexed,
  reconcile_ms: Date.now() - r0,
  chunks: stats.chunks_upserted,
});

for (let b = 0; b < 20; b++) {
  for (let k = 0; k < 5; k++) {
    const i = (b * 5 + k) % 300;
    wiring.reindexHook(v.id, `notes/n${i}.md`, noteBody(i, b + 1));
  }
  await wiring.indexCoordinator.idle();
  await sleep(300);
  if ([0, 4, 9, 19].includes(b)) await snap(`burst-${b + 1}`, { budget_mb: budgetMb });
}

await sleep(10_000);
await snap("10s-after-last", { budget_mb: budgetMb });

const finalStats = host.snapshot();
const result = {
  mode: MODE,
  loaded_mb: loadedMb,
  budget_mb: MODE === "child-process" ? budgetMb : null,
  restarts_crash: finalStats.restarts,
  recycles_host: finalStats.recycles,
  recycles_policy: embedderRecycleTotals(),
  parent_mb_min: Math.min(...timeline),
  parent_mb_max: Math.max(...timeline),
  parent_mb_post_burst: parentMb(),
  child_mb_post_burst:
    finalStats.rssBytes === undefined ? null : Math.round(finalStats.rssBytes / MIB),
  total_ms: Date.now() - t0,
};
clearInterval(sampler);
for (const row of rows) console.log(`ROW ${JSON.stringify(row)}`);
console.log(`RESULT ${JSON.stringify(result)}`);
await host.close();
v.cleanup();
process.exit(0);
