// Family 1 (dispatch overhead) + family 2 (write-to-search freshness).
//
// Dispatch overhead isolates the ToolRegistry pipeline's own cost (validate -> auth ->
// scope/ACL -> HITL -> execute -> governor -> audit) from the handler's own work: wall-clock
// around registry.dispatch(...) minus the mean handler time the MetricsRecorder observed on
// its Prometheus histogram for the same tool.
//
// Freshness measures how long a note takes to become visible to search after being written:
// write straight to disk (M2 has no write_note tool), reindex via index_vault, then confirm
// search_text finds it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { FolderAcl } from "../../../src/acl";
import { fakeEmbeddingProvider } from "../../../src/embeddings/fake";
import { type CallerContext, ToolRegistry } from "../../../src/mcp/registry";
import { MetricsRecorder } from "../../../src/metrics/registry";
import { registerM2Tools } from "../../../src/tools/m2";
import { VaultRegistry } from "../../../src/vault/registry";
import type { VaultCtx } from "../harness";
import { quantiles } from "../harness";
import type { MetricSample } from "../report";

interface PromMetricValue {
  metricName?: string;
  value: number;
  labels?: Record<string, string | number>;
}
interface PromMetric {
  name: string;
  values: PromMetricValue[];
}

/** Mean handler seconds for `tool` on `vaultId`, read from the prom histogram's `_sum`/`_count`
 *  series (obsidian_tc_tool_duration_seconds, see src/metrics/registry.ts). 0 with no samples. */
async function meanHandlerSeconds(
  recorder: MetricsRecorder,
  vaultId: string,
  tool: string,
): Promise<number> {
  const json = (await recorder.registry.getMetricsAsJSON()) as unknown as PromMetric[];
  const histo = json.find((m) => m.name === "obsidian_tc_tool_duration_seconds");
  if (!histo) return 0;
  const isFor = (v: PromMetricValue, suffix: string): boolean =>
    v.metricName === `obsidian_tc_tool_duration_seconds${suffix}` &&
    v.labels?.vault === vaultId &&
    v.labels?.tool === tool;
  const sum = histo.values.find((v) => isFor(v, "_sum"))?.value ?? 0;
  const count = histo.values.find((v) => isFor(v, "_count"))?.value ?? 0;
  return count > 0 ? sum / count : 0;
}

const SEARCH_TOOL = "search_text";
const N = 30;
const WARMUP = 5;

export async function collectDispatch(vault: VaultCtx): Promise<MetricSample[]> {
  const recorder = new MetricsRecorder();
  const registry = new ToolRegistry({ metrics: recorder });
  const vaultRegistry = new VaultRegistry([{ id: vault.vaultId, path: vault.root }]);
  registerM2Tools(registry, {
    vaultRegistry,
    embeddingProvider: fakeEmbeddingProvider({ dimensions: 32 }),
  });
  const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
  const ctx: CallerContext = {
    caller: "perf",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: vault.vaultId,
    db: vault.db,
    acl,
  };

  // Family 1: dispatch overhead. Wall-clock around dispatch() of a cheap read tool, minus the
  // mean handler time the recorder observed for that same tool -- the residual is the pipeline's
  // own overhead (validation, scope/ACL, audit, metrics, governor), floored at 0.
  const searchArgs = { vault: vault.vaultId, query: "vault", limit: 5 };
  for (let i = 0; i < WARMUP; i++) await registry.dispatch(SEARCH_TOOL, searchArgs, ctx);
  const wall: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await registry.dispatch(SEARCH_TOOL, searchArgs, ctx);
    wall.push(performance.now() - t0);
  }
  const handlerMs = (await meanHandlerSeconds(recorder, vault.vaultId, SEARCH_TOOL)) * 1000;
  const overhead = wall.map((w) => Math.max(0, w - handlerMs));
  const q = quantiles(overhead);

  // Family 2: write-to-search freshness. M2 has no write_note tool, so the marker note is
  // written straight to disk; index_vault picks it up, and search_text confirms visibility.
  const marker = `perfmarker${vault.vaultId}${Date.now()}`;
  const t0 = performance.now();
  writeFileSync(join(vault.root, "perf-fresh.md"), `# Fresh\n\n${marker}`);
  await registry.dispatch("index_vault", { vault: vault.vaultId }, ctx);
  const found = await registry.dispatch(
    SEARCH_TOOL,
    { vault: vault.vaultId, query: marker, limit: 5 },
    ctx,
  );
  const freshMs = performance.now() - t0;
  const items = found.ok ? (((found.data as { items?: unknown[] }).items ?? []) as unknown[]) : [];
  const visible = found.ok && items.length > 0 ? 1 : 0;

  return [
    {
      key: "dispatch.overhead_p50_ms",
      value: q.p50,
      unit: "ms",
      class: "warn",
      direction: "higher-worse",
    },
    {
      key: "dispatch.overhead_p95_ms",
      value: q.p95,
      unit: "ms",
      class: "warn",
      direction: "higher-worse",
    },
    {
      key: "dispatch.overhead_p99_ms",
      value: q.p99,
      unit: "ms",
      class: "warn",
      direction: "higher-worse",
    },
    { key: "freshness.visible", value: visible, unit: "bool", class: "hard", direction: "exact" },
    { key: "freshness.ms", value: freshMs, unit: "ms", class: "warn", direction: "higher-worse" },
  ];
}
