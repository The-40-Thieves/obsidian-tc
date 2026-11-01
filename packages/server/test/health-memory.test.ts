// GH #1433: server_health's `memory` block. Non-identifying (no paths), so it is present for every
// caller, like native_loaded. `over_budget` is true only when embeddings.memoryBudgetMb is set and
// the process RSS exceeds it.
import { describe, expect, it } from "vitest";
import type { CallerContext } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";

const base = {
  caller: null,
  grantedScopes: new Set<string>(),
  vaultId: "v1",
  db: {} as never,
  authenticated: false,
} satisfies Partial<CallerContext>;

const healthWith = (memoryBudgetMb?: number) =>
  createHealthTool({
    version: "1.0.0",
    vaults: ["v1"],
    startedAt: 0,
    nativeLoaded: false,
    vecEnabled: false,
    ...(memoryBudgetMb !== undefined ? { memoryBudgetMb } : {}),
  });

type MemoryBlock = {
  rss_mb: number;
  external_mb: number;
  budget_mb: number | null;
  over_budget: boolean;
};
const memoryOf = (memoryBudgetMb?: number): MemoryBlock =>
  (healthWith(memoryBudgetMb).handler({}, base as CallerContext) as { memory: MemoryBlock }).memory;

describe("server_health memory block (GH #1433)", () => {
  it("reports whole-MB rss and external, with budget_mb null and over_budget false when no budget is set", () => {
    const m = memoryOf();
    expect(Number.isInteger(m.rss_mb)).toBe(true);
    expect(m.rss_mb).toBeGreaterThan(0);
    expect(Number.isInteger(m.external_mb)).toBe(true);
    expect(m.budget_mb).toBeNull();
    expect(m.over_budget).toBe(false);
  });

  it("is over_budget when memoryBudgetMb is set below the process RSS", () => {
    const m = memoryOf(1);
    expect(m.budget_mb).toBe(1);
    expect(m.over_budget).toBe(true);
  });

  it("is not over_budget when memoryBudgetMb is set above the process RSS", () => {
    const m = memoryOf(1_000_000);
    expect(m.budget_mb).toBe(1_000_000);
    expect(m.over_budget).toBe(false);
  });

  it("is present for an unauthenticated caller (non-identifying)", () => {
    const out = healthWith().handler({}, { ...base, authenticated: false } as CallerContext) as {
      memory?: MemoryBlock;
    };
    expect(out.memory).toBeDefined();
  });
});
