// THE-545: `ranking.metadataPrior` reached two of the four graphSearch call sites in
// knowledge-tools.ts. Enabling it changed vault_context and reflect, and silently did nothing on
// vault_graph_search (the primary search verb) or knowledge_search.
//
// Partial reachability is worse than no reachability: a knob that works on some surfaces invites a
// measurement on one surface to be read as describing the others.
//
// The instance was one missing conditional spread. The GENERATOR was that the options object was
// hand-assembled four times, so every future knob had to be remembered four times. These tests
// guard both layers:
//
//   1. a config-effect property test — every config-derived knob must reach the built options for
//      every call-site shape, so a knob added to the builder cannot be surface-selective;
//   2. a structural test — no call site may hand-assemble the options object again, because the
//      property test alone cannot see a site that bypasses the builder.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraphSearchOptions, type M7Deps } from "../src/tools/m7/knowledge-tools";
import { openMemoryDb } from "./helpers";

/** The minimum M7Deps the builder actually reads, plus whatever the case under test adds. */
function depsWith(extra: Partial<M7Deps>): M7Deps {
  return {
    embeddingProvider: { id: "test-model" },
    vaultRegistry: {},
    reranker: null,
    roles: null,
    ...extra,
  } as unknown as M7Deps;
}

/** The four call-site shapes in knowledge-tools.ts. `reranker` is the one genuine per-site
 *  difference: knowledge_search pins it to null on purpose (THE-441). */
const SITES = [
  { name: "vault_context", reranker: null as unknown, finalTopK: 10 },
  { name: "reflect", reranker: null as unknown, finalTopK: 10 },
  { name: "vault_graph_search", reranker: null as unknown, finalTopK: 20 },
  { name: "knowledge_search", reranker: null as unknown, finalTopK: 20 },
] as const;

function siteArgs(finalTopK: number) {
  return {
    route: { class: "standard" },
    query: "q",
    queryVec: [0.1, 0.2, 0.3],
    vaultId: "v",
    finalTopK,
    reranker: null,
    isReadable: () => true,
    // THE-852: buildGraphSearchOptions now resolves the ACL walk filter unconditionally. An
    // unmigrated db (no acl_path_sets table) plus an unrestricted (undefined) acl makes
    // resolveAclWalkFilter a no-op — `{}` — so this stays irrelevant to every knob assertion below.
    db: openMemoryDb(),
    acl: undefined,
    grantedScopes: new Set<string>(),
  };
}

/** Every knob the builder derives from config: the deps that enable it, and the assertion that it
 *  actually landed in the options handed to graphSearch. */
const KNOBS = [
  {
    name: "retrieval.rrfK",
    deps: { retrieval: { rrfK: 42 } },
    reached: (o: Record<string, unknown>) => o.rrfK === 42,
  },
  {
    name: "retrieval.densify",
    deps: { retrieval: { densify: { includeInWalk: true, derivedWeight: 0.25 } } },
    reached: (o: Record<string, unknown>) =>
      (o.densify as { derivedWeight?: number } | undefined)?.derivedWeight === 0.25,
  },
  {
    name: "retrieval.adaptiveRrf",
    deps: { retrieval: { adaptiveRrf: { enabled: true, gain: 0.4 } } },
    reached: (o: Record<string, unknown>) =>
      (o.adaptiveRrf as { gain?: number } | undefined)?.gain === 0.4,
  },
  {
    // THE-545: the knob that was missing on two of four surfaces.
    name: "ranking.metadataPrior",
    deps: {
      ranking: {
        metadataPrior: {
          enabled: true,
          rules: [{ field: "type", value: "decision", boost: 1.5 }],
          clampFraction: 0.2,
        },
      },
    },
    reached: (o: Record<string, unknown>) =>
      (o.metadataPrior as { clampFraction?: number } | undefined)?.clampFraction === 0.2,
  },
  {
    name: "activationFor",
    deps: { activationFor: () => 1 },
    reached: (o: Record<string, unknown>) => typeof o.activationFor === "function",
  },
] as const;

describe("graphSearch options threading (THE-545)", () => {
  // The property: knob x call-site. Every config knob must reach every surface. Before THE-545 the
  // metadataPrior row failed on vault_graph_search and knowledge_search.
  for (const knob of KNOBS) {
    for (const site of SITES) {
      it(`threads ${knob.name} to ${site.name}`, () => {
        const opts = buildGraphSearchOptions(
          depsWith(knob.deps as Partial<M7Deps>),
          siteArgs(site.finalTopK) as never,
        ) as unknown as Record<string, unknown>;
        expect(knob.reached(opts)).toBe(true);
      });
    }
  }

  it("omits a knob entirely when its config is absent (no accidental defaults)", () => {
    const opts = buildGraphSearchOptions(depsWith({}), siteArgs(10) as never) as unknown as Record<
      string,
      unknown
    >;
    // Absent config must not materialize the key at all: graphSearch distinguishes
    // "unset -> use its own default" from "set to undefined".
    for (const key of ["rrfK", "densify", "adaptiveRrf", "metadataPrior", "activationFor"]) {
      expect(Object.hasOwn(opts, key)).toBe(false);
    }
  });

  it("preserves the per-site reranker decision rather than defaulting it", () => {
    // knowledge_search pins reranker to null (THE-441) even when deps.reranker is configured.
    const configured = depsWith({ reranker: { rerank: async () => [] } as never });
    const opts = buildGraphSearchOptions(configured, {
      ...siteArgs(20),
      reranker: null,
    } as never) as unknown as Record<string, unknown>;
    expect(opts.reranker).toBeNull();
  });

  // The property test above only covers sites that CALL the builder. A hand-assembled call site
  // would bypass it entirely and silently reintroduce the exact defect -- so assert structurally
  // that no such site exists.
  //
  // WP2.3: the four call sites left knowledge-tools.ts in slice 2/3 (vault_context -> vault-context.ts,
  // reflect -> reflect.ts, vault_graph_search -> graph-search.ts, knowledge_search -> knowledge-search.ts).
  // Scanning knowledge-tools.ts alone would now find zero calls and the floor assertion below would
  // (correctly) refuse that as a pass — so this scans every file the sites actually live in.
  it("has no hand-assembled graphSearch options left in the knowledge/ tool factories", () => {
    const files = ["vault-context.ts", "reflect.ts", "graph-search.ts", "knowledge-search.ts"];
    const sources = files.map((f) =>
      readFileSync(join(__dirname, "..", "src", "tools", "m7", "knowledge", f), "utf8"),
    );

    // THE-497 moved every site from `graphSearch(...)` to `cachedGraphSearch(...)`; both shapes are
    // matched so this keeps failing on a hand-assembled site of either kind. That the floor below
    // caught the rename (0 calls read as "clean" until it refused) is the reason it is here.
    const inlineCalls = sources.flatMap(
      (src) => src.match(/(?:cached)?[gG]raphSearch\(\s*ctx\.db\s*,\s*\{/g) ?? [],
    );
    expect(inlineCalls).toEqual([]);

    // ...and every graphSearch call really does route through the builder.
    const totalCalls = sources.reduce(
      (n, src) => n + (src.match(/await (?:cachedG|g)raphSearch\(/g) ?? []).length,
      0,
    );
    const viaBuilder = sources.reduce(
      (n, src) => n + (src.match(/buildGraphSearchOptions\(deps,/g) ?? []).length,
      0,
    );
    expect(totalCalls).toBeGreaterThan(0); // an empty match must never read as a pass
    expect(viaBuilder).toBe(totalCalls);
  });
});
