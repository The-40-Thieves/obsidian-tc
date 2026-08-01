// THE-588: dedup's LOSS side. computeNotePlan's cross-path dedup marks a chunk skipEmbed
// uniformly, without knowing whether the owner it will copy from actually has a stored vector —
// that is only known later, at apply time (copyDedupVectors' `!src` bail, indexer.ts). When the
// owner's note is quarantined this pass (e.g. the embed provider rejected it), every duplicate
// resolving to it degrades to FTS-only: the chunk row is written, but chunk_embeddings gets no
// row. Today that loss was folded into chunks_dedup_reused / obsidian_tc_ingest_dedup_skipped_total,
// whose help text calls a rise "good" — this split gives the loss its own counter.
import { err, type ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../src/embeddings";
import { recordIngestStats } from "../src/metrics/ingest-stats";
import { MetricsRecorder } from "../src/metrics/registry";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { makeM2Vault } from "./m2-helpers";

const POISON = "POISON-OVER-CONTEXT";

// A provider that rejects (HTTP 400) any request containing POISON — same shape as
// embed-batching.test.ts's contextCappedProvider, but keyed on content rather than size so the
// OWNER note (walked first) is the one quarantined, not the duplicate.
function poisonRejectingProvider(): EmbeddingProvider {
  return {
    id: "capped",
    provider: "capped",
    model: "m",
    dimensions: 32,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.some((t) => t.includes(POISON)))
        throw err.embeddingProviderError("HTTP 400", { provider: "capped", status: 400 });
      return texts.map(() => Array.from({ length: 32 }, () => 0.5));
    },
  };
}

// Two notes sharing an IDENTICAL body (-> same content_hash -> the second dedups against the
// first) so the walked-first note ("a-owner.md") is the dedup OWNER and "b-dup.md" is the
// duplicate that copies from it.
function dupVaultWithPoisonedOwner() {
  const body = `# H\n\n${POISON} identical paragraph shared by both notes verbatim`;
  return makeM2Vault({
    files: { "a-owner.md": body, "b-dup.md": body },
    provider: poisonRejectingProvider(),
  });
}

describe("THE-588 dedup-unresolved (owner has no stored vector)", () => {
  it("counts an unresolved skip and leaves the target chunk with no chunk_embeddings row", async () => {
    const v = dupVaultWithPoisonedOwner();
    const res: ToolResult = await v.call("index_vault", { vault: "test" });
    expect(res.ok).toBe(true);
    const d = (res.ok ? res.data : {}) as Record<string, number>;

    // The owner was quarantined (embed rejected its only chunk even alone).
    expect(d.notes_embed_failed).toBe(1);
    // The duplicate's chunk was skipped for embedding (dedup fired) but had nothing to copy from.
    expect(d.chunks_dedup_unresolved).toBe(1);

    const dupChunk = v.db.prepare("SELECT id FROM chunks WHERE path = 'b-dup.md'").get() as
      | { id: string }
      | undefined;
    expect(dupChunk).toBeDefined();
    // Chunk row exists (still STORED — see applyNoteWrites), but no embedding was copied.
    const embRow = v.db
      .prepare("SELECT 1 FROM chunk_embeddings WHERE chunk_id = ?")
      .get(dupChunk?.id);
    expect(embRow).toBeUndefined();
    // The owner itself was quarantined, so it never got a chunk row either.
    const ownerChunk = v.db.prepare("SELECT id FROM chunks WHERE path = 'a-owner.md'").get();
    expect(ownerChunk).toBeUndefined();
    v.cleanup();
  });

  it("emits an [ingest] stderr warning naming the affected path(s)", async () => {
    const v = dupVaultWithPoisonedOwner();
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await v.call("index_vault", { vault: "test" });
    } finally {
      process.stderr.write = orig;
    }
    expect(writes.some((w) => /dedup-skipped chunk with no source vector/.test(w))).toBe(true);
    expect(writes.some((w) => w.includes("b-dup.md"))).toBe(true);
    v.cleanup();
  });
});

describe("THE-588 chunks_dedup_unresolved stays 0 on a normal (resolved) dedup", () => {
  it("counts the reuse as chunks_dedup_reused and leaves chunks_dedup_unresolved at 0", async () => {
    // Same body, no poison this time — the owner embeds successfully, so the duplicate's copy
    // resolves.
    const body = "# H\n\nthe exact same paragraph of content appears in both notes verbatim";
    const v = makeM2Vault({
      files: { "a.md": body, "b.md": body },
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
    });
    const stats = await indexVault({
      db: v.db,
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      representation: buildRepresentationManifest(
        fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
        {},
      ),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });
    expect(stats.chunks_dedup_reused).toBeGreaterThan(0);
    expect(stats.chunks_dedup_unresolved).toBe(0);
    v.cleanup();
  });
});

describe("THE-588 feeds the real Prometheus counter through recordIngestStats, not a shim", () => {
  it("drives a real indexVault pass and asserts the counter's VALUE lands in the exposition", async () => {
    const v = dupVaultWithPoisonedOwner();
    const stats = await indexVault({
      db: v.db,
      provider: poisonRejectingProvider(),
      representation: buildRepresentationManifest(poisonRejectingProvider(), {}),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });
    expect(stats.chunks_dedup_unresolved).toBeGreaterThan(0);

    // This is the SAME function cli.ts's run_serve calls in production — not a hand-rolled call to
    // MetricsRecorder's inc* method, which would only prove the method works, not that the real
    // ingest pipeline is wired to it (the exact class of bug THE-585 found three times).
    const metrics = new MetricsRecorder();
    recordIngestStats(v.db, metrics, v.id, stats);
    const text = await metrics.metrics();
    expect(text).toMatch(
      new RegExp(
        `obsidian_tc_ingest_dedup_unresolved_total\\{vault="${v.id}"\\} ${stats.chunks_dedup_unresolved}`,
      ),
    );
    v.cleanup();
  });
});
