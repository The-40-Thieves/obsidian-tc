// Measurements for the experimental libSQL embedded-replica path (multi-device index sync spike).
//
//   OBSIDIAN_TC_SQLD_BIN=/path/to/sqld bun scripts/libsql-sync-bench.ts \
//     [--host 127.0.0.1] [--vault <dir of .md files>] [--notes 3000] [--writes 300] \
//     [--sqld-args "--max-log-size 4096"]
//
// Starts its own sqld bound to ONLY --host (loopback by default; pass a tailnet address to measure
// over that interface), runs the scenarios below against it, stops it, and prints one JSON document.
//   write latency   single-row autocommit INSERT / UPDATE and a 50-row transaction, forwarded to the
//                   server through the replica handle, against the same statements on a plain local
//                   libsql file as the floor
//   index           indexing N notes through the replica (every write forwarded) vs a local file
//   cold boot       a FRESH replica file opening against the server that already holds that index:
//                   the initial sync, then a warm reopen and a one-row incremental sync
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibsql } from "../src/db/libsql";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { startSqld } from "../test/sqld-harness";

function flag(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? fallback : process.argv[i + 1];
  if (v === undefined) throw new Error(`libsql-sync-bench: --${name} is required`);
  return v;
}

const bin = process.env.OBSIDIAN_TC_SQLD_BIN;
if (!bin) throw new Error("libsql-sync-bench: set OBSIDIAN_TC_SQLD_BIN to a sqld binary");
const host = flag("host", "127.0.0.1");
const noteCount = Number(flag("notes", "3000"));
const writeCount = Number(flag("writes", "300"));
const sqldArgs = (process.argv.includes("--sqld-args") ? flag("sqld-args") : "")
  .split(" ")
  .filter(Boolean);
const vaultSrc = process.argv.includes("--vault") ? flag("vault") : undefined;

const round = (n: number): number => Math.round(n * 100) / 100;
function stats(ms: number[]): { n: number; p50: number; p95: number; max: number } {
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { n: s.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(s.at(-1) ?? 0) };
}
function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

function writeLatency(db: Database): Record<string, unknown> {
  db.exec("CREATE TABLE IF NOT EXISTS bench_kv (k INTEGER PRIMARY KEY, v TEXT NOT NULL)");
  const ins = db.prepare("INSERT INTO bench_kv (k, v) VALUES (?, ?)");
  const upd = db.prepare("UPDATE bench_kv SET v = ? WHERE k = 1");
  for (let i = 0; i < 20; i++) ins.run(-1 - i, "warmup");
  const inserts: number[] = [];
  for (let i = 0; i < writeCount; i++) inserts.push(time(() => ins.run(i + 1, `value-${i}`)));
  const updates: number[] = [];
  for (let i = 0; i < writeCount; i++) updates.push(time(() => upd.run(`u-${i}`)));
  const txns: number[] = [];
  for (let t = 0; t < 20; t++) {
    txns.push(
      time(() => {
        db.exec("BEGIN");
        for (let i = 0; i < 50; i++) ins.run(100_000 + t * 50 + i, "txn");
        db.exec("COMMIT");
      }),
    );
  }
  return {
    insert_ms: stats(inserts),
    update_ms: stats(updates),
    txn_of_50_inserts_ms: stats(txns),
  };
}

function sourceNotes(dest: string): { copied: number; bytes: number } {
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  let bytes = 0;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (copied >= noteCount) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) {
        copyFileSync(p, join(dest, `n${copied}.md`));
        bytes += statSync(p).size;
        copied++;
      }
    }
  };
  if (vaultSrc) walk(vaultSrc);
  else {
    for (; copied < noteCount; copied++) {
      const body = `# note ${copied}\n\nmarker${copied} the quick brown fox. ${"lorem ipsum dolor sit amet ".repeat(40)}`;
      writeFileSync(join(dest, `n${copied}.md`), body);
      bytes += body.length;
    }
  }
  return { copied, bytes };
}

async function indexInto(db: Database, root: string): Promise<{ ms: number; chunks: number }> {
  provisionCacheDb(db);
  const provider = fakeEmbeddingProvider({ dimensions: 32 });
  const t = performance.now();
  const r = await indexVault({
    db,
    provider,
    representation: buildRepresentationManifest(provider, {}),
    vaultId: "bench",
    root,
    isReadable: () => true,
  });
  db.sync?.();
  return { ms: performance.now() - t, chunks: r.chunks_upserted };
}

const work = mkdtempSync(join(tmpdir(), "otc-sync-bench-"));
const sqld = await startSqld(bin, work, { withVec: true, host, extraArgs: sqldArgs });
try {
  const result: Record<string, unknown> = {
    host,
    sqld: sqld.url,
    sqld_args: sqldArgs,
    writes: writeCount,
  };

  // 1. Forwarded-write latency vs the local floor.
  const local = await openLibsql(join(work, "local.db"));
  result.write_local = writeLatency(local);
  local.close();
  const replicaA = join(work, "a.db");
  const a = await openLibsql(replicaA, undefined, { sync: { url: sqld.url } });
  result.write_forwarded = writeLatency(a);

  // 2. Index N notes locally, then through the replica.
  const vaultDir = join(work, "vault");
  const src = sourceNotes(vaultDir);
  result.notes = { count: src.copied, source_bytes: src.bytes, from: vaultSrc ?? "generated" };
  const localIdx = await openLibsql(join(work, "local-index.db"));
  const li = await indexInto(localIdx, vaultDir);
  localIdx.close();
  const tFwd = performance.now();
  try {
    const fi = await indexInto(a, vaultDir);
    result.index = {
      local_ms: Math.round(li.ms),
      forwarded_ms: Math.round(fi.ms),
      chunks: fi.chunks,
      slowdown_x: round(fi.ms / li.ms),
    };
  } catch (e) {
    // The failure is itself a result (see the PR): record it and still measure the cold boot.
    result.index = {
      local_ms: Math.round(li.ms),
      forwarded_failed_after_ms: Math.round(performance.now() - tFwd),
      error: String(e).split("\n")[0]?.slice(0, 300),
    };
  }

  // 3. Cold boot: a fresh replica file against the server that now holds the index.
  const replicaB = join(work, "b.db");
  const tCold = performance.now();
  const b = await openLibsql(replicaB, undefined, { sync: { url: sqld.url } });
  const coldMs = performance.now() - tCold;
  const notesB = (b.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n;
  const chunksB = (b.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
  const replicaBytes = [replicaB, `${replicaB}-wal`, `${replicaB}-info`].reduce((t, f) => {
    try {
      return t + statSync(f).size;
    } catch {
      return t;
    }
  }, 0);
  b.close();
  const tWarm = performance.now();
  const b2 = await openLibsql(replicaB, undefined, { sync: { url: sqld.url } });
  const warmMs = performance.now() - tWarm;
  a.prepare("INSERT INTO bench_kv (k, v) VALUES (?, ?)").run(999_999, "incremental");
  const incMs = time(() => b2.sync?.());
  b2.close();
  a.close();
  result.cold_boot = {
    initial_sync_ms: Math.round(coldMs),
    notes_visible: notesB,
    chunks_visible: chunksB,
    replica_bytes: replicaBytes,
    warm_reopen_ms: Math.round(warmMs),
    one_row_incremental_sync_ms: round(incMs),
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await sqld.stop();
  rmSync(work, { recursive: true, force: true });
}
