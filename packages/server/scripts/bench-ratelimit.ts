// Per-request overhead of each rate-limit backend: `bun scripts/bench-ratelimit.ts [--redis <url>]
// [--n 20000]`. Prints mean / p50 / p99 / p99.9 in microseconds for one `consume` (one governed
// call's throttle decision). Under Node, bundle first:
//   bun build scripts/bench-ratelimit.ts --target node --external better-sqlite3 --external @redis/client \
//     --outfile /tmp/bench-ratelimit.mjs && node /tmp/bench-ratelimit.mjs
// `--contention` adds a sqlite case where a second connection holds long write transactions on the
// SAME file (what sharing cache.db with the indexer would look like), next to the dedicated file.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../src/db/open";
import type { BucketSpec, RateLimitBackend } from "../src/ratelimit/backend";
import { MemoryBackend } from "../src/ratelimit/memory-backend";
import { RedisBackend } from "../src/ratelimit/redis-backend";
import { openSqliteBackend, SqliteBackend } from "../src/ratelimit/sqlite-backend";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : (argv[i + 1] ?? "");
};
const N = Number(flag("--n") ?? 20_000);
const KEYS = 1_000;
const SPEC: BucketSpec = { capacity: 100, refillTokens: 600, intervalMs: 60_000 };

async function measure(label: string, b: RateLimitBackend): Promise<void> {
  for (let i = 0; i < 500; i++) await b.consume(`warm${i % KEYS}`, SPEC, 1, i); // warm-up
  const samples = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await b.consume(`caller${i % KEYS}|read|vault`, SPEC, 1, 1_000 + i);
    samples[i] = (performance.now() - t0) * 1000;
  }
  samples.sort();
  const q = (p: number) => samples[Math.min(N - 1, Math.floor(N * p))] as number;
  const mean = samples.reduce((a, c) => a + c, 0) / N;
  const rt = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node";
  console.log(
    `${rt.padEnd(4)} ${label.padEnd(30)} mean ${mean.toFixed(1).padStart(8)}us  p50 ${q(0.5)
      .toFixed(1)
      .padStart(
        8,
      )}  p99 ${q(0.99).toFixed(1).padStart(8)}  p99.9 ${q(0.999).toFixed(1).padStart(9)}`,
  );
}

const dir = mkdtempSync(join(tmpdir(), "otc-bench-"));
try {
  await measure("memory", new MemoryBackend());
  const sq = await openSqliteBackend({ cacheDir: dir, db: { busyTimeoutMs: 5000 } });
  await measure("sqlite (ratelimit.db)", sq);
  await sq.close();

  if (argv.includes("--contention")) {
    // ANOTHER PROCESS (needs `bun` on PATH) loops long write transactions on the same file — the
    // indexer's shape (a 20 ms lock hold, 5 ms pause). A same-thread writer would only alternate
    // with the measurement loop and show no contention at all.
    const file = join(dir, "shared.db");
    const shared = new SqliteBackend(await openDatabase(file, 5000));
    const writerSrc = `
      import { Database } from "bun:sqlite";
      const db = new Database(${JSON.stringify(file)});
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("CREATE TABLE IF NOT EXISTS churn (id INTEGER PRIMARY KEY, v TEXT)");
      for (;;) {
        db.exec("BEGIN IMMEDIATE");
        for (let i = 0; i < 200; i++) db.exec("INSERT INTO churn (v) VALUES ('" + "x".repeat(200) + "')");
        const until = performance.now() + 20;
        while (performance.now() < until);
        db.exec("COMMIT");
        await Bun.sleep(5);
      }`;
    const writer = spawn("bun", ["-e", writerSrc], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 500));
    await measure("sqlite (file shared w/ writer)", shared);
    writer.kill();
    await shared.close();
  }

  const redisUrl = flag("--redis");
  if (redisUrl) {
    const rb = await RedisBackend.create({ url: redisUrl, keyPrefix: `otc-bench:${Date.now()}:` });
    await measure("redis (localhost)", rb);
    await rb.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
