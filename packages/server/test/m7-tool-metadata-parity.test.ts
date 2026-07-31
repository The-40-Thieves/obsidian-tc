// WP2 slice 1 (THE-233 follow-up): the invariant the schema/deps/retrieval-runtime extraction
// must hold provably still. `buildKnowledgeTools(deps)` returns the 7 M7 tools in a fixed array
// order; a caller-visible tool has exactly the shape it declares — name, description, domain,
// requiredScopes, tags, whether it declares a `pathAcl` extractor, and the top-level keys of its
// input/output schema. None of that is allowed to move while the file underneath it is split into
// knowledge/schemas.ts, knowledge/deps.ts and knowledge/retrieval-runtime.ts.
//
// Deliberately an inline expected constant, NOT `toMatchSnapshot()`: there is no `__snapshots__`
// directory under packages/server/test, so an auto-written snapshot would be created-and-pass on
// the very first run, proving nothing. An inline literal has to be edited on purpose.
//
// Both snapshot and expectation are run through a stable (key-sorted) JSON serializer before
// comparison, so a key-order accident in either the code under test or this file can never produce
// a false pass.
import { describe, expect, it } from "vitest";
import { buildKnowledgeTools, type M7Deps } from "../src/tools/m7/knowledge-tools";
import { VaultRegistry } from "../src/vault/registry";
import { topLevelShape } from "./schema-introspect";

interface ToolSnapshot {
  name: string;
  description: string;
  domain: string | undefined;
  requiredScopes: string[];
  tags: string[];
  hasPathAcl: boolean;
  inputKeys: string[];
  outputKeys: string[];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toSnapshot(tool: ReturnType<typeof buildKnowledgeTools>[number]): ToolSnapshot {
  const inputShape = topLevelShape(tool.inputSchema) ?? {};
  const outputShape = topLevelShape(tool.outputSchema) ?? {};
  return {
    name: tool.name,
    description: tool.description,
    domain: tool.domain,
    requiredScopes: [...tool.requiredScopes].sort(),
    tags: [...(tool.tags ?? [])].sort(),
    hasPathAcl: tool.pathAcl !== undefined,
    inputKeys: Object.keys(inputShape).sort(),
    outputKeys: Object.keys(outputShape).sort(),
  };
}

const EXPECTED: ToolSnapshot[] = [
  {
    name: "vault_context",
    description:
      "Composite budgeted context in ONE call (the Honcho-style context() primitive): graph-reranked chunks packed to a token budget and grouped by note, recent synthesis patterns touching the query, open contradictions on the packed notes, and applicable past lessons (decision/lesson/postmortem chunks relevant to the query) — with source metadata and packing stats. include_work adds eligible work-memory episodes (the THE-229 reader contract; explicit opt-in, never default). Omit query for session bootstrap: the queued thread is read from the memory folder's _next-session.md signal note, so every session opens with its applicable lessons (push, not pull).",
    domain: "knowledge",
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "search"],
    hasPathAcl: false,
    inputKeys: ["include_lessons", "include_work", "k", "query", "token_budget", "vault"],
    outputKeys: [
      "budget",
      "contradictions",
      "episodes",
      "lessons",
      "notes",
      "prefetch_generated_at",
      "prefetched",
      "query_source",
      "route",
      "signal",
      "signal_hash",
      "stats",
      "syntheses",
      "vault",
    ],
  },
  {
    name: "reflect",
    description:
      "The reflect verb (retain/recall/reflect): recall over the vault, then a gateway synthesis pass — one on-demand, query-scoped operation returning a grounded answer with source provenance. mode 'challenge' runs the adversarial red-team over the decision-bearing recall instead (the knowledge_challenge core). persist: true writes the answer as a derived note under the memory folder's reflections/ with source_model + chunk provenance (requires write:notes). Degrades gracefully: without the inference gateway, recall still returns sources with available: false. The sleep-time half (episode-eligibility evaluator + preference profile) runs via the `obsidian-tc reflect` CLI command.",
    domain: "knowledge",
    requiredScopes: ["read:notes"],
    tags: ["knowledge"],
    hasPathAcl: false,
    inputKeys: ["k", "mode", "persist", "query", "scope", "vault"],
    outputKeys: [
      "answer",
      "available",
      "challenge",
      "message",
      "mode",
      "model",
      "persisted",
      "route",
      "sources",
      "vault",
    ],
  },
  {
    name: "vault_graph_search",
    description:
      "Cross-domain / multi-hop semantic search with wikilink graph expansion (GraphRAG). Seeds by vector similarity, expands through the links_to graph (vault_edges), and fuses by RRF. Run index_vault first so the edge graph is populated. Returns chunks tagged seed|expansion with hop + via_edge.",
    domain: "knowledge",
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "search"],
    hasPathAcl: false,
    inputKeys: ["final_top_k", "hypothetical_answer", "queries", "query", "vault"],
    outputKeys: [
      "coverage",
      "hyde",
      "mode_used",
      "query",
      "results",
      "route",
      "variants_used",
      "vault",
    ],
  },
  {
    name: "knowledge_search",
    description:
      "Semantic + keyword search over a vendor / external-docs corpus (a reserved read-only docs vault), with wikilink graph expansion and RRF fusion. The docs-scoped analogue of vault_graph_search: bind `vault` to the docs corpus id. Returns source-attributed chunks tagged seed|expansion. Gated on read:docs so it stays isolated from the private vault.",
    domain: "docs",
    requiredScopes: ["read:docs"],
    tags: ["docs", "knowledge", "search"],
    hasPathAcl: false,
    inputKeys: ["final_top_k", "query", "vault"],
    outputKeys: ["coverage", "mode_used", "results", "route", "vault"],
  },
  {
    name: "knowledge_get_critical",
    description:
      "List the critical-severity docs in a vendor / external-docs corpus: the breaking changes, security issues, and production gotchas to read before starting work. A tight metadata pre-filter over frontmatter severity == 'critical', not a search. Optionally narrow by `source` (the vendor or tool the doc is about). Gated on read:docs so it stays isolated from the private vault.",
    domain: "docs",
    requiredScopes: ["read:docs"],
    tags: ["docs", "knowledge"],
    hasPathAcl: false,
    inputKeys: ["limit", "source", "vault"],
    outputKeys: ["count", "items", "vault"],
  },
  {
    name: "knowledge_challenge",
    description:
      "Red-team a proposal against your documented decision history. Retrieves decision-bearing chunks (02-projects, 04-writing/Published, 09-reference/system-reviews, 09-reference/syntheses) and asks the inference gateway to flag DIRECT_CONTRADICTION / PATTERN_REPEAT / REVERSAL / HIDDEN_DEPENDENCY. Requires the gateway; reports unavailable when it is not configured.",
    domain: "knowledge",
    requiredScopes: ["read:notes"],
    tags: ["knowledge"],
    hasPathAcl: false,
    inputKeys: ["proposal", "vault"],
    outputKeys: [
      "available",
      "contradiction_count",
      "evidence_count",
      "message",
      "model",
      "output",
      "vault",
    ],
  },
  {
    name: "list_contradictions",
    description:
      "List open contradictions (judge_verdict: 'contradiction' | 'tension') touching any of the given notes — the same detector output vault_context/reflect/knowledge_challenge surface indirectly, exposed directly for standalone inspection. Read-only.",
    domain: "knowledge",
    requiredScopes: ["read:notes"],
    tags: ["knowledge"],
    hasPathAcl: true,
    inputKeys: ["paths", "vault"],
    outputKeys: ["available", "contradictions", "message", "total", "vault"],
  },
];

function stubDeps(): M7Deps {
  return {
    vaultRegistry: new VaultRegistry([{ id: "main", name: "main", path: "/tmp/does-not-exist" }]),
    embeddingProvider: {
      id: "stub",
      provider: "ollama",
      model: "stub",
      dimensions: 8,
      embed: async () => {
        throw new Error("embed must not be called by this test — it only inspects metadata");
      },
    },
    reranker: null,
    roles: null,
  };
}

describe("m7 tool metadata parity (WP2 invariant)", () => {
  it("keeps the ordered public metadata of the 7 M7 tools byte-identical", () => {
    const tools = buildKnowledgeTools(stubDeps());
    const actual = tools.map(toSnapshot);
    expect(stableStringify(actual)).toBe(stableStringify(EXPECTED));
  });
});
