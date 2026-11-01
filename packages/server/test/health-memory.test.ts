// GH #1433: server_health's `memory` block. Process RSS lets one tenant observe other tenants'
// activity at MiB resolution, so the block is gated like job_queue: present only for an
// authenticated, unbound caller (THE-924), absent for everyone else. `over_budget` is true only when
// embeddings.memoryBudgetMb is set and the process RSS exceeds it.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallerContext } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";

const MIB = 1024 * 1024;

const base = {
  caller: null,
  grantedScopes: new Set<string>(),
  vaultId: "v1",
  db: {} as never,
  authenticated: false,
} satisfies Partial<CallerContext>;

const adminCtx = { ...base, authenticated: true } as CallerContext;

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
  (healthWith(memoryBudgetMb).handler({}, adminCtx) as { memory: MemoryBlock }).memory;

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

  it("is present for an unbound administrator", () => {
    const out = healthWith().handler({}, adminCtx) as { memory?: MemoryBlock };
    expect(out.memory).toBeDefined();
  });

  it("is absent for a vault-bound caller", () => {
    const out = healthWith().handler({}, { ...adminCtx, vaultBound: true } as CallerContext) as {
      memory?: MemoryBlock;
    };
    expect(out.memory).toBeUndefined();
  });

  it("is absent for an unauthenticated caller", () => {
    const out = healthWith().handler({}, base as CallerContext) as { memory?: MemoryBlock };
    expect(out.memory).toBeUndefined();
  });
});

describe("server_health memory boundary at the budget (GH #1433)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Pins rss_mb and over_budget to one comparison: rss exactly at the budget reads as not over,
  // one byte above reads as over with rss_mb one MB past the budget, one byte below reads as not
  // over with rss_mb still at the budget.
  const withRss = (rss: number) =>
    vi
      .spyOn(process, "memoryUsage")
      .mockReturnValue({ rss, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 });

  it("rss exactly at the budget is not over_budget and rss_mb equals the budget", () => {
    withRss(100 * MIB);
    expect(memoryOf(100)).toEqual({
      rss_mb: 100,
      external_mb: 0,
      budget_mb: 100,
      over_budget: false,
    });
  });

  it("rss one byte above the budget is over_budget and rss_mb reads one MB past it", () => {
    withRss(100 * MIB + 1);
    expect(memoryOf(100)).toEqual({
      rss_mb: 101,
      external_mb: 0,
      budget_mb: 100,
      over_budget: true,
    });
  });

  it("rss one byte below the budget is not over_budget and rss_mb still reads the budget", () => {
    withRss(100 * MIB - 1);
    expect(memoryOf(100)).toEqual({
      rss_mb: 100,
      external_mb: 0,
      budget_mb: 100,
      over_budget: false,
    });
  });
});
