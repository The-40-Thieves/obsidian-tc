// THE-486: does index_vault actually route to the DELTA path on a warm pass, and to the FULL path
// only on cold start / an empty-scope no-op? computeKnnEdges/computeKnnEdgesForPaths and
// tagCooccurrenceEdges/tagCooccurrenceEdgesForNotes are mocked so this file proves ROUTING, not
// numeric correctness (that's densify-delta-knn.test.ts / densify-delta-tags.test.ts) — same split
// densify-knn-floor.test.ts / densify-knn-wiring.test.ts already use for the kNN floor.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The full-recompute spies return ONE real edge (not []) — an always-empty mock would leave
// countDerivedEdges at 0 forever, permanently misreading every later pass as "cold start" too
// (a real vault with actual tags/embeddings would never stay edgeless like that).
const knnFullSpy = vi.hoisted(() =>
  vi.fn(() => [
    {
      source_path: "a.md",
      target_path: "b.md",
      edge_type: "similar_to" as const,
      edge_kind: "virtual" as const,
      provenance: "cosine_knn",
      confidence: 0.9,
      source_fingerprint: null,
    },
  ]),
);
const knnDeltaSpy = vi.hoisted(() =>
  vi.fn((_db: unknown, _vaultId: string, _scope: Set<string>, _opts?: unknown) => [] as never[]),
);
const tagFullSpy = vi.hoisted(() =>
  vi.fn(() => [
    {
      source_path: "a.md",
      target_path: "b.md",
      edge_type: "shared_tag" as const,
      edge_kind: "derived" as const,
      provenance: "tag_cooccur",
      confidence: null,
      source_fingerprint: null,
    },
  ]),
);
const tagDeltaSpy = vi.hoisted(() =>
  vi.fn((_notesTags: Map<string, string[]>, _scope: Set<string>, _opts?: unknown) => [] as never[]),
);

vi.mock("../src/search/derived-edges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/search/derived-edges")>();
  return {
    ...actual,
    computeKnnEdges: knnFullSpy,
    computeKnnEdgesForPaths: knnDeltaSpy,
    tagCooccurrenceEdges: tagFullSpy,
    tagCooccurrenceEdgesForNotes: tagDeltaSpy,
  };
});

const { indexVault } = await import("../src/search/indexer");
const { makeM2Vault } = await import("./m2-helpers");

function migratedVault(files: Record<string, string>): any {
  return makeM2Vault({ files });
}

describe("THE-486: index_vault routes cold-start vs delta densification", () => {
  beforeEach(() => {
    knnFullSpy.mockClear();
    knnDeltaSpy.mockClear();
    tagFullSpy.mockClear();
    tagDeltaSpy.mockClear();
  });

  it("cold start (no prior edges): uses the FULL recompute for both layers, never the delta path", async () => {
    const v = migratedVault({
      "a.md": "---\ntags: [ml]\n---\nalpha",
      "b.md": "---\ntags: [ml]\n---\nbeta",
    });
    await indexVault({
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { tagEdges: true, knnEdges: true },
    });
    expect(knnFullSpy).toHaveBeenCalledTimes(1);
    expect(knnDeltaSpy).not.toHaveBeenCalled();
    expect(tagFullSpy).toHaveBeenCalledTimes(1);
    expect(tagDeltaSpy).not.toHaveBeenCalled();
    v.cleanup();
  });

  it("warm pass, ZERO content/tag changes: calls NEITHER full nor delta for either layer", async () => {
    const v = migratedVault({
      "a.md": "---\ntags: [ml]\n---\nalpha",
      "b.md": "---\ntags: [ml]\n---\nbeta",
    });
    const args = {
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { tagEdges: true, knnEdges: true },
    };
    await indexVault(args); // cold start
    knnFullSpy.mockClear();
    knnDeltaSpy.mockClear();
    tagFullSpy.mockClear();
    tagDeltaSpy.mockClear();
    await indexVault(args); // warm, nothing changed on disk
    expect(knnFullSpy).not.toHaveBeenCalled();
    expect(knnDeltaSpy).not.toHaveBeenCalled();
    expect(tagFullSpy).not.toHaveBeenCalled();
    expect(tagDeltaSpy).not.toHaveBeenCalled();
    v.cleanup();
  });

  it("warm pass, ONE note's content changes: kNN routes to the DELTA path, not the full scan", async () => {
    const v = migratedVault({
      "a.md": "---\ntags: [ml]\n---\nalpha",
      "b.md": "---\ntags: [ml]\n---\nbeta",
    });
    const args = {
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { tagEdges: true, knnEdges: true },
    };
    await indexVault(args); // cold start
    knnFullSpy.mockClear();
    knnDeltaSpy.mockClear();
    v.write("a.md", "---\ntags: [ml]\n---\nalpha CHANGED");
    await indexVault(args);
    expect(knnFullSpy).not.toHaveBeenCalled();
    expect(knnDeltaSpy).toHaveBeenCalledTimes(1);
    // Scope is a.md itself PLUS b.md — the cold-start pass's knnFullSpy() planted a REAL a.md<->b.md
    // similar_to edge, so knnNeighborScope must pull b.md in too (neighbor invalidation).
    expect(knnDeltaSpy.mock.calls[0]?.[2]).toEqual(new Set(["a.md", "b.md"]));
    v.cleanup();
  });

  it("warm pass, ONE note's tags change (content unchanged): tags route to DELTA, kNN sees no change at all", async () => {
    const v = migratedVault({
      "a.md": "---\ntags: [ml]\n---\nalpha",
      "b.md": "---\ntags: [ml]\n---\nbeta",
    });
    const args = {
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { tagEdges: true, knnEdges: true },
    };
    await indexVault(args); // cold start
    knnFullSpy.mockClear();
    knnDeltaSpy.mockClear();
    tagFullSpy.mockClear();
    tagDeltaSpy.mockClear();
    v.write("a.md", "---\ntags: [rag]\n---\nalpha"); // SAME body chunk content, tag only
    await indexVault(args);
    expect(tagFullSpy).not.toHaveBeenCalled();
    expect(tagDeltaSpy).toHaveBeenCalledTimes(1);
    expect(tagDeltaSpy.mock.calls[0]?.[1]).toEqual(new Set(["a.md", "b.md"])); // b.md shared the OLD tag
    // The chunk BODY is byte-identical, so no chunk embedding changed — the kNN delta must see an
    // EMPTY change set and skip entirely (not even the scope lookup), same as the true no-op case.
    expect(knnFullSpy).not.toHaveBeenCalled();
    expect(knnDeltaSpy).not.toHaveBeenCalled();
    v.cleanup();
  });

  it("does not call any densify function when both flags are off", async () => {
    const v = migratedVault({ "a.md": "# A\n\nalpha" });
    await indexVault({
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });
    expect(knnFullSpy).not.toHaveBeenCalled();
    expect(knnDeltaSpy).not.toHaveBeenCalled();
    expect(tagFullSpy).not.toHaveBeenCalled();
    expect(tagDeltaSpy).not.toHaveBeenCalled();
    v.cleanup();
  });
});
