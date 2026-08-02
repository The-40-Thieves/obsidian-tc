// THE-497 — the gate that keeps the cache key honest as GraphSearchOptions grows.
//
// The failure this exists to prevent: someone adds a retrieval knob, the key does not cover it, and
// the cache serves a result computed under a DIFFERENT configuration. Nothing crashes, no test goes
// red, the numbers are just quietly wrong. GraphSearchOptions has ~35 fields and gains more most
// months, so "remember to update the key" is not a control.
//
// So this test derives the field list from the SOURCE (not from a hand-kept copy) and asserts a
// total partition of it:
//
//   every field  =  KEYED (mutating it changes the key)
//                ∪  FUNCTION_FIELDS (identity deliberately unkeyed — each one reviewed in
//                   query_cache.ts's comment, which is what a reviewer is pointed at when this fails)
//                ∪  DERIVED_VECTOR_FIELDS (a pure function of the query text + representation,
//                   both already in the key)
//                ∪  {reranker} (a bare function with no identity; presence/absence is keyed)
//
// Adding a field without deciding which bucket it belongs in fails here, by name.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GraphSearchOptions } from "../src/search/graph_search";
import {
  DERIVED_VECTOR_FIELDS,
  FUNCTION_FIELDS,
  graphSearchKey,
  type QueryCacheBinding,
  TRACE_SELECTOR_FIELDS,
} from "../src/search/query_cache";

const TYPES_SRC = fileURLToPath(
  new URL("../src/search/graph_search_stages/types.ts", import.meta.url),
);

/** Top-level fields of the interface: exactly two spaces of indent (nested option objects sit at
 *  four). A zero-length or implausibly small parse is a BROKEN PARSER, not a shrunken interface —
 *  see the floor assertion below. */
function declaredOptionFields(): string[] {
  const src = readFileSync(TYPES_SRC, "utf8");
  const start = src.indexOf("export interface GraphSearchOptions {");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start, end);
  return [
    ...new Set(
      [...body.matchAll(/^ {2}([a-zA-Z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1] as string),
    ),
  ];
}

const DENSE = "alpha beta";

const binding = (over: Partial<QueryCacheBinding> = {}): QueryCacheBinding => ({
  aclFingerprint: "a".repeat(64),
  generation: 3,
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

/** A fully-populated options object: every keyed field set to a NON-default value, so a mutation
 *  below is always a real change rather than a no-op against a default. */
const BASE: Omit<GraphSearchOptions, "queryVec"> = {
  query: "alpha beta",
  vaultId: "v1",
  model: "nomic-embed-text",
  seedCount: 30,
  finalTopK: 20,
  maxExpansionChunks: 50,
  hopLimit: 2,
  similarityThreshold: 0.2,
  densify: { includeInWalk: true, derivedWeight: 0.5 },
  fusionMode: "graph_rrf",
  rrfK: 10,
  rerankPool: 40,
  adaptiveRrf: { enabled: true, gain: 0.5 },
  lexical: { enabled: true, count: 30 },
  sparseCount: 30,
  colbertPool: 40,
  maxPerCluster: 3,
  graphStream: { enabled: true, expansionSeeds: 8, perSeedCap: 3, hubDegreeCap: 40 },
  smoothExpansion: { enabled: true, lambda: 0.8, hubMu: 75, hubGamma: 6 },
  diversify: { maxPerNote: 2, mmr: { enabled: true, lambda: 0.7 } },
  gatedRerank: { enabled: true, hardTop1: 0.55, hardZ: 1.2, pool: 20 },
  decay: { enabled: true, lambda: 0.005, nowMs: 1_000_000 },
  metadataPrior: {
    enabled: true,
    rules: [{ field: "type", value: "adr", boost: 0.2 }],
    clampFraction: 0.5,
  },
  router: { enabled: true, simThreshold: 0.62, margin: 0.08, zThreshold: 1.5 },
  convex: { alpha: 0.7 },
  temporal: { enabled: true, count: 30, nowMs: 1_000_000 },
  bubbleSafe: { enabled: true, k: 0.2 },
};

/** One mutation per keyed field. Each must change the cache key. */
const MUTATIONS: Array<[string, Partial<Omit<GraphSearchOptions, "queryVec">>]> = [
  ["query", { query: "gamma delta" }],
  ["vaultId", { vaultId: "v2" }],
  ["model", { model: "bge-m3" }],
  ["seedCount", { seedCount: 31 }],
  ["finalTopK", { finalTopK: 21 }],
  ["maxExpansionChunks", { maxExpansionChunks: 51 }],
  ["hopLimit", { hopLimit: 3 }],
  ["similarityThreshold", { similarityThreshold: 0.25 }],
  ["densify", { densify: { includeInWalk: false, derivedWeight: 0.5 } }],
  ["fusionMode", { fusionMode: "convex" }],
  ["rrfK", { rrfK: 60 }],
  ["rerankPool", { rerankPool: 41 }],
  ["adaptiveRrf", { adaptiveRrf: { enabled: true, gain: 0.4 } }],
  ["lexical", { lexical: { enabled: false, count: 30 } }],
  ["sparseCount", { sparseCount: 31 }],
  ["colbertPool", { colbertPool: 41 }],
  ["maxPerCluster", { maxPerCluster: 4 }],
  ["graphStream", { graphStream: { enabled: true, expansionSeeds: 9 } }],
  ["smoothExpansion", { smoothExpansion: { enabled: true, lambda: 0.9 } }],
  // THE-695: both MUST be keyed. aclWalkFilter changes which nodes the walk may traverse, and
  // aclSetId names WHOSE permitted set it traverses under — two callers with different sets would
  // otherwise share a cache entry, which is the one mistake this whole ticket exists to prevent.
  // aclFingerprint is already in QueryCacheBinding, but that is the binding half; a field on
  // GraphSearchOptions that changes results has to be keyed on its own terms.
  ["aclWalkFilter", { aclWalkFilter: { enabled: true } }],
  ["aclSetId", { aclSetId: 7 }],
  ["diversify", { diversify: { maxPerNote: 2, mmr: { enabled: true, lambda: 0.6 } } }],
  ["gatedRerank", { gatedRerank: { enabled: true, hardTop1: 0.6 } }],
  ["decay", { decay: { enabled: true, lambda: 0.006 } }],
  [
    "metadataPrior",
    { metadataPrior: { enabled: true, rules: [{ field: "type", value: "adr", boost: 0.3 }] } },
  ],
  ["router", { router: { enabled: false } }],
  ["convex", { convex: { alpha: 0.6 } }],
  ["temporal", { temporal: { enabled: true, count: 31 } }],
  ["bubbleSafe", { bubbleSafe: { enabled: true, k: 0.3 } }],
];

describe("THE-497 graph-search cache key covers every option", () => {
  it("parses the interface from source (a broken parser must fail, not report clean)", () => {
    const fields = declaredOptionFields();
    // Floor: the interface had 35 fields when this landed. A parse well below that means the regex
    // or the file moved — exactly the "green because it saw nothing" failure this repo's other
    // source-scan gates are built to refuse.
    expect(fields.length).toBeGreaterThanOrEqual(30);
    expect(fields).toContain("query");
    expect(fields).toContain("isReadable");
  });

  it("partitions every declared field into keyed / reviewed-unkeyed", () => {
    const declared = new Set(declaredOptionFields());
    const accounted = new Set<string>([
      ...MUTATIONS.map(([name]) => name),
      ...FUNCTION_FIELDS,
      ...DERIVED_VECTOR_FIELDS,
      // THE-632: selects WHICH note the trace follows; never changes results, so unkeyed. See
      // TRACE_SELECTOR_FIELDS in query_cache.ts for the cache-HIT caveat that comes with it.
      ...TRACE_SELECTOR_FIELDS,
      "reranker",
    ]);
    const unaccounted = [...declared].filter((f) => !accounted.has(f));
    // If this fails: a new GraphSearchOptions field exists that the cache key has not been decided
    // about. Add it to MUTATIONS (it affects results -> must be keyed), or to FUNCTION_FIELDS /
    // DERIVED_VECTOR_FIELDS in query_cache.ts with a written reason.
    expect(unaccounted).toEqual([]);
    // ...and nothing accounted-for has been deleted from the interface without cleanup here.
    expect([...accounted].filter((f) => !declared.has(f))).toEqual([]);
  });

  it.each(MUTATIONS)("changing %s changes the key", (_name, patch) => {
    expect(graphSearchKey({ ...BASE, ...patch }, binding(), DENSE)).not.toBe(
      graphSearchKey(BASE, binding(), DENSE),
    );
  });

  it("is stable when nothing changes", () => {
    expect(graphSearchKey({ ...BASE }, binding(), DENSE)).toBe(
      graphSearchKey({ ...BASE }, binding(), DENSE),
    );
  });

  it("keys the caller (ACL fingerprint) and the vault state (generation)", () => {
    expect(graphSearchKey(BASE, binding({ aclFingerprint: "b".repeat(64) }), DENSE)).not.toBe(
      graphSearchKey(BASE, binding(), DENSE),
    );
    expect(graphSearchKey(BASE, binding({ generation: 4 }), DENSE)).not.toBe(
      graphSearchKey(BASE, binding(), DENSE),
    );
  });

  it("keys the representation — a re-embedded vault is a different product", () => {
    const rep = binding().representation;
    expect(
      graphSearchKey(BASE, binding({ representation: { ...rep, model: "bge-m3" } }), DENSE),
    ).not.toBe(graphSearchKey(BASE, binding(), DENSE));
    expect(
      graphSearchKey(BASE, binding({ representation: { ...rep, sparse: true } }), DENSE),
    ).not.toBe(graphSearchKey(BASE, binding(), DENSE));
  });

  it("keys the PRESENCE of a reranker but not which one (Reranker has no id to key on)", () => {
    const withReranker = { ...BASE, reranker: async () => [] };
    const otherReranker = {
      ...BASE,
      reranker: async () => [{ index: 0, relevanceScore: 1 }],
    };
    expect(graphSearchKey(withReranker, binding(), DENSE)).not.toBe(
      graphSearchKey(BASE, binding(), DENSE),
    );
    expect(graphSearchKey(withReranker, binding(), DENSE)).toBe(
      graphSearchKey(otherReranker, binding(), DENSE),
    );
  });

  it("ignores the derived vectors — they are a function of the query text + representation", () => {
    const withVectors = {
      ...BASE,
      querySparse: { "1": 0.5, "2": 0.25 },
    } as Omit<GraphSearchOptions, "queryVec">;
    expect(graphSearchKey(withVectors, binding(), DENSE)).toBe(
      graphSearchKey(BASE, binding(), DENSE),
    );
  });

  it("keys a callback's PRESENCE — an absent isReadable is an UNFILTERED search", () => {
    // The fail-safe direction. A call site that omits isReadable returns results no ACL filtered;
    // that must never share an entry with a filtered call, and the ACL fingerprint cannot see the
    // difference (it describes the configured ACL, not whether the caller wired it up).
    const filtered = { ...BASE, isReadable: (p: string) => p.startsWith("public/") };
    expect(graphSearchKey(filtered, binding(), DENSE)).not.toBe(
      graphSearchKey(BASE, binding(), DENSE),
    );
  });

  it("does NOT key a callback's identity — the ACL fingerprint stands in for isReadable", () => {
    // Sound because every dispatch derives isReadable from (ACL config, granted scopes), which is
    // exactly what aclFingerprint hashes. query-cache-isolation.test.ts proves the end-to-end
    // behaviour on a real vault; this pins the mechanism.
    const a = { ...BASE, isReadable: (p: string) => p.startsWith("public/") };
    const b = { ...BASE, isReadable: (p: string) => !p.startsWith("secret/") };
    expect(graphSearchKey(a, binding(), DENSE)).toBe(graphSearchKey(b, binding(), DENSE));
    // Different callers, same predicate shape -> still separated, by the fingerprint alone.
    expect(graphSearchKey(a, binding({ aclFingerprint: "c".repeat(64) }), DENSE)).not.toBe(
      graphSearchKey(a, binding(), DENSE),
    );
  });

  it("keys the DENSE-embedded text separately from the query (THE-451 HyDE)", () => {
    // Under HyDE the dense arm embeds a hypothetical ANSWER while opts.query stays the raw question
    // for the lexical arms. Two calls that differ only in the hypothetical answer are different
    // retrievals and must not share an entry — the key would be blind to it without denseText.
    expect(graphSearchKey(BASE, binding(), "a hypothetical answer")).not.toBe(
      graphSearchKey(BASE, binding(), DENSE),
    );
  });
});
