// GH #1433 step 3: each burst-end site calls onBurstEnd exactly once per burst, however many embed
// sub-batches the burst ran. The two sites are a finished index pass (indexVault) and the
// index-on-write queue going idle (wireIndexCoordinator's onIdle).
import { mkdirSync } from "node:fs";
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
      await indexVault({
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
        batch: { maxNotes: 1 }, // one sub-batch per note: three in this pass
        onProgress: () => {
          flushes += 1;
        },
      });
      expect(flushes).toBe(3);
      expect(burst).toHaveBeenCalledTimes(1);
      expect(burst).toHaveBeenCalledWith("full-reconcile");
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
      expect(burst).toHaveBeenCalledWith("write-drain", 512);
    } finally {
      rmTemp(root);
    }
  });
});
