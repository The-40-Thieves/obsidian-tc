// THE-497: the cache mechanics (bound, TTL, LRU order, stats) and the structural hash the key is
// built from. The isolation and invalidation guarantees are in query-cache-isolation.test.ts; the
// "every option participates in the key" gate is in query-cache-key-coverage.test.ts.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashInto,
  QueryCache,
  type QueryCacheBinding,
  queryVectorsKey,
  structuralKey,
} from "../src/search/query_cache";

const binding = (over: Partial<QueryCacheBinding> = {}): QueryCacheBinding => ({
  aclFingerprint: "a".repeat(64),
  generation: 7,
  representation: {
    id: "local",
    provider: "ollama",
    model: "nomic-embed-text",
    dimensions: 768,
    sparse: false,
    colbert: false,
  },
  ...over,
});

describe("THE-497 QueryCache mechanics", () => {
  it("returns a stored value and counts the hit", () => {
    const c = new QueryCache<number>({ maxEntries: 4, ttlMs: 1000, now: () => 0 });
    c.set("k", 42);
    expect(c.get("k")).toBe(42);
    expect(c.stats()).toMatchObject({ hits: 1, misses: 0, stores: 1 });
  });

  it("misses a key it never stored", () => {
    const c = new QueryCache<number>({ maxEntries: 4, ttlMs: 1000, now: () => 0 });
    expect(c.get("nope")).toBeUndefined();
    expect(c.stats()).toMatchObject({ hits: 0, misses: 1 });
  });

  it("expires an entry at the TTL and reports it as an expiration, not a silent miss", () => {
    let t = 0;
    const c = new QueryCache<string>({ maxEntries: 4, ttlMs: 100, now: () => t });
    c.set("k", "v");
    t = 99;
    expect(c.get("k")).toBe("v");
    t = 100; // expiresAt <= now -> gone
    expect(c.get("k")).toBeUndefined();
    expect(c.stats()).toMatchObject({ expirations: 1, misses: 1, hits: 1 });
    expect(c.size).toBe(0);
  });

  it("never exceeds maxEntries, evicting the least recently USED (not merely oldest stored)", () => {
    const c = new QueryCache<number>({ maxEntries: 3, ttlMs: 1000, now: () => 0 });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.get("a"); // 'a' is now the most recently used; 'b' is the LRU
    c.set("d", 4);
    expect(c.size).toBe(3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("d")).toBe(4);
    expect(c.stats().evictions).toBe(1);
  });

  it("re-storing a key refreshes it rather than growing the map", () => {
    const c = new QueryCache<number>({ maxEntries: 2, ttlMs: 1000, now: () => 0 });
    c.set("a", 1);
    c.set("a", 2);
    expect(c.size).toBe(1);
    expect(c.get("a")).toBe(2);
  });

  it("clear() drops everything", () => {
    const c = new QueryCache<number>({ maxEntries: 2, ttlMs: 1000, now: () => 0 });
    c.set("a", 1);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get("a")).toBeUndefined();
  });

  it("refuses a nonsensical bound rather than silently caching nothing or everything", () => {
    expect(() => new QueryCache({ maxEntries: 0, ttlMs: 1000 })).toThrow(/maxEntries/);
    expect(() => new QueryCache({ maxEntries: 1.5, ttlMs: 1000 })).toThrow(/maxEntries/);
    expect(() => new QueryCache({ maxEntries: 1, ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() => new QueryCache({ maxEntries: 1, ttlMs: Number.NaN })).toThrow(/ttlMs/);
  });
});

describe("THE-497 structuralKey", () => {
  it("is deterministic and insensitive to object key ORDER", () => {
    expect(structuralKey({ a: 1, b: 2 })).toBe(structuralKey({ b: 2, a: 1 }));
  });

  it("is sensitive to ARRAY order (a ranking is not a set)", () => {
    expect(structuralKey(["a", "b"])).not.toBe(structuralKey(["b", "a"]));
  });

  it("treats an explicitly-undefined property as absent (both read as 'use the default')", () => {
    expect(structuralKey({ a: 1, b: undefined })).toBe(structuralKey({ a: 1 }));
  });

  it("cannot be collided by re-splitting adjacent strings (length-prefixed encoding)", () => {
    // Without length prefixes both stream the bytes "abc" and collide, so two different
    // configurations would share one cache entry.
    expect(structuralKey(["ab", "c"])).not.toBe(structuralKey(["a", "bc"]));
    expect(structuralKey({ ab: "c" })).not.toBe(structuralKey({ a: "bc" }));
  });

  it("distinguishes types that stringify alike", () => {
    expect(structuralKey(1)).not.toBe(structuralKey("1"));
    expect(structuralKey(null)).not.toBe(structuralKey("null"));
    expect(structuralKey(true)).not.toBe(structuralKey("true"));
    expect(structuralKey([1])).not.toBe(structuralKey(1));
  });

  it("hashes numbers bit-exactly (0.1+0.2 is not 0.3; -0 is not 0)", () => {
    expect(structuralKey(0.1 + 0.2)).not.toBe(structuralKey(0.3));
    expect(structuralKey(-0)).not.toBe(structuralKey(0));
  });

  it("takes the fast numeric-array path without changing the result's meaning", () => {
    // Same values -> same key; one flipped float -> different key. (The fast path exists for
    // 768-4096 element embeddings; it must stay injective.)
    const a = Array.from({ length: 768 }, (_, i) => i / 768);
    const b = [...a];
    b[500] = 0.5000001;
    expect(structuralKey(a)).toBe(structuralKey([...a]));
    expect(structuralKey(a)).not.toBe(structuralKey(b));
  });

  it("folds every function to ONE sentinel — identity is deliberately not keyed", () => {
    expect(structuralKey({ f: () => 1 })).toBe(structuralKey({ f: () => 2 }));
    // ...but presence still differs from absence.
    expect(structuralKey({ f: () => 1 })).not.toBe(structuralKey({}));
  });

  it("hashInto is usable directly against a node Hash", () => {
    const h = createHash("sha256");
    hashInto(h, { a: 1 });
    expect(h.digest("hex")).toBe(structuralKey({ a: 1 }));
  });

  it("returns a fixed-width sha256 hex digest", () => {
    expect(structuralKey({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("THE-497 queryVectorsKey", () => {
  it("is stable for the same (query, representation, caller)", () => {
    expect(queryVectorsKey("dogs", binding())).toBe(queryVectorsKey("dogs", binding()));
  });

  it("ignores the vault generation — an encoding of TEXT cannot go stale on a content change", () => {
    expect(queryVectorsKey("dogs", binding({ generation: 1 }))).toBe(
      queryVectorsKey("dogs", binding({ generation: 999 })),
    );
  });

  it("changes with the query text", () => {
    expect(queryVectorsKey("dogs", binding())).not.toBe(queryVectorsKey("cats", binding()));
  });

  it("changes with every field of the representation (a vector means something different)", () => {
    const base = binding();
    const rep = base.representation;
    const variants = [
      { ...rep, id: "other" },
      { ...rep, provider: "openai" },
      { ...rep, model: "text-embedding-3-small" },
      { ...rep, dimensions: 1536 },
      { ...rep, sparse: true },
      { ...rep, colbert: true },
    ];
    for (const representation of variants) {
      expect(queryVectorsKey("dogs", binding({ representation }))).not.toBe(
        queryVectorsKey("dogs", base),
      );
    }
  });

  it("changes with the caller's ACL fingerprint", () => {
    expect(queryVectorsKey("dogs", binding({ aclFingerprint: "b".repeat(64) }))).not.toBe(
      queryVectorsKey("dogs", binding()),
    );
  });
});
