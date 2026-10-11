// A reconcile pass must hand the event loop back while it works, or a `tools/call` and a SIGTERM
// that arrive mid-pass wait for the whole pass (minutes on a 20 000-note vault with a serving
// embedder). The yield is gated on the abort signal, which only the boot reconcile passes.
import { describe, expect, it } from "vitest";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { createSliceYielder } from "../src/util/scan-steps";
import { makeM2Vault } from "./m2-helpers";

describe("createSliceYielder", () => {
  it("takes a macrotask turn once a time slice is used up, and only when a signal is present", async () => {
    // Count check-phase turns with a self-rearming setImmediate, not a 0 ms interval: Windows timers
    // tick every ~15 ms, so 50 forced turns can all finish before an interval is ever due.
    let turns = 0;
    let handle = setImmediate(function tick() {
      turns++;
      handle = setImmediate(tick);
    });
    try {
      const unsignaled = createSliceYielder(undefined, 0);
      for (let i = 0; i < 100; i++) await unsignaled();
      expect(turns).toBe(0); // microtasks only: the loop never reached a check phase

      const signaled = createSliceYielder(new AbortController().signal, 0);
      for (let i = 0; i < 100; i++) await signaled();
      expect(turns).toBeGreaterThan(0);

      // The trigger is elapsed time, not a call count: a slice that is never used up never yields.
      turns = 0;
      const roomy = createSliceYielder(new AbortController().signal, 60_000);
      for (let i = 0; i < 100; i++) await roomy();
      expect(turns).toBe(0);
    } finally {
      clearImmediate(handle);
    }
  });
});

describe("indexVault with an abort signal (boot reconcile)", () => {
  // The SECOND pass over an unchanged vault embeds nothing, so the only checkpoint left is the
  // per-note one (embed-batches.ts's own yield never runs).
  const secondPassTurns = async (signal: AbortSignal | undefined): Promise<number> => {
    const files = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`n${i}.md`, `note ${i} body text`]),
    );
    const v = makeM2Vault({ files });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const args = {
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
        ...(signal ? { signal } : {}),
      };
      await indexVault(args);
      // Count check-phase turns with a self-rearming setImmediate (see above).
      let turns = 0;
      let handle = setImmediate(function tick() {
        turns++;
        handle = setImmediate(tick);
      });
      try {
        const stats = await indexVault(args);
        expect(stats.notes_seen).toBe(200);
      } finally {
        clearImmediate(handle);
      }
      return turns;
    } finally {
      v.cleanup();
    }
  };

  it("lets timers run during an all-unchanged pass", async () => {
    expect(await secondPassTurns(new AbortController().signal)).toBeGreaterThan(0);
  });

  it("keeps the no-signal path free of forced turns", async () => {
    expect(await secondPassTurns(undefined)).toBe(0);
  });
});
