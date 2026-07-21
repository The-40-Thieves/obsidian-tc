import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

/** Families 3 (index throughput), 4 (embed throughput), 5 (duplicate-embedding ratio). */
export function collectIndexing(vault: VaultCtx, buildMs: number): MetricSample[] {
  const chunks = vault.chunkCount;
  const embedded = vault.provider.texts;
  const seconds = buildMs / 1000;
  const dupRatio = chunks > 0 ? 1 - embedded / chunks : 0;
  return [
    {
      key: "index.chunk_count",
      value: chunks,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      key: "index.chunks_per_s",
      value: seconds > 0 ? chunks / seconds : 0,
      unit: "per_s",
      class: "hard",
      direction: "lower-worse",
    },
    {
      key: "embed.call_count",
      value: vault.provider.calls,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      key: "embed.texts_per_s",
      value: seconds > 0 ? embedded / seconds : 0,
      unit: "per_s",
      class: "warn",
      direction: "lower-worse",
    },
    {
      key: "embed.dup_ratio",
      value: dupRatio,
      unit: "ratio",
      class: "hard",
      direction: "higher-worse",
    },
  ];
}
