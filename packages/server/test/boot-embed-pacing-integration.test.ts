// GH #995 follow-up — end-to-end responsiveness bound: after #996-#999 fixed thread caps,
// abortability, one-leader-per-vault and sticky-provider, the leader's boot/promotion reconcile
// still ran its embed pass at full speed the instant it started, competing with interactive tool
// calls for the CPU-bound in-process embed step. This proves the fix through the REAL runtime
// pieces wired together — the actual MCP dispatch pipeline (mcp/registry.ts's ToolRegistry,
// exercised over a real MCP Client/Server pair via InMemoryTransport, exactly like
// mcp-roundtrip.test.ts), the real process-wide dispatch counter (workspace/sessions.ts), and the
// real `waitForIdle`/`serializeAdmission` pacing primitives (search/indexing/embed-pace.ts) —
// driving a synthetic embedPlans() pass with a SYNCHRONOUS busy-spin stub provider, the same shape
// shutdown-boot-embed.test.ts uses to reproduce the in-process ONNX/native embed step (a call that
// occupies the JS thread for its whole duration, no macrotask in between).
//
// Fix round (Codex review on #1003, LOW finding 4a): every test below drives the pacing through
// `createReconcileRunner` (runtime/plane-wiring.ts) itself — the actual production composition
// (indexing.backgroundEmbed's mode/idleMs/maxDeferMs -> embedPace, over the real, private
// `dispatchIdleGate`) — rather than hand-recreating an "equivalent" gate/pace closure here. The
// prior version reconstructed a gate that MIRRORED the private one by hand; that could pass while
// the real wiring in plane-wiring.ts silently diverged (wrong idleMs threading, a gate built over
// the wrong counter, a missing serializeAdmission wrap), and nothing here would have caught it.
//
// Deliberately NOT a full buildServerRuntime()/spawned-CLI harness (shutdown-boot-embed.test.ts's
// own pattern): standing up the whole boot reconcile end to end adds vault-walk/DB/representation
// machinery this feature does not touch. `minimalDeps` below supplies just enough
// ReconcileRunnerDeps for createReconcileRunner to run its real embedPace-construction logic and
// call a stub `indexVaultRecorded` that runs a synthetic embedPlans() pass with it — the
// composition-level "does indexing.backgroundEmbed reach IndexVaultArgs.embedPace in the right
// shape" question is separately pinned in plane-wiring-reconcile-mapping.test.ts; what is unique to
// THIS file is that pacing an embed pass through the REAL runner keeps a concurrent tool call
// responsive, not merely that the wiring compiles.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { EmbeddingProvider } from "../src/embeddings/provider";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { createReconcileRunner, type ReconcileRunnerDeps } from "../src/runtime/plane-wiring";
import type { IndexStats, IndexVaultArgs } from "../src/search/indexer";
import { embedPlans } from "../src/search/indexer";

/** A stub EmbeddingProvider whose embed() is SYNCHRONOUS busy-work — matching the in-process
 *  ONNX/native shape (a call that occupies the JS thread for its whole duration, resolving with no
 *  macrotask in between). See shutdown-boot-embed.test.ts's own stub for the same rationale. */
function busySpinProvider(busyMs: number): EmbeddingProvider {
  return {
    id: "busy-spin",
    provider: "busy-spin",
    model: "busy-spin-v1",
    dimensions: 4,
    embed: async (texts: string[]): Promise<number[][]> => {
      const until = Date.now() + busyMs;
      while (Date.now() < until) {
        // busy-spin
      }
      return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
    },
  };
}

function planOf(contents: string[]) {
  return { toEmbed: contents.map((content) => ({ content })), vectors: [] as number[][] } as never;
}

/** A tool whose handler needs several REAL macrotask turns (not just microtasks) to complete —
 *  the shape that actually contends with the reconcile worker loop's own setImmediate-based yield
 *  between sub-batches (embed-batches.ts). */
function slowTool(ticks: number): ToolDefinition {
  return {
    name: "slow_tool",
    description: "test tool needing several event-loop turns",
    inputSchema: z.object({}).strict(),
    requiredScopes: [],
    handler: async () => {
      for (let i = 0; i < ticks; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return { ok: true };
    },
  } as unknown as ToolDefinition;
}

async function connectClient(registry: ToolRegistry) {
  // No sessionId — the common stdio case with no explicit start_session (the exact gap that made
  // workspace/sessions.ts's session-scoped inFlightCounts the WRONG signal to reuse; see
  // markDispatchActive's own doc comment).
  const context = (): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db: {} as never,
  });
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return client;
}

/** A clean IndexStats, matching plane-wiring-reconcile-mapping.test.ts's own helper shape. */
function cleanStats(): IndexStats {
  return {
    notes_seen: 0,
    notes_indexed: 0,
    chunks_upserted: 0,
    chunks_deleted: 0,
    chunks_unchanged: 0,
    edges_inserted: 0,
    edges_deleted: 0,
    secrets_skipped: 0,
    vec_enabled: true,
    fts_enabled: true,
    notes_upserted: 0,
    notes_deleted: 0,
    notes_embed_failed: 0,
    chunks_dedup_reused: 0,
    chunks_dedup_unresolved: 0,
    embed_batch_rejections: 0,
    notes_stale_skipped: 0,
    notes_frontmatter_failed: 0,
    frontmatter_failures: [],
    model: "fake",
    dimensions: 4,
  };
}

/** Real `createReconcileRunner` deps, minimal everywhere except `backgroundEmbed` (under test) and
 *  `indexVaultRecorded`, which each vault's real Promise.all'd pass below calls with the REAL
 *  `embedPace` closure createReconcileRunner constructed — running a synthetic embedPlans() pass
 *  with it, at the given provider/concurrency, exactly like index-vault.ts's own flush() would. */
function reconcileDeps(opts: {
  vaultIds: string[];
  backgroundEmbed: ReconcileRunnerDeps["backgroundEmbed"];
  provider: EmbeddingProvider;
  concurrency: number;
  chunksPerVault: number;
}): ReconcileRunnerDeps {
  return {
    vaults: opts.vaultIds.map((id) => ({ id, path: `/tmp/${id}` })) as never,
    db: {} as never,
    embeddingProvider: {} as never,
    embedConfig: { batchSize: 1, concurrency: opts.concurrency, maxBatchTokens: 999_999 },
    chunkContext: false,
    representation: {} as never,
    densify: {} as never,
    vaultRegistry: { resolve: (id: string) => ({ id, root: `/tmp/${id}` }) } as never,
    indexReadableFor: () => () => true,
    sqlHooksFor: () => ({}) as never,
    onVecRebuild: () => {},
    makeOnIndexed: () => undefined,
    indexHealth: { reconcile: "pending", reconcileAt: null, reconcileErrors: [] } as never,
    streamingWalk: false,
    backgroundEmbed: opts.backgroundEmbed,
    // Stub indexVaultRecorded: runs a real embedPlans() sub-batch pass, using the REAL embedPace
    // this runner constructed (opts.embedPace) — the same shape index-vault.ts's own flush() call
    // takes (embed-batches.ts's embedPlans, not a hand-rolled substitute).
    indexVaultRecorded: async (vaultOpts: IndexVaultArgs): Promise<IndexStats> => {
      const chunks = Array.from(
        { length: opts.chunksPerVault },
        (_, i) => `${vaultOpts.vaultId}-chunk-${i}`,
      );
      await embedPlans(
        opts.provider,
        [planOf(chunks)],
        1,
        opts.concurrency,
        999_999,
        vaultOpts.signal,
        vaultOpts.embedPace,
      );
      return cleanStats();
    },
    roles: null,
    jobRunner: {} as never,
  };
}

const BUSY_MS = 120;
const IDLE_MS = 100;
// Relative, not absolute (fix round, LOW finding 4c): every bound below is expressed as a multiple
// of BUSY_MS/IDLE_MS — the provider's own configured busy-spin duration, the unit a paced call's
// real cost scales from — rather than a bare millisecond literal that would need re-tuning (or
// flake) if the busy-spin duration or CI load ever changed independently of the bound.
const SINGLE_BATCH_MARGIN_MS = BUSY_MS * 2 + IDLE_MS + 200;

describe("GH #995 follow-up — boot embed pacing keeps a concurrent tool call responsive (fix round: production wiring)", () => {
  it("idle-mode pacing (1 vault, concurrency 1): a tool call issued during the embed pass completes within ~1 sub-batch", async () => {
    const registry = new ToolRegistry();
    registry.register(slowTool(12));
    const client = await connectClient(registry);

    const deps = reconcileDeps({
      vaultIds: ["v1"],
      backgroundEmbed: { mode: "idle", idleMs: IDLE_MS, maxDeferMs: 30_000 },
      provider: busySpinProvider(BUSY_MS),
      concurrency: 1,
      chunksPerVault: 12,
    });
    const runner = createReconcileRunner(deps);
    const reconcile = runner(new AbortController().signal); // fire-and-forget, like server-runtime.ts's start()

    const start = Date.now();
    const res = await client.callTool({ name: "slow_tool", arguments: {} });
    const elapsed = Date.now() - start;

    expect(res.isError).toBeFalsy();
    expect(elapsed).toBeLessThan(SINGLE_BATCH_MARGIN_MS);
    await reconcile;
  }, 20_000);

  it("WITHOUT pacing (mode immediate, matching every call site before GH #995 follow-up): the same call misses the bound", async () => {
    const registry = new ToolRegistry();
    registry.register(slowTool(12));
    const client = await connectClient(registry);

    const deps = reconcileDeps({
      vaultIds: ["v1"],
      backgroundEmbed: { mode: "immediate", idleMs: IDLE_MS, maxDeferMs: 30_000 },
      provider: busySpinProvider(BUSY_MS),
      concurrency: 1,
      chunksPerVault: 12,
    });
    const runner = createReconcileRunner(deps);
    const reconcile = runner(new AbortController().signal);

    const start = Date.now();
    const res = await client.callTool({ name: "slow_tool", arguments: {} });
    const elapsed = Date.now() - start;

    expect(res.isError).toBeFalsy();
    // Relative to the pass's own total unpaced cost (12 sub-batches * BUSY_MS), not a bare literal
    // — it should take at least half of that to hand back a dispatch turn with no pacing at all.
    expect(elapsed).toBeGreaterThanOrEqual((12 * BUSY_MS) / 2);
    await reconcile;
  }, 20_000);

  // Fix round (Codex review on #1003, HIGH finding 2): production default concurrency (4) and 2
  // vaults, both racing the SAME idle check via the real, shared, process-wide embedPace closure.
  // Before serializeAdmission, up to concurrency(4) x vaults(2) = 8 sub-batches could pass the gate
  // in one microtask burst, so a concurrent dispatch could wait up to ~8x a single sub-batch's
  // duration instead of ~1x.
  it("idle-mode pacing at PRODUCTION default concurrency (4) with 2 vaults: a concurrent tool call still gets a dispatch turn within ~1 sub-batch duration", async () => {
    const registry = new ToolRegistry();
    registry.register(slowTool(12));
    const client = await connectClient(registry);

    const deps = reconcileDeps({
      vaultIds: ["v1", "v2"],
      backgroundEmbed: { mode: "idle", idleMs: IDLE_MS, maxDeferMs: 30_000 },
      provider: busySpinProvider(BUSY_MS),
      concurrency: 4, // packages/shared's EMBED_CONCURRENCY production default
      chunksPerVault: 8,
    });
    const runner = createReconcileRunner(deps);
    const reconcile = runner(new AbortController().signal);

    const start = Date.now();
    const res = await client.callTool({ name: "slow_tool", arguments: {} });
    const elapsed = Date.now() - start;

    expect(res.isError).toBeFalsy();
    // The bound is the SAME order of magnitude as the single-vault/concurrency-1 case above
    // (SINGLE_BATCH_MARGIN_MS) — it must not scale with concurrency x vaultCount. Without
    // serializeAdmission this assertion is the one that fails (elapsed approaches
    // concurrency*vaultCount*BUSY_MS instead).
    expect(elapsed).toBeLessThan(SINGLE_BATCH_MARGIN_MS);
    await reconcile;
  }, 20_000);
});
