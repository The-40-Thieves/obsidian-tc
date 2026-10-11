// A second OS process for test/libsql-sync.test.ts: one "machine" with its own embedded-replica file
// against the shared sqld. Runs under `bun` (like param-binding-bun-probe.ts), which also exercises
// the libsql adapter on that runtime. Each scenario prints JSON lines; the last one is the result.
//
//   migrate <replica> <url>                 run the cache.db migration chain through the replica
//   index   <replica> <url> <vault> <n>     index n generated notes into vault <vault>, then sync
//   hold    <replica> <url> <ms>            BEGIN EXCLUSIVE, hold ms, then COMMIT
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibsql } from "../src/db/libsql";
import { provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";

const [scenario, replica, url, ...rest] = process.argv.slice(2);
if (!scenario || !replica || !url) throw new Error("usage: <scenario> <replica> <url> ...");
const out = (o: Record<string, unknown>): void => console.log(JSON.stringify(o));
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const t0 = Date.now();
const db = await openLibsql(replica, undefined, { sync: { url } });
out({ event: "open", ms: Date.now() - t0 });

if (scenario === "migrate") {
  out({ event: "done", applied: provisionCacheDb(db).length });
} else if (scenario === "index") {
  const [vault = "v", n = "3"] = rest;
  const root = mkdtempSync(join(tmpdir(), `otc-sync-${vault}-`));
  try {
    mkdirSync(join(root, "notes"));
    for (let i = 0; i < Number(n); i++) {
      writeFileSync(
        join(root, "notes", `${vault}-${i}.md`),
        `# ${vault} note ${i}\n\nmarker${vault}${i} the quick brown fox number ${i} of vault ${vault}`,
      );
    }
    provisionCacheDb(db);
    const provider = fakeEmbeddingProvider({ dimensions: 32 });
    const stats = await indexVault({
      db,
      provider,
      representation: buildRepresentationManifest(provider, {}),
      vaultId: vault,
      root,
      isReadable: () => true,
    });
    db.sync?.();
    out({
      event: "done",
      chunks: stats.chunks_upserted,
      vec: stats.vec_enabled,
      ms: Date.now() - t0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} else if (scenario === "hold") {
  const holdMs = Number(rest[0] ?? "1000");
  db.exec("BEGIN EXCLUSIVE");
  out({ event: "acquired", at: Date.now() });
  sleep(holdMs);
  try {
    db.exec("COMMIT");
    out({ event: "released", at: Date.now() });
  } catch (e) {
    out({ event: "lost", at: Date.now(), message: (e as Error).message });
  }
} else {
  throw new Error(`unknown scenario ${scenario}`);
}
db.close?.();
