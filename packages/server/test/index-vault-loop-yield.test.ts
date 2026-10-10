// A reconcile pass must hand the event loop back while it works, or a `tools/call` and a SIGTERM
// that arrive mid-pass wait for the whole pass (minutes on a 20 000-note vault with a serving
// embedder). The yield is gated on the abort signal, which only the boot reconcile passes.
import { describe, expect, it } from "vitest";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { createLoopYielder } from "../src/search/indexing/loop-yield";
import { buildRepresentationManifest } from "../src/search/representation";
import { makeM2Vault } from "./m2-helpers";

describe("createLoopYielder", () => {
  it("takes a macrotask turn every N calls, and only when a signal is present", async () => {
    let turns = 0;
    const tick = setInterval(() => turns++, 0);
    try {
      const unsignaled = createLoopYielder(undefined, 2);
      for (let i = 0; i < 100; i++) await unsignaled();
      expect(turns).toBe(0); // microtasks only: no timer ever ran

      const signaled = createLoopYielder(new AbortController().signal, 2);
      for (let i = 0; i < 100; i++) await signaled();
      expect(turns).toBeGreaterThan(0);
    } finally {
      clearInterval(tick);
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
      let turns = 0;
      const tick = setInterval(() => turns++, 0);
      try {
        const stats = await indexVault(args);
        expect(stats.notes_seen).toBe(200);
      } finally {
        clearInterval(tick);
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
