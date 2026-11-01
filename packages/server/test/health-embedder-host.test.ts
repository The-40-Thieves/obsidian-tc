// GH #1433 step 3: with a child-process embedder host, server_health's memory block reports it as
// `embedder_host` and `over_budget` compares parent + child RSS against embeddings.memoryBudgetMb.
// Without a child host the block keeps the #1459 shape exactly.
import { describe, expect, it } from "vitest";
import type { EmbedderHostStats } from "../src/embeddings/host/types";
import type { CallerContext } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";

const MIB = 1024 * 1024;
const adminCtx = {
  caller: null,
  grantedScopes: new Set<string>(),
  vaultId: "v1",
  db: {} as never,
  authenticated: true,
} as CallerContext;

const childStats = (rssBytes: number): EmbedderHostStats => ({
  state: "ready",
  restarts: 2,
  recycles: 1,
  rssBytes,
});

function memoryWith(opts: { budgetMb?: number; child?: EmbedderHostStats }) {
  const tool = createHealthTool({
    version: "1.0.0",
    vaults: ["v1"],
    startedAt: 0,
    nativeLoaded: false,
    vecEnabled: false,
    ...(opts.budgetMb !== undefined ? { memoryBudgetMb: opts.budgetMb } : {}),
    embedderHost: () => opts.child,
  });
  return (
    tool.handler({}, adminCtx) as unknown as {
      memory: Record<string, unknown> & { over_budget: boolean };
    }
  ).memory;
}

describe("server_health embedder_host (GH #1433 step 3)", () => {
  it("adds no embedder_host key and keeps the #1459 field set when there is no child host", () => {
    const m = memoryWith({ budgetMb: 1_000_000 });
    expect(Object.keys(m).sort()).toEqual(["budget_mb", "external_mb", "over_budget", "rss_mb"]);
  });

  it("reports the child's state, restarts and RSS as embedder_host", () => {
    const m = memoryWith({ child: childStats(150 * MIB) });
    expect(m.embedder_host).toEqual({ state: "ready", restarts: 2, rss_mb: 150 });
  });

  it("reports rss_mb as null for a child whose RSS is not yet known", () => {
    const m = memoryWith({ child: { state: "loading", restarts: 0, recycles: 0 } });
    expect(m.embedder_host).toEqual({ state: "loading", restarts: 0, rss_mb: null });
  });

  it("over_budget stays false when the parent is under budget and no child is running", () => {
    // A host with no child reports no RSS (the recycled child's RSS is cleared), so nothing is added.
    const parentMb = Math.ceil(process.memoryUsage().rss / MIB);
    const m = memoryWith({
      budgetMb: parentMb + 50,
      child: { state: "idle", restarts: 1, recycles: 1 },
    });
    expect(m.over_budget).toBe(false);
    expect(m.embedder_host).toEqual({ state: "idle", restarts: 1, rss_mb: null });
  });

  it("a child with a pid whose RSS is not known yet reads over_budget as null, not as the parent alone", () => {
    // Right after a respawn the child is running but its RSS has not come back yet.
    const parentMb = Math.ceil(process.memoryUsage().rss / MIB);
    const m = memoryWith({
      budgetMb: parentMb + 50,
      child: { state: "loading", restarts: 1, recycles: 0, pid: 4242 },
    });
    expect(m.over_budget).toBeNull();
    expect(m.embedder_host).toEqual({
      state: "loading",
      restarts: 1,
      rss_mb: null,
      child_rss_known: false,
    });
  });

  it("a child with a pid and a known RSS reports child_rss_known true and computes over_budget", () => {
    const parentMb = Math.ceil(process.memoryUsage().rss / MIB);
    const m = memoryWith({
      budgetMb: parentMb + 100,
      child: { state: "ready", restarts: 0, recycles: 0, pid: 4242, rssBytes: 150 * MIB },
    });
    expect(m.over_budget).toBe(true);
    expect(m.embedder_host).toEqual({
      state: "ready",
      restarts: 0,
      rss_mb: 150,
      child_rss_known: true,
    });
  });

  it("over_budget compares parent + child RSS, so a child alone can tip it over", () => {
    // Read the parent's RSS now, not at import: the suite grows the process after collection. The budget
    // is the parent alone plus 50 MB, so the parent is under it and parent + a 100 MB child is not.
    const parentMb = Math.ceil(process.memoryUsage().rss / MIB);
    const budgetMb = parentMb + 50;
    expect(memoryWith({ budgetMb }).over_budget).toBe(false);
    const m = memoryWith({ budgetMb, child: childStats(100 * MIB) });
    expect(m.over_budget).toBe(true);
    expect(m.rss_mb).toBeGreaterThan(0);
  });
});
