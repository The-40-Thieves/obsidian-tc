import { describe, expect, it } from "vitest";
import { indexVault } from "../src/search/indexer";
import { semanticSearch } from "../src/search/semantic";
import { makeM2Vault } from "./m2-helpers";

// Under node:sqlite the vec0 path is unavailable, so these exercise the
// brute-force cosine scan — the portable correctness baseline.
describe("semanticSearch (brute-force cosine path)", () => {
  async function seed() {
    const v = makeM2Vault({
      files: {
        "fox.md": "# Fox\n\nthe quick brown fox jumps over the lazy dog",
        "weather.md": "# Weather\n\nheavy rain and thunderstorms expected tonight",
        "canine.md": "# Canine\n\nthe lazy dog sleeps under the warm sun",
      },
    });
    await indexVault({
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });
    return v;
  }

  it("ranks the lexically closest chunk first", async () => {
    const v = await seed();
    const [q] = await v.provider.embed(["lazy dog"]);
    const hits = semanticSearch(v.db, v.id, q ?? [], { k: 3, returnContent: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(["fox.md", "canine.md"]).toContain(hits[0]?.path);
    expect(hits[0]?.embedding_model).toBe(v.provider.id);
    expect(hits[0]?.content).toBeTypeOf("string");
    v.cleanup();
  });

  it("respects k and orders by descending score", async () => {
    const v = await seed();
    const [q] = await v.provider.embed(["dog"]);
    const hits = semanticSearch(v.db, v.id, q ?? [], { k: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.score).toBeGreaterThanOrEqual(hits[1]?.score ?? 0);
    expect(hits[0]?.content).toBeUndefined(); // returnContent defaults off
    v.cleanup();
  });

  it("drops chunks the read predicate rejects", async () => {
    const v = await seed();
    const [q] = await v.provider.embed(["dog"]);
    const hits = semanticSearch(v.db, v.id, q ?? [], {
      k: 10,
      isReadable: (p) => p !== "canine.md",
    });
    expect(hits.every((h) => h.path !== "canine.md")).toBe(true);
    v.cleanup();
  });

  it("filters by min_score", async () => {
    const v = await seed();
    const [q] = await v.provider.embed(["lazy dog"]);
    const all = semanticSearch(v.db, v.id, q ?? [], { k: 10 });
    const floor = (all[0]?.score ?? 0) + 0.0001;
    const filtered = semanticSearch(v.db, v.id, q ?? [], { k: 10, minScore: floor });
    expect(filtered.length).toBeLessThan(all.length);
    v.cleanup();
  });
});
