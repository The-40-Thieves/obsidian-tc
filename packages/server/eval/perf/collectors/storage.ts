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
