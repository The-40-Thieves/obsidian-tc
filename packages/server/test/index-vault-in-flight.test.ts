// THE-645: end-to-end wiring of index_vault's in-flight progress into get_index_status — mirrors
// runtime/tool-wiring.ts's wireDomainTools/wireHealthTools wiring (onProgress sets indexHealth's
// in-flight entry; onIndexVaultComplete/onIndexVaultError both clear it) so a real registry dispatch
// of index_vault, observed concurrently through a real registry dispatch of get_index_status,
// exercises the exact wiring production uses rather than a hand-fed value.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import {
  deterministicVector,
  type EmbeddingProvider,
  fakeEmbeddingProvider,
} from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { buildRepresentationManifest } from "../src/search/representation";
import { createIndexStatusTool, type IndexInFlightInfo } from "../src/tools/admin/health";
import { registerM2Tools } from "../src/tools/m2";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeM2Vault } from "./m2-helpers";
import { rmTemp } from "./tmp";

/** A deferred promise the test releases by hand, to hold a provider call mid-flight (mirrors
 *  test/index-coordinator.test.ts's helper). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Dispatch's full pipeline (parse/auth/scope/ACL/idempotency/throttle gates, then the handler's
 *  own synchronous walk of 100+ notes) runs across many chained microtask hops before the first
 *  gated provider.embed() call is even reached — empirically ~100-130 `Promise.resolve()` ticks
 *  for this fixture, not a handful. Polling a real condition with a generous bound is what makes
 *  this robust rather than tuned to one measured number. */
async function pollUntil(predicate: () => boolean, maxIters = 5000): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`pollUntil: condition not met within ${maxIters} microtask ticks`);
}

/** Two REAL vaults sharing one registry/db/provider (mirrors production: `M2Deps.embeddingProvider`
 *  is one instance shared across every vault dispatch goes through — the overlap bug lives exactly
 *  here, since `IndexHealthState.inFlight` is likewise one shared slot). Deliberately NOT
 *  `makeM2Vault` (single-vault only) — the overlap scenario needs two independent roots dispatched
 *  through the SAME `ToolRegistry`. */
function makeTwoVaultHarness(
  files: { a: Record<string, string>; b: Record<string, string> },
  provider: EmbeddingProvider,
  hooks: {
    onProgress: (
      vaultId: string,
      p: { notesSeen: number; notesProcessed: number; chunksUpserted: number; startedAt: number },
    ) => void;
    onIndexVaultComplete: (vaultId: string) => void;
    onIndexVaultError: (vaultId: string) => void;
  },
): {
  call(name: string, input: Record<string, unknown>): Promise<ToolResult>;
  cleanup(): void;
} {
  const writeAll = (root: string, entries: Record<string, string>): void => {
    for (const [rel, content] of Object.entries(entries)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  };
  const rootA = mkdtempSync(join(tmpdir(), "obtc-inflight-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "obtc-inflight-b-"));
  writeAll(rootA, files.a);
  writeAll(rootB, files.b);

  const db = openMemoryDb();
  provisionCacheDb(db);
  const vaultRegistry = new VaultRegistry([
    { id: "va", path: rootA },
    { id: "vb", path: rootB },
  ]);
  const registry = new ToolRegistry();
  registerM2Tools(registry, {
    vaultRegistry,
    embeddingProvider: provider,
    representation: buildRepresentationManifest(provider, {}),
    onProgress: hooks.onProgress,
    onIndexVaultComplete: (vaultId) => hooks.onIndexVaultComplete(vaultId),
    onIndexVaultError: hooks.onIndexVaultError,
  });
  const ctx: CallerContext = {
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "va",
    db,
  };
  return {
    call: (name, input) => registry.dispatch(name, input, ctx),
    cleanup: () => {
      rmTemp(rootA);
      rmTemp(rootB);
    },
  };
}

describe("index_vault in-flight progress -> get_index_status (THE-645)", () => {
  it("a concurrent get_index_status call mid-run observes growing progress, cleared on completion", async () => {
    // DEFAULT_BATCH_MAX_NOTES is 100 (index-vault.ts) — 120 notes forces exactly two flush()
    // batches (100, then 20), so there is a real window between the first batch's onProgress and
    // the run's completion in which in_flight is non-zero but not yet final.
    const files: Record<string, string> = {};
    for (let i = 0; i < 120; i++) files[`n${i}.md`] = `note number ${i} unique body text`;

    let embedCalls = 0;
    const gate = deferred();
    const provider = {
      ...fakeEmbeddingProvider({ dimensions: 8 }),
      embed: async (texts: string[]): Promise<number[][]> => {
        embedCalls += 1;
        if (embedCalls === 2) await gate.promise; // pause the SECOND (final) batch's embed
        return texts.map((t) => deterministicVector(t, 8));
      },
    };

    let inFlight: IndexInFlightInfo | null = null;
    const v = makeM2Vault({
      files,
      provider,
      onProgress: (vaultId, p) => {
        inFlight = { vault: vaultId, ...p };
      },
      // THE-645 (adversarial review fix): guarded on ownership, mirroring
      // runtime/tool-wiring.ts's wireDomainTools exactly — a single-vault test never exercises the
      // guard's branch, but keeping the SAME shape here is what makes this file's "mirrors
      // production wiring" claim true. See the overlap tests below for the guard itself.
      onIndexVaultComplete: (vaultId) => {
        if (inFlight?.vault === vaultId) inFlight = null;
      },
      onIndexVaultError: (vaultId) => {
        if (inFlight?.vault === vaultId) inFlight = null;
      },
    });
    v.registry.register(
      createIndexStatusTool({
        vecEnabled: false,
        ftsEnabled: false,
        getIndexHealth: () => ({ reconcile: "ok", reconcile_at: 1, write_failures: 0 }),
        getLastChunksUpserted: () => null,
        getInFlightProgress: () => inFlight,
      }),
    );

    try {
      const runPromise = v.call("index_vault", { vault: v.id });
      // First batch (100 notes) has committed and reported progress; the second batch's embed()
      // call is parked on the gate, so the run is genuinely still in flight here.
      await pollUntil(() => embedCalls >= 2);
      const midStatus = await v.call("get_index_status", {});
      expect(midStatus.ok).toBe(true);
      const midData = (midStatus.ok ? midStatus.data : {}) as { in_flight?: IndexInFlightInfo };
      expect(midData.in_flight).toBeDefined();
      expect(midData.in_flight?.notesProcessed).toBeGreaterThan(0);
      expect(midData.in_flight?.notesProcessed).toBeLessThan(120);
      expect(midData.in_flight?.chunksUpserted).toBeGreaterThan(0);

      gate.resolve();
      const res = await runPromise;
      expect(res.ok).toBe(true);

      const finalStatus = await v.call("get_index_status", {});
      const finalData = (finalStatus.ok ? finalStatus.data : {}) as {
        in_flight?: IndexInFlightInfo;
      };
      expect(finalData.in_flight).toBeUndefined();
    } finally {
      v.cleanup();
    }
  });

  it("get_index_status shows in_flight cleared, not stuck, after index_vault rejects", async () => {
    const files = { "a.md": "alpha", "b.md": "bravo" };
    const provider = {
      ...fakeEmbeddingProvider({ dimensions: 8 }),
      embed: async (): Promise<number[][]> => {
        throw new Error("boom — provider outage");
      },
    };

    let inFlight: IndexInFlightInfo | null = null;
    const v = makeM2Vault({
      files,
      provider,
      onProgress: (vaultId, p) => {
        inFlight = { vault: vaultId, ...p };
      },
      // THE-645 (adversarial review fix): guarded on ownership, mirroring
      // runtime/tool-wiring.ts's wireDomainTools exactly — a single-vault test never exercises the
      // guard's branch, but keeping the SAME shape here is what makes this file's "mirrors
      // production wiring" claim true. See the overlap tests below for the guard itself.
      onIndexVaultComplete: (vaultId) => {
        if (inFlight?.vault === vaultId) inFlight = null;
      },
      onIndexVaultError: (vaultId) => {
        if (inFlight?.vault === vaultId) inFlight = null;
      },
    });
    v.registry.register(
      createIndexStatusTool({
        vecEnabled: false,
        ftsEnabled: false,
        getIndexHealth: () => ({ reconcile: "ok", reconcile_at: 1, write_failures: 0 }),
        getLastChunksUpserted: () => null,
        getInFlightProgress: () => inFlight,
      }),
    );

    try {
      const res = await v.call("index_vault", { vault: v.id });
      // The embed provider always throws, so the dispatch surfaces an error result — never a
      // stuck in_flight entry.
      expect(res.ok).toBe(false);

      const status = await v.call("get_index_status", {});
      const data = (status.ok ? status.data : {}) as { in_flight?: IndexInFlightInfo };
      expect(data.in_flight).toBeUndefined();
    } finally {
      v.cleanup();
    }
  });

  // Adversarial review CONFIRMED bug: `inFlight` is a single shared slot, and dispatch has no
  // cross-call serialization, so two index_vault calls on DIFFERENT vaults can genuinely overlap.
  // The original wiring cleared the slot unconditionally in both onIndexVaultComplete and
  // onIndexVaultError, so vault B finishing WHILE vault A was still mid-run nulled A's still-valid
  // entry out from under it. The fix guards both clear sites on `inFlight?.vault === vaultId`. Both
  // cases below construct vault B so it settles (completes or rejects) WITHOUT ever calling
  // onProgress for "vb" — an empty vault never reaches flush()'s non-empty-batch onProgress call,
  // and a rejecting embed() throws inside flush() before it reaches that same call — isolating the
  // assertion to the clear-site guard itself, not to onProgress's ordinary last-writer-wins
  // overwrite (which is the OTHER, intentional, documented consequence of one shared slot).
  describe("two vaults can genuinely overlap — the single in_flight slot is guarded by ownership", () => {
    it("vault B completing does not clear vault A's still-running entry", async () => {
      const filesA: Record<string, string> = {};
      for (let i = 0; i < 120; i++) filesA[`n${i}.md`] = `note ${i} VAULTA_MARKER unique body`;

      let aEmbedCalls = 0;
      const gateA2 = deferred();
      const provider: EmbeddingProvider = {
        ...fakeEmbeddingProvider({ dimensions: 8 }),
        embed: async (texts: string[]): Promise<number[][]> => {
          if (texts.some((t) => t.includes("VAULTA_MARKER"))) {
            aEmbedCalls += 1;
            if (aEmbedCalls === 2) await gateA2.promise; // pause A's SECOND (final) batch
          }
          return texts.map((t) => deterministicVector(t, 8));
        },
      };

      // A boxed ref, not a bare `let` — TS's closure-narrowing otherwise infers a
      // too-specific type for a `let` reassigned only inside callbacks stored (not called
      // synchronously) by makeTwoVaultHarness, which surfaced as a false `never` on read.
      const state: { inFlight: IndexInFlightInfo | null } = { inFlight: null };
      const h = makeTwoVaultHarness(
        { a: filesA, b: {} }, // b: an EMPTY vault — flush()'s trailing call sees an empty batch
        // and returns before ever calling onProgress, so "vb" never touches the slot on its own.
        provider,
        {
          onProgress: (vaultId, p) => {
            state.inFlight = { vault: vaultId, ...p };
          },
          onIndexVaultComplete: (vaultId) => {
            if (state.inFlight?.vault === vaultId) state.inFlight = null;
          },
          onIndexVaultError: (vaultId) => {
            if (state.inFlight?.vault === vaultId) state.inFlight = null;
          },
        },
      );

      try {
        const runA = h.call("index_vault", { vault: "va" });
        // A's first batch (100 notes) has committed and reported progress (slot = "va"); its
        // second batch's embed() is parked on gateA2, so A is genuinely still in flight.
        await pollUntil(() => aEmbedCalls >= 2);
        expect(state.inFlight?.vault).toBe("va");
        const aProgressBeforeB = state.inFlight?.notesProcessed;

        // Vault B runs to completion WHILE A is still mid-run. Pre-fix, B's completion cleared
        // the slot unconditionally; post-fix, the guard sees inFlight.vault ("va") !== "vb" and
        // leaves it alone.
        const resB = await h.call("index_vault", { vault: "vb" });
        expect(resB.ok).toBe(true);
        expect(state.inFlight?.vault).toBe("va");
        expect(state.inFlight?.notesProcessed).toBe(aProgressBeforeB);

        gateA2.resolve();
        const resA = await runA;
        expect(resA.ok).toBe(true);
        // A's OWN completion owns the slot and clears it correctly.
        expect(state.inFlight).toBeNull();
      } finally {
        h.cleanup();
      }
    });

    it("vault B rejecting does not clear vault A's still-running entry", async () => {
      const filesA: Record<string, string> = {};
      for (let i = 0; i < 120; i++) filesA[`n${i}.md`] = `note ${i} VAULTA_MARKER unique body`;
      const filesB = { "b.md": "VAULTB_REJECT_MARKER reject me" };

      let aEmbedCalls = 0;
      const gateA2 = deferred();
      const provider: EmbeddingProvider = {
        ...fakeEmbeddingProvider({ dimensions: 8 }),
        embed: async (texts: string[]): Promise<number[][]> => {
          if (texts.some((t) => t.includes("VAULTB_REJECT_MARKER"))) {
            // Throws INSIDE flush()'s embedPlans() await, before flush() ever reaches its
            // onProgress call — "vb" never touches the slot on its own, same as the empty-vault
            // case above, just via the error path instead of the empty-batch path.
            throw new Error("boom — provider outage (vault B)");
          }
          if (texts.some((t) => t.includes("VAULTA_MARKER"))) {
            aEmbedCalls += 1;
            if (aEmbedCalls === 2) await gateA2.promise;
          }
          return texts.map((t) => deterministicVector(t, 8));
        },
      };

      const state: { inFlight: IndexInFlightInfo | null } = { inFlight: null };
      const h = makeTwoVaultHarness({ a: filesA, b: filesB }, provider, {
        onProgress: (vaultId, p) => {
          state.inFlight = { vault: vaultId, ...p };
        },
        onIndexVaultComplete: (vaultId) => {
          if (state.inFlight?.vault === vaultId) state.inFlight = null;
        },
        onIndexVaultError: (vaultId) => {
          if (state.inFlight?.vault === vaultId) state.inFlight = null;
        },
      });

      try {
        const runA = h.call("index_vault", { vault: "va" });
        await pollUntil(() => aEmbedCalls >= 2);
        expect(state.inFlight?.vault).toBe("va");

        const resB = await h.call("index_vault", { vault: "vb" });
        expect(resB.ok).toBe(false); // the provider always rejects for vault B
        expect(state.inFlight?.vault).toBe("va"); // A's entry survives B's rejection

        gateA2.resolve();
        const resA = await runA;
        expect(resA.ok).toBe(true);
        expect(state.inFlight).toBeNull();
      } finally {
        h.cleanup();
      }
    });
  });
});
