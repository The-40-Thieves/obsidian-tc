// THE-585 (#7, #8): semanticSearch must REPORT when it abandons vec0 for the brute-force scan.
//
// In bun-smoke because the signal only exists when sqlite-vec actually loads: under node:sqlite
// (the vitest runtime) `loadVec` returns false, the vec0 branch is skipped entirely, and there is
// no fallback to observe. A vitest test here would pass while asserting nothing — the exact
// measures-nothing-while-green shape this counter exists to prevent.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { semanticSearch } from "../src/search/semantic";
import { loadVec } from "../src/search/vec";

const DIMS = 32;

async function indexedVault(notes: number): Promise<{
  db: Awaited<ReturnType<typeof openDatabase>>;
  root: string;
}> {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  const root = mkdtempSync(join(tmpdir(), "otc-fallback-"));
  for (let i = 0; i < notes; i++)
    writeFileSync(join(root, `note-${i}.md`), `# Note ${i}\n\nzq${i} alpha beta gamma\n`);
  await indexVault({
    db,
    provider: fakeEmbeddingProvider({ dimensions: DIMS, model: "fake-fallback" }),
    vaultId: "main",
    root,
    isReadable: () => true,
    chunkContext: false,
  });
  return { db, root };
}

test("reports reason=error when vec0 throws (dimension mismatch)", async () => {
  const { db, root } = await indexedVault(5);
  try {
    expect(loadVec(db)).toBe(true);
    const seen: string[] = [];
    // A query vector of the WRONG dimension is what a live embedding-model change looks like to
    // vec0: the index holds 32-d vectors and the query is 8-d, so the KNN throws and the search
    // degrades to the dimension-tolerant brute-force scan.
    const hits = semanticSearch(db, "main", new Array(8).fill(0.1), {
      k: 3,
      onFallback: (reason) => seen.push(reason),
    });
    expect(seen).toContain("error");
    // The degradation is SILENT by design — results still come back. That is precisely why it
    // needs a counter rather than an error.
    expect(Array.isArray(hits)).toBe(true);
  } finally {
    db.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports reason=underfill when ACL-invisible chunks crowd out the over-fetch", async () => {
  // overFetch is k*20+50, so k=1 needs at least 71 candidate chunks for the crowding branch to be
  // reachable — below that, `candidates.length < overFetch` means the scan already saw everything
  // and the fallback is an exhaustive read rather than a degradation.
  const { db, root } = await indexedVault(80);
  try {
    const seen: string[] = [];
    const hits = semanticSearch(db, "main", new Array(DIMS).fill(0.05), {
      k: 1,
      isReadable: () => false, // every candidate invisible -> cannot fill k visible hits
      onFallback: (reason) => seen.push(reason),
    });
    expect(seen).toContain("underfill");
    expect(hits).toHaveLength(0);
  } finally {
    db.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stays silent when vec0 serves the query, and a throwing callback cannot break a search", async () => {
  const { db, root } = await indexedVault(5);
  try {
    const seen: string[] = [];
    // Healthy path: right dimensions, everything visible. No fallback, so no counter movement —
    // without this the metric could fire on every search and nobody would notice.
    semanticSearch(db, "main", new Array(DIMS).fill(0.1), {
      k: 2,
      onFallback: (reason) => seen.push(reason),
    });
    expect(seen).toHaveLength(0);

    // Observability is never load-bearing: a throwing sink must not turn a correct result into an
    // error.
    const hits = semanticSearch(db, "main", new Array(8).fill(0.1), {
      k: 2,
      onFallback: () => {
        throw new Error("metrics sink exploded");
      },
    });
    expect(Array.isArray(hits)).toBe(true);
  } finally {
    db.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});
