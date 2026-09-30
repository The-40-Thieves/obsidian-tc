// Counters for what the periodic maintenance jobs delete. Split out of registry.ts, which sits at
// biome's per-file line cap; MetricsRecorder owns one instance and delegates, so callers still see
// a single recorder.
import { Counter, type Registry } from "prom-client";
import type { MemoryOrphanClass } from "../db/memory-orphans";

export class MaintenanceCounters {
  private readonly memoryOrphansSwept: Counter<string>;
  private readonly morgianaSpoolPruned: Counter<string>;

  constructor(registers: Registry[]) {
    this.memoryOrphansSwept = new Counter({
      name: "obsidian_tc_memory_orphans_swept_total",
      help: "Memory rows deleted by the periodic orphan sweep, by class (dangling_relations, dangling_intervals, retired_entities, removed_vault_entities, removed_vault_relations, removed_vault_intervals). Cumulative. Only the two dangling_* classes are on by default; the other four move only when the operator sets their retention window. A dry run does not increment it.",
      labelNames: ["class"],
      registers,
    });
    this.morgianaSpoolPruned = new Counter({
      name: "obsidian_tc_morgiana_spool_files_pruned_total",
      help: "Morgiana event spool day files deleted by the retention sweep, by reason (age = older than observability.retention.spoolRetentionDays, size = oldest files dropped to fit spoolMaxBytes). Cumulative. The current day's file is never deleted.",
      labelNames: ["reason"],
      registers,
    });
  }

  /** Rows the memory orphan sweep deleted for one class. Guarded on n > 0 like the ingest counters,
   *  so a sweep that found nothing creates no series. */
  incMemoryOrphansSwept(cls: MemoryOrphanClass, n: number): void {
    if (n > 0) this.memoryOrphansSwept.inc({ class: cls }, n);
  }

  /** Spool day files the retention sweep deleted for one reason. Guarded on n > 0, so a sweep that
   *  found nothing creates no series. */
  incMorgianaSpoolPruned(reason: "age" | "size", n: number): void {
    if (n > 0) this.morgianaSpoolPruned.inc({ reason }, n);
  }
}
