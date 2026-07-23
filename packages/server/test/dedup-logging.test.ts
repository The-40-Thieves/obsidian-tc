// THE-499: indexing emitted ~1 stderr line per duplicate chunk. Synchronous terminal/file logging
// can cost more than the dedup itself and pollutes CI logs. Replace the per-item lines with a single
// aggregate per index pass; keep individual paths only behind a debug env.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { makeM2Vault } from "./m2-helpers";

// Two notes with an IDENTICAL body -> same content_hash -> the second is dedup-skipped (its vector is
// copied from the first, not recomputed).
function dupVault() {
  const body = "# H\n\nthe exact same paragraph of content appears in both of these notes verbatim";
  return makeM2Vault({
    files: { "a.md": body, "b.md": body },
    provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OBSIDIAN_TC_DEBUG_DEDUP;
});

describe("THE-499 aggregate dedup logging", () => {
  it("emits no per-duplicate line on a normal pass, and counts the reuse in stats", async () => {
    const v = dupVault();
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const stats = await indexVault({
      db: v.db,
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });

    // no per-chunk dedup line
    expect(writes.some((w) => /embed-text dedup:.*reuses/.test(w))).toBe(false);
    // the reuse is counted
    expect(stats.chunks_dedup_reused).toBeGreaterThan(0);
    v.cleanup();
  });

  it("exposes individual paths behind OBSIDIAN_TC_DEBUG_DEDUP", async () => {
    process.env.OBSIDIAN_TC_DEBUG_DEDUP = "1";
    const v = dupVault();
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await indexVault({
      db: v.db,
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });

    expect(writes.some((w) => /dedup/.test(w))).toBe(true);
    v.cleanup();
  });
});
