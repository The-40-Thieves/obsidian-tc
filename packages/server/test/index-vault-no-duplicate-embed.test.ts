// GH #995 follow-up: the note_write_fence generation read (write-fence.ts's
// preloadFenceGenerations/readFenceGeneration) rides alongside computeNotePlan's existing
// content_hash check and must never force a note back into `toEmbed` on its own — a note whose
// content (and therefore fence generation) is unchanged between two reconcile passes must still
// embed ZERO chunks on the second pass, counted directly at the provider boundary rather than
// inferred from IndexStats.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import {
  deterministicVector,
  type EmbeddingProvider,
  fakeEmbeddingProvider,
} from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

describe("index_vault does not duplicate embedding work across unchanged reconcile passes (GH #995 follow-up)", () => {
  it("issues zero embed() calls on a second pass over unchanged content", async () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-no-dup-embed-"));
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, `note-${i}.md`), `# Note ${i}\nSome stable body for note ${i}.\n`);
    }
    let embedCalls = 0;
    const provider: EmbeddingProvider = {
      ...fakeEmbeddingProvider({ dimensions: 8 }),
      embed: async (texts: string[]): Promise<number[][]> => {
        embedCalls += 1;
        return texts.map((t) => deterministicVector(t, 8));
      },
    };
    const db = openMemoryDb();
    provisionCacheDb(db);
    const representation = buildRepresentationManifest(provider, {});
    const baseArgs = {
      db,
      provider,
      vaultId: "v1",
      root,
      isReadable: () => true,
      representation,
      chunkContext: false,
    };

    const first = await indexVault({ ...baseArgs, now: () => 1 });
    expect(first.notes_indexed).toBe(5);
    expect(embedCalls).toBeGreaterThan(0);

    const callsAfterFirst = embedCalls;
    // Second pass, IDENTICAL content, no intervening concurrent write — every note's fence
    // generation is exactly what preloadFenceGenerations reads back; content_hash is unchanged too.
    const second = await indexVault({ ...baseArgs, now: () => 2 });
    expect(second.notes_indexed).toBe(0);
    expect(second.chunks_upserted).toBe(0);
    expect(second.notes_stale_skipped).toBe(0);
    expect(embedCalls).toBe(callsAfterFirst); // zero NEW embed() calls this pass

    rmTemp(root);
  });
});
