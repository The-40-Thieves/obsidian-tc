// THE-490: the acceptance GATE for indexVault's opt-in streaming walk (args.walk.streaming) —
// "index output unchanged". This test indexes the SAME on-disk vault twice, into two SEPARATE
// fresh DBs, once via the default (eager, globally-sorted walkVault) path and once via the
// streaming (per-directory-sorted walkVaultStream) path, and asserts the two resulting DB states
// are byte-for-byte identical: chunk ids/paths/hashes/content, chunk embedding bytes, note rows,
// and every edge (literal wikilinks + derived shared_tag/similar_to).
//
// The fixture deliberately includes the ONE concrete divergence case
// (packages/server/test/vault-primitives.test.ts documents it): a file "b.md" sibling to a folder
// "b/" whose child has BYTE-IDENTICAL content to "b.md". The default walk visits "b.md" before
// "b/dup.md" (global relPath sort); the streaming walk visits "b/dup.md" first (per-directory name
// sort: "b" < "b.md"). That flips WHICH of the two paths the content-hash dedup registry treats as
// the "source" note (see indexer.ts's dedupRegistry) — and this test proves that flip is invisible
// in the final DB: the embedding is a deterministic function of content, not of which path computed
// it first, so both paths land on the identical vector regardless of processing order.
import { describe, expect, it, vi } from "vitest";

// Mirrors test/densify-delta-knn.test.ts's mock: sqlite-vec cannot load under vitest's node:sqlite,
// so vecKnn is replaced with a real brute-force cosine search over the actual chunk_embeddings rows
// indexVault wrote — this exercises the similar_to (kNN) derived-edge layer for real, not a canned
// fixture, while loadVec is mocked true so derived-edges.ts's hasVecChunks probe passes.
vi.mock("../src/search/vec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/search/vec")>();
  function cosineDistance(a: Float32Array | number[], b: Float32Array | number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      const av = a[i] as number;
      const bv = b[i] as number;
      dot += av * bv;
      na += av * av;
      nb += bv * bv;
    }
    if (na === 0 || nb === 0) return 1;
    return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
  return {
    ...actual,
    loadVec: () => true,
    vecKnn: (db: any, query: number[], k: number, vaultId?: string) => {
      const rows = db
        .prepare(
          "SELECT c.id AS chunk_id, c.path AS path, e.embedding AS embedding FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE e.is_active = 1 AND c.vault_id = ?",
        )
        .all(vaultId) as Array<{ chunk_id: string; path: string; embedding: Uint8Array }>;
      const scored = rows.map((r) => ({
        chunk_id: r.chunk_id,
        path: r.path,
        distance: cosineDistance(query, [...actual.blobToFloats(r.embedding)]),
      }));
      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, k);
    },
  };
});

const { provisionCacheDb } = await import("../src/db/provision");
const { fakeEmbeddingProvider } = await import("../src/embeddings");
const { indexVault } = await import("../src/search/indexer");
const { makeM2Vault } = await import("./m2-helpers");

const dupBodyOne =
  "shared body one\n\nSHARED_MARKER_ONE this exact line must match byte for byte across both copies.\n";
const dupBodyTwo =
  "second shared body two\n\nSHARED_MARKER_TWO another identical duplicate paragraph here.\n";

// THE-490 fixture: exercises every order-sensitive candidate identified during investigation —
//   - dedup "first path wins" registry: "b.md" / "b/dup.md" and "m.md" / "m/dup2.md" are two
//     BYTE-IDENTICAL-content pairs straddling the documented b-vs-b.md divergence case, so the
//     "first" path differs between the two walk orders for BOTH pairs.
//   - literal wikilink resolution: "b/note.md" links to [[b]], resolved via buildVaultIndex over
//     whatever order `notes` was built in.
//   - shared_tag densification: b.md / b/dup.md / b/note.md all carry `tags: [proj]`.
//   - similar_to (kNN) densification: cluster/a1.md + cluster/a2.md are near-duplicate content: a
//     genuinely different vocabulary from recipe.md, borrowed from densify-delta-knn.test.ts's
//     well-separated-cluster fixture so k=1 forms exactly one deterministic edge.
const FILES: Record<string, string> = {
  "b.md": `---\ntags: [proj]\n---\n${dupBodyOne}`,
  "b/dup.md": `---\ntags: [proj]\n---\n${dupBodyOne}`,
  "b/note.md": "---\ntags: [proj]\n---\nSee [[b]] for details.\n",
  "m.md": dupBodyTwo,
  "m/dup2.md": dupBodyTwo,
  "cluster/a1.md": "gradient descent neural network training loss optimizer batch",
  "cluster/a2.md": "neural network training gradient loss batch optimizer epoch",
  "recipe.md": "pasta dinner recipe tomato basil garlic olive oil simmer tonight",
};

interface DbState {
  chunks: unknown[];
  embeddings: unknown[];
  notes: unknown[];
  edges: unknown[];
}

function dumpState(db: any, vaultId: string): DbState {
  const chunks = db
    .prepare(
      "SELECT id, path, chunk_index, headings, content, content_hash, token_count FROM chunks WHERE vault_id = ? ORDER BY path, chunk_index",
    )
    .all(vaultId);
  // Embeddings joined through chunks (chunk_embeddings has no vault_id column of its own) and
  // ordered by the STABLE (path, chunk_index) key rather than chunk id, so row order can't drift
  // even though chunk ids are content-hash-derived hex strings.
  const embeddings = db
    .prepare(
      `SELECT c.path AS path, c.chunk_index AS chunk_index, e.model AS model,
              e.dimensions AS dimensions, e.embedding AS embedding, e.is_active AS is_active
       FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
       WHERE c.vault_id = ? ORDER BY c.path, c.chunk_index`,
    )
    .all(vaultId);
  const notes = db
    .prepare(
      "SELECT path, title, tags, frontmatter, content_hash, mtime, size FROM notes WHERE vault_id = ? ORDER BY path",
    )
    .all(vaultId);
  const edges = db
    .prepare(
      "SELECT source_path, target_path, edge_type, edge_kind, provenance, confidence FROM vault_edges WHERE vault_id = ? ORDER BY source_path, target_path, edge_type",
    )
    .all(vaultId);
  return { chunks, embeddings, notes, edges };
}

/** Index the SAME on-disk root into a FRESH db, with `streaming` toggling walk.streaming. */
async function indexInto(
  db: any,
  root: string,
  provider: ReturnType<typeof fakeEmbeddingProvider>,
  streaming: boolean,
): Promise<void> {
  provisionCacheDb(db);
  db.exec("CREATE TABLE IF NOT EXISTS vec_chunks (dummy INTEGER)");
  await indexVault({
    db,
    provider,
    vaultId: "v1",
    root,
    isReadable: () => true,
    chunkContext: false,
    densify: { tagEdges: true, knnEdges: true, knnK: 1 },
    now: () => 1_700_000_000_000, // pin created_at/updated_at/indexed_at across both runs
    walk: { streaming },
  });
}

describe("THE-490 acceptance: index output unchanged (default walk vs streaming walk)", () => {
  it("produces byte-for-byte identical chunks, embeddings, notes and edges either way", async () => {
    const v = makeM2Vault({ files: FILES });
    const provider = fakeEmbeddingProvider({ dimensions: 32 });
    try {
      const dbDefault = v.db; // makeM2Vault already provisioned this one
      dbDefault.exec("CREATE TABLE IF NOT EXISTS vec_chunks (dummy INTEGER)");
      await indexVault({
        db: dbDefault,
        provider,
        vaultId: "v1",
        root: v.root,
        isReadable: () => true,
        chunkContext: false,
        densify: { tagEdges: true, knnEdges: true, knnK: 1 },
        now: () => 1_700_000_000_000,
        // walk.streaming omitted -> default (eager, globally-sorted) path.
      });

      const { openMemoryDb } = await import("./helpers");
      const dbStream = openMemoryDb();
      await indexInto(dbStream, v.root, provider, true);

      const stateDefault = dumpState(dbDefault, "v1");
      const stateStream = dumpState(dbStream, "v1");

      // Sanity: the fixture actually produced something (an equivalence check over two empty
      // result sets would pass vacuously and prove nothing).
      expect(stateDefault.chunks.length).toBeGreaterThan(0);
      expect(stateDefault.edges.length).toBeGreaterThan(0);
      expect(stateDefault.notes.length).toBe(Object.keys(FILES).length);

      expect(stateStream).toEqual(stateDefault);
    } finally {
      v.cleanup();
    }
  });

  it(
    "sanity: the equivalence check is NOT vacuous — perturbing the streamed traversal to skip an " +
      "entry makes it fail",
    async () => {
      // Proves the assertion above can actually go red, per THE-490's verification standard: mock
      // walkVaultStream to silently DROP one real entry (as if a streaming bug lost a note deep in
      // the walk) and confirm the two DB states then legitimately differ.
      vi.resetModules();
      vi.doMock("../src/vault/paths", async (importOriginal) => {
        const actual = await importOriginal<typeof import("../src/vault/paths")>();
        return {
          ...actual,
          walkVaultStream: async function* (root: string, opts: any) {
            for await (const e of actual.walkVaultStream(root, opts)) {
              if (e.relPath === "recipe.md") continue; // drop one note — a genuine bug, not a reorder
              yield e;
            }
          },
        };
      });
      const { indexVault: brokenIndexVault } = await import("../src/search/indexer");
      const { provisionCacheDb: provision2 } = await import("../src/db/provision");
      const { fakeEmbeddingProvider: fakeProvider2 } = await import("../src/embeddings");
      const { openMemoryDb } = await import("./helpers");
      const { makeM2Vault: makeVault2 } = await import("./m2-helpers");

      const v = makeVault2({ files: FILES });
      const provider = fakeProvider2({ dimensions: 32 });
      try {
        const dbDefault = v.db;
        dbDefault.exec("CREATE TABLE IF NOT EXISTS vec_chunks (dummy INTEGER)");
        await brokenIndexVault({
          db: dbDefault,
          provider,
          vaultId: "v1",
          root: v.root,
          isReadable: () => true,
          chunkContext: false,
          densify: { tagEdges: true, knnEdges: true, knnK: 1 },
          now: () => 1_700_000_000_000,
        });

        const dbStream = openMemoryDb();
        provision2(dbStream);
        dbStream.exec("CREATE TABLE IF NOT EXISTS vec_chunks (dummy INTEGER)");
        await brokenIndexVault({
          db: dbStream,
          provider,
          vaultId: "v1",
          root: v.root,
          isReadable: () => true,
          chunkContext: false,
          densify: { tagEdges: true, knnEdges: true, knnK: 1 },
          now: () => 1_700_000_000_000,
          walk: { streaming: true },
        });

        const stateDefault = dumpState(dbDefault, "v1");
        const stateStream = dumpState(dbStream, "v1");
        expect(stateStream).not.toEqual(stateDefault); // proves the check is NOT vacuous
        expect(stateStream.notes.length).toBe(stateDefault.notes.length - 1); // recipe.md missing
      } finally {
        v.cleanup();
        vi.doUnmock("../src/vault/paths");
        vi.resetModules();
      }
    },
  );
});
