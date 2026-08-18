// THE-491 item 2: get_index_status — a thin, named, agent-discoverable reader over the same
// index-health state server_health exposes, plus chunks_upserted from the last index_vault
// call, so an agent can self-diagnose the search index before paying for an expensive search.
import { describe, expect, it } from "vitest";
import type { CallerContext } from "../src/mcp/registry";
import { createIndexStatusTool, type IndexStatusInfo } from "../src/tools/admin/health";

describe("get_index_status (THE-491)", () => {
  const base = {
    caller: null,
    authenticated: false,
    grantedScopes: new Set<string>(),
    vaultId: "v1",
    db: {} as never,
  } satisfies Partial<CallerContext>;

  it("reports the index-health fields verbatim, unauthenticated (scope-free, like server_health)", () => {
    const tool = createIndexStatusTool({
      vecEnabled: true,
      ftsEnabled: true,
      getIndexHealth: () => ({
        reconcile: "ok",
        reconcile_at: 123,
        write_failures: 3,
        notes_ready: true,
      }),
      getLastChunksUpserted: () => 42,
    });
    expect(tool.requiredScopes).toEqual([]);
    const out = tool.handler({}, base as CallerContext) as IndexStatusInfo;
    expect(out).toEqual({
      reconcile: "ok",
      reconcile_at: 123,
      write_failures: 3,
      notes_ready: true,
      vec_enabled: true,
      fts_enabled: true,
      chunks_upserted: 42,
    });
  });

  it("reports chunks_upserted as null before any index_vault call this process", () => {
    const tool = createIndexStatusTool({
      vecEnabled: false,
      ftsEnabled: false,
      getIndexHealth: () => ({
        reconcile: "pending",
        reconcile_at: null,
        write_failures: 0,
        notes_ready: false,
      }),
      getLastChunksUpserted: () => null,
    });
    const out = tool.handler({}, base as CallerContext) as IndexStatusInfo;
    expect(out.chunks_upserted).toBeNull();
    expect(out.reconcile).toBe("pending");
    expect(out.reconcile_at).toBeNull();
  });

  it("defaults notes_ready to false when the snapshot omits it", () => {
    const tool = createIndexStatusTool({
      vecEnabled: false,
      ftsEnabled: false,
      getIndexHealth: () => ({
        reconcile: "ok",
        reconcile_at: 1,
        write_failures: 0,
      }),
      getLastChunksUpserted: () => null,
    });
    const out = tool.handler({}, base as CallerContext) as IndexStatusInfo;
    expect(out.notes_ready).toBe(false);
  });

  it("THE-645: omits in_flight when no index_vault call is currently running", () => {
    const tool = createIndexStatusTool({
      vecEnabled: true,
      ftsEnabled: true,
      getIndexHealth: () => ({
        reconcile: "ok",
        reconcile_at: 123,
        write_failures: 0,
        notes_ready: true,
      }),
      getLastChunksUpserted: () => 42,
      getInFlightProgress: () => null,
    });
    const out = tool.handler({}, base as CallerContext) as IndexStatusInfo;
    expect(out.in_flight).toBeUndefined();
    expect("in_flight" in out).toBe(false);
  });

  it("THE-645: reports in_flight progress verbatim while an index_vault call is running", () => {
    const tool = createIndexStatusTool({
      vecEnabled: true,
      ftsEnabled: true,
      getIndexHealth: () => ({
        reconcile: "ok",
        reconcile_at: 123,
        write_failures: 0,
        notes_ready: true,
      }),
      getLastChunksUpserted: () => 42,
      getInFlightProgress: () => ({
        vault: "v1",
        notesSeen: 100,
        notesProcessed: 30,
        chunksUpserted: 120,
        startedAt: 1_700_000_000_000,
      }),
    });
    const out = tool.handler({}, base as CallerContext) as IndexStatusInfo;
    expect(out.in_flight).toEqual({
      vault: "v1",
      notesSeen: 100,
      notesProcessed: 30,
      chunksUpserted: 120,
      startedAt: 1_700_000_000_000,
    });
  });

  it("THE-645: omits in_flight when getInFlightProgress is not wired at all (back-compat)", () => {
    const tool = createIndexStatusTool({
      vecEnabled: true,
      ftsEnabled: true,
      getIndexHealth: () => ({
        reconcile: "ok",
        reconcile_at: 123,
        write_failures: 0,
        notes_ready: true,
      }),
      getLastChunksUpserted: () => 42,
    });
    const out = tool.handler({}, base as CallerContext) as IndexStatusInfo;
    expect(out.in_flight).toBeUndefined();
  });

  it("never includes a `detail` sub-object (unlike server_health's authenticated payload)", () => {
    const tool = createIndexStatusTool({
      vecEnabled: false,
      ftsEnabled: false,
      getIndexHealth: () => ({
        reconcile: "degraded",
        reconcile_at: 1,
        write_failures: 5,
        notes_ready: true,
      }),
      getLastChunksUpserted: () => 7,
    });
    const out = tool.handler({}, {
      ...base,
      authenticated: true,
    } as CallerContext) as unknown as Record<string, unknown>;
    expect(out.detail).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(
      [
        "chunks_upserted",
        "fts_enabled",
        "notes_ready",
        "reconcile",
        "reconcile_at",
        "vec_enabled",
        "write_failures",
      ].sort(),
    );
  });
});
