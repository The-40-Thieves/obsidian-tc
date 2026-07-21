// Family 1 (dispatch overhead) + family 2 (write-to-search freshness).
//
// Dispatch overhead isolates the ToolRegistry pipeline's own cost (validate -> auth ->
// scope/ACL -> HITL -> execute -> governor -> audit) from the handler's own work. The registry's
// onProfile sink fires once per successful dispatch with genuine per-call timing: total_ms (the
// whole dispatch) and handler_ms (the handler body only). Genuine dispatch overhead per call is
// total_ms - handler_ms.
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
import { registerM2Tools } from "../../../src/tools/m2";
import { VaultRegistry } from "../../../src/vault/registry";
import type { VaultCtx } from "../harness";
import { quantiles } from "../harness";
import type { MetricSample } from "../report";

const SEARCH_TOOL = "search_text";
const N = 30;
const WARMUP = 5;

export async function collectDispatch(vault: VaultCtx): Promise<MetricSample[]> {
  let collecting = false;
  const overhead: number[] = [];
  const registry = new ToolRegistry({
    onProfile: (p) => {
      if (!collecting || p.tool !== SEARCH_TOOL) return;
      overhead.push(Math.max(0, p.total_ms - p.handler_ms));
    },
  });
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

  // Family 1: dispatch overhead. Per-call (total_ms - handler_ms) reported by the registry's
  // onProfile sink -- the pipeline's own cost (validation, scope/ACL, audit, metrics, governor)
  // isolated from the handler's own work, floored at 0. Warmup iterations are discarded.
  const searchArgs = { vault: vault.vaultId, query: "vault", limit: 5 };
  for (let i = 0; i < WARMUP; i++) await registry.dispatch(SEARCH_TOOL, searchArgs, ctx);
  collecting = true;
  for (let i = 0; i < N; i++) await registry.dispatch(SEARCH_TOOL, searchArgs, ctx);
  collecting = false;
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
