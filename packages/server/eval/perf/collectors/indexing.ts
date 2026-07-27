import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

/** Families 3 (index throughput), 4 (embed throughput), 5 (duplicate-embedding ratio),
 *  7 (write-transaction count -- THE-503). */
export function collectIndexing(vault: VaultCtx, buildMs: number): MetricSample[] {
  const chunks = vault.chunkCount;
  const embedded = vault.provider.texts;
  const seconds = buildMs / 1000;
  const dupRatio = chunks > 0 ? 1 - embedded / chunks : 0;
  return [
    {
      key: "index.chunk_count",
      portable: true,
      value: chunks,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    // THE-458: the three perf gates the program named as missing. `notes_per_s` and `tokens_per_s`
    // are throughput (warn — runner-variable, like chunks_per_s); their deterministic counterparts
    // are gated hard, because a throughput number is only interpretable next to the count it
    // divided. A silent drop in notes indexed would otherwise READ AS a throughput regression.
    {
      key: "index.notes_count",
      portable: true,
      value: vault.stats.notes_indexed,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      key: "index.notes_per_s",
      portable: true,
      value: seconds > 0 ? vault.stats.notes_indexed / seconds : 0,
      unit: "per_s",
      class: "warn",
      direction: "lower-worse",
    },
    {
      // Estimated with PRODUCTION's estimateTokens (search/chunk.ts), not a harness-local
      // approximation — the same function that decides embed batching, so this measures a
      // quantity the server actually acts on.
      key: "embed.tokens",
      portable: true,
      value: vault.provider.tokens,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      key: "embed.tokens_per_s",
      portable: true,
      value: seconds > 0 ? vault.provider.tokens / seconds : 0,
      unit: "per_s",
      class: "warn",
      direction: "lower-worse",
    },
    {
      // The DENOMINATOR gate. Every storage/CPU figure in this harness is whole-process, and the
      // harness builds exactly one vault — so `storage.bytes` is trivially "per vault" today and
      // would silently stop being so the moment anyone adds a second. Emitting the count makes
      // that assumption explicit and hard-gated, rather than implicit in the harness's shape.
      // THE-458 lists "per-vault CPU/storage" as a missing gate; this is the honest form of it
      // until the harness is genuinely multi-vault.
      key: "harness.vault_count",
      portable: true,
      value: 1,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      key: "index.chunks_per_s",
      portable: true,
      value: seconds > 0 ? chunks / seconds : 0,
      unit: "per_s",
      // Throughput is runner-variable; warn-only per spec §3 (the hard invariant is
      // the deterministic index.chunk_count above). THE-459.
      class: "warn",
      direction: "lower-worse",
    },
    // THE-503: the REAL number of write transactions indexVault used to build this vault (via a
    // db.exec("BEGIN") counting wrapper in harness.ts — see countingDatabase). This is what
    // THE-500's byte-bounded batch-transaction work actually changes, and it is deterministic
    // given the seeded corpus + a fixed batch config, so it is gated hard -- but as "lower is
    // better" rather than "exact". Per this file's Direction convention (report.ts:
    // "higher-worse: latency/cost/bytes" — a HIGHER value is the regression direction, i.e.
    // LOWER is better), a transaction count is a cost metric like storage.bytes, so it takes
    // direction "higher-worse": more transactions is worse, fewer is strictly an improvement, and
    // a legitimate batching win can now register as one instead of tripping an exact-match
    // invariant. This is DISTINCT from storage.txn_count (collectors/storage.ts), which is a
    // synthetic, harness-controlled scratch-table loop of a hardcoded constant size, used only to
    // time raw per-commit overhead -- it never reflected indexVault's real batching behavior at
    // all, so it could never have registered THE-500's improvement regardless of its direction
    // field.
    {
      key: "index.txn_count",
      portable: true,
      value: vault.writeTxnCount,
      unit: "count",
      class: "hard",
      direction: "higher-worse",
    },
    {
      key: "embed.call_count",
      portable: true,
      value: vault.provider.calls,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      key: "embed.texts_per_s",
      portable: true,
      value: seconds > 0 ? embedded / seconds : 0,
      unit: "per_s",
      class: "warn",
      direction: "lower-worse",
    },
    {
      key: "embed.dup_ratio",
      portable: true,
      value: dupRatio,
      unit: "ratio",
      class: "hard",
      direction: "higher-worse",
    },
  ];
}
