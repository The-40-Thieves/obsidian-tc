import { err, IndexingConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../src/embeddings";
import { ftsCandidates } from "../src/search/fts";
import { readGeneration } from "../src/search/generation";
import { indexNote } from "../src/search/indexer";
import * as preparation from "../src/search/indexing/prepare-note";
import { type M2Vault, makeM2Vault } from "./m2-helpers";

const PATH = "Notes/Rollout.md";
const RAW = "# Alpha\n\nrolloutneedle one\n\n# Beta\n\nrolloutneedle two";
const NOW = () => 1000;

function snapshot(v: M2Vault) {
  return {
    chunks: v.db.prepare("SELECT * FROM chunks ORDER BY chunk_index").all(),
    embeddings: v.db
      .prepare("SELECT chunk_id, model, hex(embedding) AS embedding FROM chunk_embeddings")
      .all(),
    notes: v.db.prepare("SELECT * FROM notes ORDER BY path").all(),
    generation: readGeneration(v.db, v.id),
  };
}

afterEach(() => vi.restoreAllMocks());

it("keeps legacy preparation as the validated default and rejects unknown selections", () => {
  expect(IndexingConfigSchema.parse({}).writePreparation).toBe("legacy");
  expect(IndexingConfigSchema.parse({ writePreparation: "modular" }).writePreparation).toBe(
    "modular",
  );
  expect(IndexingConfigSchema.safeParse({ writePreparation: "shadow" }).success).toBe(false);
});

describe.each(["legacy", "modular"] as const)("preparation rollout (%s)", (writePreparation) => {
  it("executes only the selected preparation and commits once", async () => {
    const base = fakeEmbeddingProvider({ dimensions: 32 });
    const embed = vi.fn(base.embed);
    const v = makeM2Vault({ provider: { ...base, embed } });
    const prepared = vi.spyOn(preparation, "prepareNote");
    const indexed = vi.fn();
    try {
      const result = await indexNote(
        v.db,
        v.provider,
        v.id,
        PATH,
        RAW,
        false,
        NOW,
        indexed,
        true,
        undefined,
        undefined,
        PATH,
        { writePreparation, embed: { batchSize: 1, concurrency: 1 } },
      );
      expect(result.upserted).toBe(2);
      expect(prepared).toHaveBeenCalledTimes(writePreparation === "modular" ? 1 : 0);
      expect(embed).toHaveBeenCalledTimes(2);
      expect(indexed).toHaveBeenCalledTimes(1);
      expect(readGeneration(v.db, v.id)).toBe(1);
      expect(ftsCandidates(v.db, v.id, "rolloutneedle", 10)?.map((r) => r.path)).toEqual([PATH]);
    } finally {
      v.cleanup();
    }
  });

  it.each(["outage", "rejection"] as const)(
    "preserves the old index after a later embed %s without falling back",
    async (failure) => {
      const v = makeM2Vault();
      try {
        await indexNote(
          v.db,
          v.provider,
          v.id,
          PATH,
          "# Existing\n\npreviousneedle",
          false,
          NOW,
          undefined,
          true,
          undefined,
          undefined,
          PATH,
          { writePreparation },
        );
        const before = snapshot(v);
        const embed = vi.fn<EmbeddingProvider["embed"]>(async (texts, options) => {
          if (embed.mock.calls.length > 1) {
            if (failure === "rejection") {
              throw err.embeddingProviderError("synthetic rejection", { status: 413 });
            }
            throw new Error("synthetic outage");
          }
          return v.provider.embed(texts, options);
        });
        const indexed = vi.fn();
        await expect(
          indexNote(
            v.db,
            { ...v.provider, embed },
            v.id,
            PATH,
            RAW,
            false,
            NOW,
            indexed,
            true,
            undefined,
            undefined,
            PATH,
            { writePreparation, embed: { batchSize: 1, concurrency: 1 } },
          ),
        ).rejects.toThrow(failure === "rejection" ? /rejected/ : /synthetic outage/);
        expect(embed).toHaveBeenCalledTimes(2);
        expect(indexed).not.toHaveBeenCalled();
        expect(snapshot(v)).toEqual(before);
        expect(ftsCandidates(v.db, v.id, "previousneedle", 10)?.map((r) => r.path)).toEqual([PATH]);
        expect(ftsCandidates(v.db, v.id, "rolloutneedle", 10)).toEqual([]);
      } finally {
        v.cleanup();
      }
    },
  );

  it("keeps excluded text searchable without sending it to the provider", async () => {
    const base = fakeEmbeddingProvider({ dimensions: 32 });
    const embed = vi.fn(base.embed);
    const v = makeM2Vault({ provider: { ...base, embed } });
    try {
      await indexNote(
        v.db,
        v.provider,
        v.id,
        PATH,
        RAW,
        false,
        NOW,
        undefined,
        true,
        undefined,
        (path) => path === PATH,
        PATH,
        { writePreparation },
      );
      expect(embed).not.toHaveBeenCalled();
      expect(v.db.prepare("SELECT embedding_excluded FROM chunks").all()).toEqual([
        { embedding_excluded: 1 },
        { embedding_excluded: 1 },
      ]);
      expect(v.db.prepare("SELECT * FROM chunk_embeddings").all()).toEqual([]);
      expect(ftsCandidates(v.db, v.id, "rolloutneedle", 10)?.map((r) => r.path)).toEqual([PATH]);
    } finally {
      v.cleanup();
    }
  });
});
