import { performance } from "node:perf_hooks";
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

export function collectStorage(vault: VaultCtx): MetricSample[] {
  const pageCount = (vault.db.prepare("PRAGMA page_count").get() as { page_count: number })
    .page_count;
  const pageSize = (vault.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const bytes = pageCount * pageSize;

  // A fixed batch of transactional writes into a scratch table -> deterministic txn count.
  vault.db.exec("CREATE TABLE IF NOT EXISTS perf_txn_scratch (k INTEGER PRIMARY KEY, v TEXT)");
  const TXNS = 200;

  // UNTIMED WARMUP — without it this metric reports JSC tier-up, not SQLite.
  //
  // `isolate.ts` takes a fresh subprocess per sample, so the timed loop below runs exactly ONCE per
  // process and is therefore always a first execution. Whether JSC has promoted the shared
  // bun:sqlite exec/prepare/run path by then is a race with its CONCURRENT compiler thread, so the
  // result was binary rather than noisy: measured over 20 fresh processes each, cold ran 2.418ms
  // and warm 0.819ms — a 2.95x step with an empty gap between the clusters. In CI that produced two
  // modes at 0.850 / 2.633 (3.10x) across 7 recordings, per-run high counts [2,2,4,4,5,1,0].
  //
  // No per-run statistic can catch this: two recordings each reported cv≈0.03 — rock solid — while
  // disagreeing with each other by 3.7x, because CV measures dispersion INSIDE a run and the mode is
  // chosen BETWEEN runs. Raising `samples` or tightening the CV/contention thresholds cannot help.
  //
  // Warm on a SEPARATE table, then drop it. Warming `perf_txn_scratch` itself would leave 200 rows
  // behind and turn the timed loop's fresh INSERTs into REPLACEs over existing rows, which changes
  // what is measured a second time rather than only removing the confound. 5 rounds because the
  // settling point measured at ~4 (rep 5 onward held ~0.79ms across 36 consecutive executions).
  vault.db.exec("CREATE TABLE IF NOT EXISTS perf_txn_warmup (k INTEGER PRIMARY KEY, v TEXT)");
  const warm = vault.db.prepare("INSERT OR REPLACE INTO perf_txn_warmup (k, v) VALUES (?, ?)");
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < TXNS; i++) {
      vault.db.exec("BEGIN");
      warm.run(i, `warm-${i}`);
      vault.db.exec("COMMIT");
    }
  }
  vault.db.exec("DROP TABLE perf_txn_warmup");

  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const insert = vault.db.prepare("INSERT OR REPLACE INTO perf_txn_scratch (k, v) VALUES (?, ?)");
  for (let i = 0; i < TXNS; i++) {
    vault.db.exec("BEGIN");
    insert.run(i, `row-${i}`);
    vault.db.exec("COMMIT");
  }
  const txnMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const cpuMs = (cpu.user + cpu.system) / 1000;

  return [
    { key: "storage.bytes", value: bytes, unit: "bytes", class: "hard", direction: "higher-worse" },
    {
      key: "storage.txn_count",
      value: TXNS,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    { key: "storage.txn_ms", value: txnMs, unit: "ms", class: "warn", direction: "higher-worse" },
    { key: "storage.cpu_ms", value: cpuMs, unit: "ms", class: "warn", direction: "higher-worse" },
  ];
}
