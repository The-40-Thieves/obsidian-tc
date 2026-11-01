// GH #1433 step 3: each burst-end site calls onBurstEnd exactly once per burst, however many embed
// sub-batches the burst ran. The two sites are a finished index pass (indexVault) and the
// index-on-write queue going idle (wireIndexCoordinator's onIdle).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { onBurstEnd } from "../src/embeddings/host/recycle-policy";
import { MetricsRecorder } from "../src/metrics/registry";
import { wireIndexCoordinator } from "../src/runtime/indexing-wiring";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { makeM2Vault } from "./m2-helpers";
import { makeTempDir, rmTemp } from "./tmp";

vi.mock("../src/embeddings/host/recycle-policy", () => ({ onBurstEnd: vi.fn(async () => {}) }));

const burst = vi.mocked(onBurstEnd);

afterEach(() => {
  burst.mockClear();
});

describe("burst-end sites (GH #1433 step 3)", () => {
  it("a finished indexVault pass is one full-reconcile burst end, across all its sub-batches", async () => {
    const v = makeM2Vault({
      files: { "a.md": "alpha one", "b.md": "bravo two", "c.md": "charlie three" },
    });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      let flushes = 0;
      const representation = buildRepresentationManifest(provider, {});
      const pass = { representation, provider, db: v.db, vaultId: v.id, root: v.root };
      await indexVault({
        ...pass,
        isReadable: () => true,
        batch: { maxNotes: 1 }, // one sub-batch per note: three in this pass
        onProgress: () => (flushes += 1),
      });
      expect(flushes).toBe(3);
      expect(burst).toHaveBeenCalledTimes(1);
      expect(burst).toHaveBeenCalledWith("full-reconcile", { embeddedChunks: expect.any(Number) });
      expect(burst.mock.calls[0]?.[1]?.embeddedChunks).toBeGreaterThan(0);
    } finally {
      v.cleanup();
    }
  });

  it("an indexVault pass over an unchanged vault reports zero embedded chunks to the recycle policy", async () => {
    const v = makeM2Vault({ files: { "a.md": "alpha one", "b.md": "bravo two" } });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const representation = buildRepresentationManifest(provider, {});
      const pass = { representation, provider, db: v.db, vaultId: v.id, root: v.root };
      const opts = { ...pass, isReadable: () => true };
      await indexVault(opts);
      burst.mockClear();
      await indexVault(opts);
      expect(burst).toHaveBeenCalledWith("full-reconcile", { embeddedChunks: 0 });
    } finally {
      v.cleanup();
    }
  });

  it("a pass whose chunks are all dedup copies reports zero embedded chunks, so it does not recycle", async () => {
    const v = makeM2Vault({ files: { "a.md": "alpha one" } });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const representation = buildRepresentationManifest(provider, {});
      const pass = { representation, provider, db: v.db, vaultId: v.id, root: v.root };
      await indexVault({ ...pass, isReadable: () => true });
      // b.md repeats a.md's body: its chunk is a dedup copy, so no text reaches the provider.
      writeFileSync(join(v.root, "b.md"), "alpha one");
      burst.mockClear();
      await indexVault({ ...pass, isReadable: () => true });
      expect(burst).toHaveBeenCalledWith("full-reconcile", { embeddedChunks: 0 });
    } finally {
      v.cleanup();
    }
  });

  it("a reconcile hands the memory budget to the recycle policy, so an idle over-budget pass can recycle", async () => {
    const v = makeM2Vault({ files: { "a.md": "alpha one" } });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const representation = buildRepresentationManifest(provider, {});
      const opts = {
        representation,
        provider,
        db: v.db,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        embed: { memoryBudgetMb: 512 },
      };
      await indexVault(opts);
      burst.mockClear();
      await indexVault(opts);
      expect(burst).toHaveBeenCalledWith("full-reconcile", { embeddedChunks: 0, budgetMb: 512 });
    } finally {
      v.cleanup();
    }
  });

  it("a write-queue burst is one write-drain burst end, carrying the memory budget", async () => {
    const root = makeTempDir("obtc-burst-");
    mkdirSync(join(root, "notes"), { recursive: true });
    try {
      const wiring = wireIndexCoordinator({
        db: {} as never,
        metrics: new MetricsRecorder(),
        embeddingProvider: fakeEmbeddingProvider({ dimensions: 8 }),
        hasVec: false,
        chunkContext: false,
        indexing: {
          writeConcurrency: 2,
          writeConcurrencyPerVault: 2,
          queueMax: 100,
          memoryBudgetMb: 512,
        },
        vaults: [{ id: "v", path: root }],
        watch: { enabled: false, debounceMs: 0 },
        sqlHooksFor: () => ({}),
        indexHealth: {
          writeFailures: 0,
          frontmatterFailures: new Map(),
          indexQueueBackpressures: 0,
        },
        acl: new FolderAcl({
          readOnly: false,
          defaultScopes: [],
          rules: [],
          readPaths: ["notes", "notes/**"],
        }),
        aclByVault: new Map(),
        makeOnIndexed: () => undefined,
      });
      wiring.reindexHook("v", "notes/a.md", "a");
      wiring.reindexHook("v", "notes/b.md", "b");
      wiring.reindexHook("v", "notes/c.md", "c");
      await wiring.indexCoordinator.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(burst).toHaveBeenCalledTimes(1);
      expect(burst).toHaveBeenCalledWith("write-drain", { budgetMb: 512 });
    } finally {
      rmTemp(root);
    }
  });
});
