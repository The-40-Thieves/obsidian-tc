// WP2 slice 1 (THE-233 follow-up): the invariant the schema/deps/retrieval-runtime extraction
// must hold provably still. `buildKnowledgeTools(deps)` returns the 10 M7 tools in a fixed array
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
      "Composite budgeted context in ONE call (the Honcho-style context() primitive): graph-reranked chunks packed to a token budget and grouped by note, recent synthesis patterns touching the query, open contradictions on the packed notes, and applicable past lessons (decision/lesson/postmortem chunks relevant to the query) — with source metadata and packing stats. include_work adds eligible work-memory episodes (the work-memory reader contract; explicit opt-in, never default). Omit query for session bootstrap: the queued thread is read from the memory folder's _next-session.md signal note, so every session opens with its applicable lessons (push, not pull). response_format=concise drops the route, budget and stats blocks, each chunk's source and hop and each lesson's via.",
    domain: "knowledge",
    requiredScopes: ["read:notes"],
    tags: ["external-network", "knowledge", "search"],
    hasPathAcl: false,
    inputKeys: [
      "include_lessons",
      "include_work",
      "k",
      "query",
      "response_format",
      "since",
      "token_budget",
      "vault",
      "verbosity",
    ],
    outputKeys: [
      "budget",
      "contradictions",
      "diff_since",
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
    tags: ["external-network", "knowledge"],
    hasPathAcl: false,
    inputKeys: ["citation_style", "detail", "k", "mode", "persist", "query", "scope", "vault"],
    outputKeys: [
      "answer",
      "available",
      "challenge",
      "excluded_count",
      "message",
      "mode",
      "model",
      "persisted",
      "route",
      "sources",
      "unresolved_citations",
      "vault",
    ],
  },
  {
    name: "vault_graph_search",
    description:
      "Cross-domain / multi-hop semantic search with wikilink graph expansion (GraphRAG). Seeds by vector similarity, expands through the links_to graph (vault_edges), and fuses by RRF. Run index_vault first so the edge graph is populated. Returns chunks tagged seed|expansion with hop + via_edge. Optional `vaults[]` federates the same query across additional vaults (max 8), fusing per-vault ranked lists by RRF; each result is tagged with its source vault. response_format=concise returns {chunk_id, path, content, rerank_score} per result (plus vault and changed_since_d when set) without source, hop, via_edge and root_seed, and drops route, query, hyde, variants_used, coverage, vaults_used and per_vault; mode_used, failed_variants and failed_vaults are kept.",
    domain: "knowledge",
    requiredScopes: ["read:notes"],
    tags: ["external-network", "knowledge", "search"],
    hasPathAcl: false,
    inputKeys: [
      "as_of",
      "final_top_k",
      "hypothetical_answer",
      "queries",
      "query",
      "response_format",
      "since",
      "vault",
      "vaults",
      "verbosity",
    ],
    outputKeys: [
      "coverage",
      "failed_variants",
      "failed_vaults",
      "hyde",
      "mode_used",
      "per_vault",
      "query",
      "results",
      "route",
      "variants_used",
      "vault",
      "vaults_used",
    ],
  },
  {
    name: "search_and_read",
    description:
      "Search a vault and return the top-k full notes in one call, instead of a search followed by read_notes. Ranking is vault_graph_search's, limited to notes you can read. mode=note (default) returns each note's frontmatter and body; mode=section returns the heading section each hit matched. k is at most 20. The result is held under the server's byte budget, shared equally across the notes: a note over its share is cut and marked truncated: true with size_bytes (its full size); fetch it whole with read_note. Anything that still does not fit comes back with next_cursor: repeat the same call plus cursor until it is null. An item that cannot be returned is a per-item error with its rank (a missing note and an unreadable one look the same). A cursor is bound to the caller, the tool and these exact arguments, and expires. response_format=concise returns {path, rank, score, body, content_hash} per note without frontmatter (note mode) or chunk_id (section mode); size_bytes and truncated appear only on a truncated item, and section_resolved only when false.",
    domain: "search",
    requiredScopes: ["read:notes"],
    tags: ["external-network", "knowledge", "search"],
    hasPathAcl: false,
    inputKeys: [
      "cursor",
      "k",
      "max_bytes_per_item",
      "mode",
      "query",
      "response_format",
      "vault",
      "verbosity",
    ],
    outputKeys: ["errors", "mode", "next_cursor", "notes", "vault"],
  },
  {
    name: "diagnose_retrieval",
    description:
      "Explain why a specific note was or was not returned for a query. Re-runs the retrieval pipeline with per-stage tracing and reports, for that one note, where it was present, its score and rank where a stage produces them, and the first stage that dropped it. Read-only and non-mutating; reports nothing about paths the caller cannot read. response_format=concise returns returned, dropped_at and summary without the per-stage trace.",
    domain: "knowledge",
    requiredScopes: ["read:notes"],
    tags: ["diagnostics", "external-network", "knowledge", "search"],
    hasPathAcl: false,
    inputKeys: ["final_top_k", "path", "query", "response_format", "vault", "verbosity"],
    outputKeys: ["dropped_at", "path", "query", "returned", "stages", "summary", "vault"],
  },
  {
    name: "explain_answer",
    description:
      "Explain what an answer actually used: walks retrieval -> chunk -> citation -> episode for one session or time window and reports each link with how well it is known. Distinguishes a retrieval the citation pass never judged from one it judged and rejected, and a chunk whose note no longer exists from one that was never used. Read-only; reports nothing about paths the caller cannot read. response_format=concise drops the summary counts and each link's retrieval echo (time, surface, query text, rank); the caveat and the citation-pass record stay.",
    domain: "knowledge",
    requiredScopes: ["read:notes"],
    tags: ["diagnostics", "knowledge", "provenance"],
    hasPathAcl: false,
    inputKeys: ["limit", "response_format", "session_id", "since", "until", "vault", "verbosity"],
    // EMPTY ON PURPOSE, and the only entry here that is. This tool's output is a `z.union` — the
    // same `available: false | available: true & shape` envelope m8's `availableWith` produces —
    // because the experiential store may be closed, which is a configuration state rather than a
    // failed call. `topLevelShape` returns `undefined` for a union, correctly: a union has no one
    // top-level shape. Every other m7 tool is a flat object, so this is the first union to reach
    // this gate. Filling these in by hand would assert a shape the schema does not declare.
    outputKeys: [],
  },
  {
    name: "knowledge_search",
    description:
      "Semantic + keyword search over a vendor / external-docs corpus (a reserved read-only docs vault), with wikilink graph expansion and RRF fusion. The docs-scoped analogue of vault_graph_search: bind `vault` to the docs corpus id. Returns source-attributed chunks tagged seed|expansion. Gated on read:docs so it stays isolated from the private vault. response_format=concise returns {chunk_id, path, content, rerank_score} per result without source, hop, via_edge and root_seed, and drops route and coverage.",
    domain: "docs",
    requiredScopes: ["read:docs"],
    tags: ["docs", "external-network", "knowledge", "search"],
    hasPathAcl: false,
    inputKeys: ["as_of", "final_top_k", "query", "response_format", "since", "vault", "verbosity"],
    outputKeys: ["coverage", "mode_used", "results", "route", "vault"],
  },
  {
    name: "knowledge_get_critical",
    description:
      "List the critical-severity docs in a vendor / external-docs corpus: the breaking changes, security issues, and production gotchas to read before starting work. A tight metadata pre-filter over frontmatter severity == 'critical', not a search. Optionally narrow by `source` (the vendor or tool the doc is about). Gated on read:docs so it stays isolated from the private vault. response_format=concise drops the count and the constant severity of each item.",
    domain: "docs",
    requiredScopes: ["read:docs"],
    tags: ["docs", "knowledge"],
    hasPathAcl: false,
    inputKeys: ["limit", "response_format", "source", "vault", "verbosity"],
    outputKeys: ["count", "items", "vault"],
  },
  {
    name: "knowledge_challenge",
    description:
      "Red-team a proposal against your documented decision history. Retrieves decision-bearing chunks (02-projects, 04-writing/Published, 09-reference/system-reviews, 09-reference/syntheses) and asks the inference gateway to flag DIRECT_CONTRADICTION / PATTERN_REPEAT / REVERSAL / HIDDEN_DEPENDENCY. Requires the gateway; reports unavailable when it is not configured.",
    domain: "knowledge",
    requiredScopes: ["read:notes"],
    tags: ["external-network", "knowledge"],
    hasPathAcl: false,
    inputKeys: ["proposal", "vault"],
    outputKeys: [
      "available",
      "contradiction_count",
      "evidence_count",
      "excluded_count",
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
  it("keeps the ordered public metadata of the 10 M7 tools byte-identical", () => {
    const tools = buildKnowledgeTools(stubDeps(), () => undefined);
    const actual = tools.map(toSnapshot);
    expect(stableStringify(actual)).toBe(stableStringify(EXPECTED));
  });
});
