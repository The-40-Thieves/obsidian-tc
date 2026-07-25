// THE-497: the two guarantees the cache is not allowed to get wrong, exercised end to end against a
// real indexed vault rather than at the key level alone.
//
//   1. NO CROSS-PRINCIPAL REUSE. Two callers whose effective ACLs differ must never share an entry.
//      A leak here is the same class as THE-453/THE-456: content the caller is not allowed to read
//      reaching them anyway, with no retrieval of their own to blame it on.
//   2. INVALIDATION. A content mutation bumps the vault generation (THE-496, inside the write
//      transaction), and the bump must make every entry computed before it a miss.
//
// The test asserts on CONTENT — the restricted caller must not receive the secret note's chunk — and
// separately on whether the underlying retrieval actually re-ran, because "no leak" is also
// trivially satisfiable by a cache that never hits at all.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aclFingerprint } from "../src/acl";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { readGeneration } from "../src/search/generation";
import type { GraphSearchOptions } from "../src/search/graph_search";
import { indexNote, indexVault } from "../src/search/indexer";
import {
  cachedGraphSearch,
  createRetrievalCaches,
  type QueryCacheBinding,
} from "../src/search/query_cache";
import { makeM2Vault } from "./m2-helpers";

const DIMS = 32;
const QUERY = "alpha beta shared topic";
const provider = () => fakeEmbeddingProvider({ dimensions: DIMS, model: "A" });

const REPRESENTATION = {
  id: "fake",
  provider: "fake",
  model: "A",
  dimensions: DIMS,
  sparse: false,
  colbert: false,
};

/** The two callers differ in exactly one way: one can read secret/**, the other cannot. Their ACL
 *  fingerprints are computed the same way the dispatch path computes them (acl.ts, THE-496). */
const OPEN_ACL = { readOnly: false, defaultScopes: ["read:notes"], rules: [] };
const RESTRICTED_ACL = {
  readOnly: false,
  defaultScopes: ["read:notes"],
  rules: [],
  readPaths: ["public/**"],
};

const bindingFor = (acl: typeof OPEN_ACL, generation: number): QueryCacheBinding => ({
  aclFingerprint: aclFingerprint(acl, ["read:notes"]),
  generation,
  representation: REPRESENTATION,
});

async function setup() {
  const v = makeM2Vault({
    files: {
      "public/open.md": "# Open\n\nalpha beta shared topic notes",
      "secret/closed.md": "# Closed\n\nalpha beta shared topic notes classified",
    },
    provider: provider(),
  });
  await indexVault({
    db: v.db,
    provider: provider(),
    vaultId: v.id,
    root: v.root,
    isReadable: () => true,
  });
  return v;
}

/** Options minus the query vectors — exactly what cachedGraphSearch keys on. */
function baseOpts(
  vaultId: string,
  isReadable: (p: string) => boolean,
): Omit<GraphSearchOptions, "queryVec"> {
  return { query: QUERY, vaultId, finalTopK: 10, isReadable };
}

const embedder = (provider_: ReturnType<typeof provider>, calls: { n: number }) => async () => {
  calls.n++;
  const [vec] = await provider_.embed([QUERY], { input: "query" });
  return { queryVec: vec ?? [] };
};

describe("THE-497 query-product cache: cross-principal isolation", () => {
  it("never serves one caller's cached results to a caller with a different ACL", async () => {
    const v = await setup();
    const caches = createRetrievalCaches({ maxEntries: 32, ttlMs: 60_000 });
    const p = provider();
    const calls = { n: 0 };
    const gen = readGeneration(v.db, v.id);

    // Caller A reads everything, and its results DO contain the secret note.
    const open = await cachedGraphSearch(
      v.db,
      baseOpts(v.id, () => true),
      embedder(p, calls),
      { caches, binding: bindingFor(OPEN_ACL, gen), denseText: QUERY },
    );
    expect(open.some((r) => r.path.startsWith("secret/"))).toBe(true);
    expect(calls.n).toBe(1);

    // Caller B differs only in its ACL. It must miss, re-run, and never see secret/**.
    const restricted = await cachedGraphSearch(
      v.db,
      baseOpts(v.id, (p_) => p_.startsWith("public/")),
      embedder(p, calls),
      { caches, binding: bindingFor(RESTRICTED_ACL, gen), denseText: QUERY },
    );
    expect(restricted.some((r) => r.path.startsWith("secret/"))).toBe(false);
    expect(restricted.some((r) => r.path.startsWith("public/"))).toBe(true);
    expect(calls.n).toBe(2); // it really re-ran; the isolation is not an artifact of a dead cache
    expect(caches.results.stats()).toMatchObject({ hits: 0, misses: 2 });

    v.cleanup();
  });

  it("does hit for the SAME caller — otherwise the isolation above proves nothing", async () => {
    const v = await setup();
    const caches = createRetrievalCaches({ maxEntries: 32, ttlMs: 60_000 });
    const p = provider();
    const calls = { n: 0 };
    const gen = readGeneration(v.db, v.id);
    const run = () =>
      cachedGraphSearch(
        v.db,
        baseOpts(v.id, () => true),
        embedder(p, calls),
        { caches, binding: bindingFor(OPEN_ACL, gen), denseText: QUERY },
      );

    const first = await run();
    const second = await run();
    expect(second.map((r) => r.chunk_id)).toEqual(first.map((r) => r.chunk_id));
    expect(caches.results.stats()).toMatchObject({ hits: 1, misses: 1 });
    // The hit skipped the embedding round-trip, not just the DB work — the whole point of keying
    // on the query TEXT rather than the query VECTOR.
    expect(calls.n).toBe(1);

    v.cleanup();
  });

  it("hands out copies — a caller mutating its results cannot rewrite the cached entry", async () => {
    const v = await setup();
    const caches = createRetrievalCaches({ maxEntries: 32, ttlMs: 60_000 });
    const p = provider();
    const calls = { n: 0 };
    const gen = readGeneration(v.db, v.id);
    const run = () =>
      cachedGraphSearch(
        v.db,
        baseOpts(v.id, () => true),
        embedder(p, calls),
        { caches, binding: bindingFor(OPEN_ACL, gen), denseText: QUERY },
      );

    const first = await run();
    const victim = first[0];
    expect(victim).toBeDefined();
    if (victim) victim.path = "tampered.md";
    first.length = 0;

    const second = await run();
    expect(second.length).toBeGreaterThan(0);
    expect(second.some((r) => r.path === "tampered.md")).toBe(false);

    v.cleanup();
  });
});

describe("THE-497 query-product cache: invalidation", () => {
  it("a content mutation bumps the generation, and the bump invalidates the entry", async () => {
    const v = await setup();
    const caches = createRetrievalCaches({ maxEntries: 32, ttlMs: 60_000 });
    const p = provider();
    const calls = { n: 0 };

    const before = readGeneration(v.db, v.id);
    await cachedGraphSearch(
      v.db,
      baseOpts(v.id, () => true),
      embedder(p, calls),
      { caches, binding: bindingFor(OPEN_ACL, before), denseText: QUERY },
    );
    expect(calls.n).toBe(1);

    const added = "# New\n\nalpha beta shared topic freshly written";
    writeFileSync(join(v.root, "public/new.md"), added);
    await indexNote(v.db, provider(), v.id, "public/new.md", added, false, () => 1);
    const after = readGeneration(v.db, v.id);
    expect(after).toBeGreaterThan(before);

    const results = await cachedGraphSearch(
      v.db,
      baseOpts(v.id, () => true),
      embedder(p, calls),
      { caches, binding: bindingFor(OPEN_ACL, after), denseText: QUERY },
    );
    expect(results.some((r) => r.path === "public/new.md")).toBe(true);
    expect(caches.results.stats()).toMatchObject({ hits: 0, misses: 2 });
    // ...but the ENCODING of the query text survived the bump and was reused: a vault mutation
    // cannot change what "alpha beta shared topic" embeds to. That asymmetry is why the two
    // products have different keys — the result carries the generation, the encoding does not.
    expect(calls.n).toBe(1);
    expect(caches.vectors.stats()).toMatchObject({ hits: 1, misses: 1 });

    v.cleanup();
  });

  it("expires on the TTL even when nothing bumped the generation", async () => {
    const v = await setup();
    let t = 0;
    const caches = createRetrievalCaches({ maxEntries: 32, ttlMs: 1000, now: () => t });
    const p = provider();
    const calls = { n: 0 };
    const gen = readGeneration(v.db, v.id);
    const run = () =>
      cachedGraphSearch(
        v.db,
        baseOpts(v.id, () => true),
        embedder(p, calls),
        { caches, binding: bindingFor(OPEN_ACL, gen), denseText: QUERY },
      );

    await run();
    t = 999;
    await run();
    expect(calls.n).toBe(1);
    t = 1000;
    await run();
    expect(calls.n).toBe(2);

    v.cleanup();
  });

  it("is an exact pass-through when no cache is supplied", async () => {
    const v = await setup();
    const p = provider();
    const calls = { n: 0 };
    const uncached = await cachedGraphSearch(
      v.db,
      baseOpts(v.id, () => true),
      embedder(p, calls),
      undefined,
    );
    const again = await cachedGraphSearch(
      v.db,
      baseOpts(v.id, () => true),
      embedder(p, calls),
      undefined,
    );
    expect(again.map((r) => r.chunk_id)).toEqual(uncached.map((r) => r.chunk_id));
    expect(calls.n).toBe(2); // every call embeds and searches, exactly as before THE-497

    v.cleanup();
  });

  it("returns results IDENTICAL to the uncached path, field for field", async () => {
    // The ticket's "no recall/nDCG regression" condition, asserted structurally rather than by
    // comparing two noisy metric runs: if the cached path returns the same objects in the same
    // order, no ranking metric computed over them can differ. Several queries, because a single
    // one could agree by coincidence on a tiny corpus.
    const v = await setup();
    const caches = createRetrievalCaches({ maxEntries: 32, ttlMs: 60_000 });
    const p = provider();
    const calls = { n: 0 };
    const gen = readGeneration(v.db, v.id);

    for (const q of ["alpha beta shared topic", "classified notes", "open topic"]) {
      const opts = { query: q, vaultId: v.id, finalTopK: 10, isReadable: () => true };
      const embed = async () => {
        calls.n++;
        const [vec] = await p.embed([q], { input: "query" });
        return { queryVec: vec ?? [] };
      };
      const plain = await cachedGraphSearch(v.db, opts, embed);
      const viaCache = await cachedGraphSearch(v.db, opts, embed, {
        caches,
        binding: bindingFor(OPEN_ACL, gen),
        denseText: q,
      });
      const onHit = await cachedGraphSearch(v.db, opts, embed, {
        caches,
        binding: bindingFor(OPEN_ACL, gen),
        denseText: q,
      });
      expect(viaCache).toEqual(plain);
      expect(onHit).toEqual(plain); // and the entry served from the cache matches too
    }

    expect(caches.results.stats()).toMatchObject({ hits: 3, misses: 3 });
    v.cleanup();
  });
});
