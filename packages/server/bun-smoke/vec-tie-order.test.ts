// THE-582: vec0 KNN must impose a TOTAL order, so equal distances rank identically on every host.
//
// Lives in bun-smoke rather than test/ for the usual reason (node:sqlite cannot load the extension,
// so vitest never reaches the real vec0 path) — but here that placement is the point rather than an
// inconvenience. The defect this pins was observed as a difference BETWEEN architectures: the same
// commit produced retrieval.ndcg_at10 0.80281468033933 on Cave (aarch64) and 0.8414330514255118 on
// an x86_64 CI runner, stable within each host (cv 0.000 over 5 samples). bun-smoke runs on the
// x86_64 runner, so this asserts the invariant on the machine that disagreed.
//
// vec0 rejects `ORDER BY distance, chunk_id` ("Only a single 'ORDER BY distance' clause is allowed
// on vec0 KNN queries"), so the tiebreak is applied in vecKnn after the query returns; these tests
// exist because that fix is invisible in the SQL.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { semanticSearch } from "../src/search/semantic";
import { loadVec, vecKnn } from "../src/search/vec";

/** DUPLICATE_GROUPS notes share each body, so their chunks embed to identical vectors and the
 *  distances tie EXACTLY — the same shape the perf corpus has (dupGroups=20 over 100 notes) and the
 *  reason its rank-10 distance spans the top-10 cut on 3 of 5 labelled queries. */
const BODIES = ["alpha alpha alpha", "beta beta beta", "gamma gamma gamma"];
const DUPLICATE_GROUPS = 5;

async function indexedVault(): Promise<{
  db: Awaited<ReturnType<typeof openDatabase>>;
  root: string;
  vaultId: string;
}> {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  const root = mkdtempSync(join(tmpdir(), "obtc-tie-"));
  for (let g = 0; g < DUPLICATE_GROUPS; g++)
    for (const [b, body] of BODIES.entries())
      writeFileSync(join(root, `note-${b}-${g}.md`), `# Body ${b}\n\n${body}\n`);
  await indexVault({
    db,
    provider: fakeEmbeddingProvider({ dimensions: 32, model: "fake-tie" }),
    representation: buildRepresentationManifest(
      fakeEmbeddingProvider({ dimensions: 32, model: "fake-tie" }),
      { chunkContext: false },
    ),
    vaultId: "main",
    root,
    isReadable: () => true,
    chunkContext: false,
  });
  return { db, root, vaultId: "main" };
}

/** Assert (distance, chunk_id) is non-decreasing across the whole list, and report the first
 *  violation concretely — "not sorted" is useless when the fix is about tie ORDER specifically. */
function expectTotalOrder(rows: Array<{ chunk_id: string; distance: number }>): void {
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1] as { chunk_id: string; distance: number };
    const cur = rows[i] as { chunk_id: string; distance: number };
    if (cur.distance !== prev.distance) {
      expect(cur.distance).toBeGreaterThan(prev.distance);
    } else {
      // The tie case: this is the assertion that fails without the fix.
      expect(
        `${prev.distance}:${prev.chunk_id} < ${cur.distance}:${cur.chunk_id}` +
          (prev.chunk_id < cur.chunk_id ? " OK" : " OUT OF ORDER"),
      ).toContain("OK");
    }
  }
}

test("vecKnn breaks exact distance ties by chunk_id (host-independent order)", async () => {
  const { db, root, vaultId } = await indexedVault();
  try {
    expect(loadVec(db)).toBe(true);
    // The provider is deterministic on text, so embedding the same body text as the query puts a
    // whole duplicate group at distance 0 — exact ties at the very top of the ranking.
    const [queryVec] = await fakeEmbeddingProvider({
      dimensions: 32,
      model: "fake-tie",
    }).embed([BODIES[0] as string]);
    const rows = vecKnn(db, queryVec as number[], 30, vaultId);
    expect(rows.length).toBeGreaterThan(0);

    // The corpus must actually produce ties, or this test would pass while asserting nothing —
    // the empty-scan failure mode. Assert the precondition before the invariant.
    const tied = new Map<number, number>();
    for (const r of rows) tied.set(r.distance, (tied.get(r.distance) ?? 0) + 1);
    const tieGroups = [...tied.values()].filter((n) => n > 1).length;
    expect(tieGroups).toBeGreaterThan(0);

    expectTotalOrder(rows);

    // And the order is reproducible call-to-call on this host, which is the property the perf
    // baseline's cv 0.000 already had — it is the CROSS-host half the tiebreak adds.
    const again = vecKnn(db, queryVec as number[], 30, vaultId);
    expect(again.map((r) => r.chunk_id)).toEqual(rows.map((r) => r.chunk_id));
  } finally {
    db.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("semanticSearch's ranking is total under exact score ties", async () => {
  const { db, root, vaultId } = await indexedVault();
  try {
    const [queryVec] = await fakeEmbeddingProvider({
      dimensions: 32,
      model: "fake-tie",
    }).embed([BODIES[1] as string]);
    const hits = semanticSearch(db, vaultId, queryVec as number[], { k: 12 });
    expect(hits.length).toBeGreaterThan(0);
    // semanticSearch ranks by SIMILARITY (1 - distance), so the total order is score DESCENDING
    // then chunk_id ascending. Same invariant, opposite primary direction.
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1] as { chunk_id: string; score: number };
      const cur = hits[i] as { chunk_id: string; score: number };
      if (cur.score !== prev.score) expect(cur.score).toBeLessThan(prev.score);
      else expect(prev.chunk_id < cur.chunk_id).toBe(true);
    }
  } finally {
    db.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});
