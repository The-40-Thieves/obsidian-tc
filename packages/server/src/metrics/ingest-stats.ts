// THE-507 (folding in THE-489), extended THE-588: translate an indexing pass's aggregate stats into
// telemetry.
//
// Extracted from cli.ts's run_serve (where it was a private closure) so the exact production wiring
// is importable and testable directly against a real IndexStats object — a metric that is registered
// but never actually fed by the real pipeline is a known past failure here (THE-585 found three such
// gauges), and a test that only calls MetricsRecorder's inc* methods directly cannot catch that class
// of bug.
//
// Emitted by the CALLER rather than from inside indexVault, deliberately: indexer.ts has no
// telemetry-layer references today and keeping it that way means the indexing path stays testable
// without a metrics double.
//
// BOTH sinks, because they are different surfaces with different lifetimes: the Prometheus counters
// are in-memory and reset on restart, while `get_metrics` reads event_log and therefore survives one.
// `result_size` carries the COUNT (one row per pass, not per event) so an indexing pass cannot grow
// event_log in proportion to vault size — retention is time-based, so row count is the unbounded
// axis. A zero-count event writes nothing.
import { writeEvent } from "../audit";
import type { Database } from "../db/types";
import type { IndexStats } from "../search/indexer";
import type { MetricsRecorder } from "./registry";

export function recordIngestStats(
  db: Database,
  metrics: MetricsRecorder,
  vaultId: string,
  s: IndexStats,
): void {
  const events: Array<[string, number, (v: string, n: number) => void]> = [
    ["ingest_secrets_skipped", s.secrets_skipped, (v, n) => metrics.incIngestSecretsSkipped(v, n)],
    ["ingest_dedup_skipped", s.chunks_dedup_reused, (v, n) => metrics.incIngestDedupSkipped(v, n)],
    // THE-588: the unresolved (loss) side of dedup, alongside its reused (work-avoided) sibling.
    [
      "ingest_dedup_unresolved",
      s.chunks_dedup_unresolved,
      (v, n) => metrics.incIngestDedupUnresolved(v, n),
    ],
    [
      "embed_batch_rejections",
      s.embed_batch_rejections,
      (v, n) => metrics.incEmbedBatchRejections(v, n),
    ],
    ["index_write_failures", s.notes_embed_failed, (v, n) => metrics.incIndexWriteFailures(v, n)],
    // THE-925: notes an indexVault batch skipped because a concurrent write_note/watcher commit
    // raced its apply — not a failure, so a separate event_type from index_write_failures above.
    ["index_stale_skipped", s.notes_stale_skipped, (v, n) => metrics.incIndexStaleSkipped(v, n)],
  ];
  for (const [eventType, count, inc] of events) {
    if (count <= 0) continue;
    inc(vaultId, count);
    try {
      writeEvent(db, {
        ts: Date.now(),
        vault_id: vaultId,
        status: "ok",
        result_size: count,
        event_type: eventType,
      });
    } catch {
      /* telemetry must never break an indexing pass */
    }
  }
}
