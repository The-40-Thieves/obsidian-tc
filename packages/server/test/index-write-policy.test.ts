import { describe, expect, it } from "vitest";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../src/embeddings";
import { MetricsRecorder } from "../src/metrics/registry";
import { type IndexHealthState, wireIndexCoordinator } from "../src/runtime/indexing-wiring";
import { ftsCandidates } from "../src/search/fts";
import { indexNote, indexVault } from "../src/search/indexer";
import type { IndexVaultArgs } from "../src/search/indexing/types";
import { buildRepresentationManifest } from "../src/search/representation";
import { type M2Vault, makeM2Vault } from "./m2-helpers";

const PATH = "Notes/Policy.md";
const LONG_NOTE =
  "# Index policy\n\n" +
  Array.from(
    { length: 32 },
    (_, i) =>
      `Paragraph ${i} records policyneedle and a distinct observation about module boundaries.`,
  ).join("\n\n");
const SECTIONS = Array.from(
  { length: 9 },
  (_, i) =>
    `# Section ${i}\n\nObservation ${i} concerns the indexing policy and its consistency across writes.`,
).join("\n\n");

function wire(
  v: M2Vault,
  policy: Pick<IndexVaultArgs, "chunkTokens" | "embed"> = {},
  enrich = false,
) {
  const health: IndexHealthState = {
    reconcile: "ok",
    reconcileAt: 0,
    reconcileErrors: [],
    writeFailures: 0,
    frontmatterFailures: new Map(),
    notesReady: true,
    auditWriteFailures: 0,
    indexQueueBackpressures: 0,
    lastChunksUpserted: null,
    inFlight: null,
  };
  const wiring = wireIndexCoordinator({
    db: v.db,
    embeddingProvider: v.provider,
    hasVec: false,
    chunkTokens: policy.chunkTokens,
    embedConfig: policy.embed,
    chunkContext: enrich,
    indexing: { writeConcurrency: 1, writeConcurrencyPerVault: 1, queueMax: 100 },
    vaults: [{ id: v.id, path: v.root }],
    watch: { enabled: false, debounceMs: 0 },
    sqlHooksFor: () => ({}),
    indexHealth: health,
    metrics: new MetricsRecorder(),
    acl: v.acl,
    aclByVault: new Map(),
    makeOnIndexed: () => undefined,
  });
  return { ...wiring, health };
}

function persisted(v: M2Vault): unknown[] {
  return v.db
    .prepare(
      `SELECT c.chunk_index, c.content, c.content_hash, c.headings, c.token_count,
              e.model, hex(e.embedding) AS embedding
       FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1
       WHERE c.vault_id = ? AND c.path = ? ORDER BY c.chunk_index`,
    )
    .all(v.id, PATH);
}

function observedProvider() {
  const base = fakeEmbeddingProvider({ dimensions: 32 });
  const batches: string[][] = [];
  let active = 0;
  let peak = 0;
  const provider: EmbeddingProvider = {
    ...base,
    async embed(texts, options) {
      batches.push([...texts]);
      active++;
      peak = Math.max(peak, active);
      try {
        // Hold each call across a microtask so concurrent workers overlap deterministically.
        await Promise.resolve();
        return await base.embed(texts, options);
      } finally {
        active--;
      }
    },
  };
  return { provider, batches, peak: () => peak };
}

describe("index-on-write policy", () => {
  it.each([false, true])(
    "persists the same chunks and vectors as a vault pass (enrichment=%s)",
    async (enrich) => {
      const bulk = makeM2Vault({ files: { [PATH]: LONG_NOTE } });
      const write = makeM2Vault({ files: { [PATH]: LONG_NOTE } });
      const wiring = wire(write, { chunkTokens: 64 }, enrich);
      try {
        await indexVault({
          db: bulk.db,
          provider: bulk.provider,
          vaultId: bulk.id,
          root: bulk.root,
          isReadable: () => true,
          chunkTokens: 64,
          chunkContext: enrich,
          representation: buildRepresentationManifest(bulk.provider, {
            chunkTokens: 64,
            chunkContext: enrich,
          }),
        });
        wiring.reindexHook(write.id, PATH, LONG_NOTE);
        await wiring.indexCoordinator.idle();

        expect(wiring.health.writeFailures).toBe(0);
        expect(persisted(bulk).length).toBeGreaterThan(4);
        expect(persisted(write)).toEqual(persisted(bulk));
        expect(ftsCandidates(write.db, write.id, "policyneedle", 10)?.map((r) => r.path)).toEqual([
          PATH,
        ]);
      } finally {
        wiring.stopVaultWatch();
        bulk.cleanup();
        write.cleanup();
      }
    },
  );

  it.each([
    { name: "batch size", batchSize: 2, maxBatchTokens: 10_000, concurrency: 1, expectedPeak: 1 },
    { name: "token budget", batchSize: 100, maxBatchTokens: 60, concurrency: 1, expectedPeak: 1 },
    { name: "concurrency", batchSize: 1, maxBatchTokens: 10_000, concurrency: 2, expectedPeak: 2 },
  ])("honors the configured $name for provider calls", async (policy) => {
    const observed = observedProvider();
    const v = makeM2Vault({ files: { [PATH]: SECTIONS }, provider: observed.provider });
    const wiring = wire(v, { embed: policy }, true);
    try {
      wiring.reindexHook(v.id, PATH, SECTIONS);
      await wiring.indexCoordinator.idle();

      expect(wiring.health.writeFailures).toBe(0);
      expect(observed.batches.flat()).toHaveLength(9);
      expect(observed.batches.length).toBeGreaterThan(1);
      for (const batch of observed.batches) {
        expect(batch.length).toBeLessThanOrEqual(policy.batchSize);
        // These prose-only inputs use the documented four-characters-per-token estimate.
        expect(batch.reduce((n, text) => n + Math.ceil(text.length / 4), 0)).toBeLessThanOrEqual(
          policy.maxBatchTokens,
        );
      }
      expect(observed.peak()).toBe(policy.expectedPeak);
      expect(persisted(v)).toHaveLength(9);
    } finally {
      wiring.stopVaultWatch();
      v.cleanup();
    }
  });

  it("preserves the default chunk representation for callers omitting policy options", async () => {
    const bulk = makeM2Vault({ files: { [PATH]: LONG_NOTE } });
    const write = makeM2Vault({ files: { [PATH]: LONG_NOTE } });
    try {
      await indexVault({
        db: bulk.db,
        provider: bulk.provider,
        vaultId: bulk.id,
        root: bulk.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(bulk.provider, {}),
      });
      await indexNote(write.db, write.provider, write.id, PATH, LONG_NOTE, false, Date.now);
      expect(persisted(write).length).toBeGreaterThan(0);
      expect(persisted(write)).toEqual(persisted(bulk));
    } finally {
      bulk.cleanup();
      write.cleanup();
    }
  });
});
