# Graph densification pass (graphify spec-donor port)

Status: building (2026-07-13). Branch `feat/graph-densification`.
Lineage: vault decisions `2026-07-02-graphify-plur-plane-split` (spec donor, Seam 1 densification)
+ `2026-06-26-graphify-separate-non-vault-mcp` (vault-egress boundary). Evidence base:
`08-research/graphify-deep-dive-v8`.

## Why (reconciled to the SHIPPED engine, not the vault-note plan)

The July-2 notes assume the converged engine (pgvector, recursive-CTE, plur Domain-24 proxy).
The shipped engine is Bun/SQLite: `vault_edges` + `expandGraphLiteral` (recursive CTE) + RRF.
Grounded facts (verified in-tree 2026-07-13):

- `vault_edges` today writes ONLY `edge_type in {links_to, unresolved}`, always `edge_kind='literal'`
  (`search/edges.ts:9,133`). The `'virtual'` kind exists in the schema but is UNPOPULATED.
- `expandGraphLiteral` walks `edge_type='links_to'` only (`search/graph_expand.ts:62-64`). Graph
  traversal is wikilink-only; ALL semantic reach comes from the dense/BM25 SEED streams, never edges.
- So graphify's core diagnosis — "the vault graph holds only human-authored edges, so multi-hop
  queries cannot traverse" — is STILL LIVE and unbuilt. THE-406 enrichment improved chunk quality,
  not graph density.

Reframe (the insight): graphify builds `semantically_similar_to` density with an LLM pass (the whole
egress blocker). The shipped engine ALREADY computes embeddings graphify lacks — so we build the same
density from vec0 kNN, DETERMINISTICALLY, with zero remote egress, into the schema slot already waiting.

## Measured caution (do not assume this wins)

`graph_expand.ts:9-14`: the THE-135 frontier-leaf virtual-hop (query-time pull of edgeless leaves
toward the query embedding) "sat at an 80% bridge-recall ceiling through the whole v1.1 ladder" and
was NOT ported. The current champion bridge recall is 0.831 — already past that ceiling. Densification
must beat 0.831 on the n=136 / multi-hop golden set under the standard ship rule (paired permutation,
BH-FDR q=0.10, non-inferiority floor delta > -0.015). Default expectation: it ships DARK behind a flag
and only flips if it measurably wins, exactly like sparse / ColBERT / rerank.

## Design

Derived edges land in `vault_edges` alongside literals, on their OWN edge_types so the literal
reconcile never touches them and vice versa:

- `similar_to`      / `edge_kind='virtual'` / provenance `cosine_knn`  — vec0 kNN (each note's top-k).
- `shared_tag`      / `edge_kind='derived'` / provenance `tag_cooccur` — notes sharing a frontmatter tag.
- `semantically_similar_to` / `edge_kind='derived'` / provenance `llm_pass3` — LLM-inferred, discrete
  confidence rubric (0.55/0.65/0.75/0.85/0.95), routed through the LOCAL inference gateway (LiteLLM ->
  local qwen). Batch-only. NO remote egress by default. Source text wrapped in hash-stamped
  `<untrusted_source>` delimiters; injection sentinels defanged before insertion (graphify SECURITY.md).

New columns on `vault_edges` (migration): `confidence REAL`, `source_fingerprint TEXT` (hash of the
cited source content -> a derived edge self-flags "stale, re-verify" when the note changes, instead of
presenting as authoritative). Ownership manifest: derived edges are tracked as densifier-owned so a
re-densify is a clean full-state reconcile and never clobbers a literal edge.

`expandGraphLiteral` gains an `includeDerived` option: the recursive CTE optionally UNIONs derived
edges, surfacing `edge_kind` + a per-kind weight so `graph_search.ts` down-weights soft edges (virtual/
derived rank and annotate; they never outrank an authored wikilink at equal hop). "Verdicts annotate,
they do not gate" applied to edge weight — the load-bearing constraint both graphify and plur reached.

## Hard boundaries (from the vault decisions)

1. Derived graph stays DERIVED and REBUILDABLE. LLM-inferred edges are NEVER written back into notes
   as wikilinks — that would conflate derived truth with source truth and break the vault's isnad.
2. NO remote egress by default: Pass-3 extraction routes through the local gateway. A remote model is
   the operator's explicit privacy call, never the default; never runs against 02-projects / 03-health
   without an explicit sandboxed-copy opt-in.
3. Everything ships OFF by default (`retrieval.densify.*` flags) and is measured before any flip.
4. Hub exclusion at EDGE-CREATION: p99-degree nodes emit no derived edges (graphify --exclude-hubs;
   mirrors the existing THE-401 hub penalty at query time). No-edge-when-ambiguous reuses resolveTarget.

## Increments

- A. Derived-edge infra: migration (confidence + source_fingerprint + manifest), `derived-edges.ts`
     (tag co-occurrence, the simplest deterministic source), full-state reconcile scoped to derived
     edge_types, `retrieval.densify` config block. Unit tests. (no walk yet)
- B. Virtual kNN edges: reuse vec0 kNN (`search/vec.ts`) -> `similar_to` edges + hub exclusion. Tests.
- C. Walk wiring: `expandGraphLiteral(includeDerived, weights)` + `graph_search.ts` down-weight +
     config. Tests over graph-recall/graph-expand fixtures.
- D. LLM Pass-3 extractor via gateway (injection-defended, batch CLI) + content-fingerprint staleness.
- E. Measure on multi-hop golden set (needs index rebuilt with densify on). Decision note; flip or
     stay dark with numbers.

## Steal-patterns (graphify -> here)

hub-exclusion percentile (edge-creation) | no-edge-when-ambiguous (have it) | ownership manifest (new) |
content-fingerprint staleness (new) | discrete confidence rubric (Pass-3) | untrusted-source delimiters.

## Increment E — measurement runbook (the gate)

The eval reads `DENSIFY=1` and turns on `densify.includeInWalk` in graphSearch (eval/run.ts). Numbers
require an index built WITH derived edges, then a densify-on vs densify-off A/B on the multi-hop golden set.

1. Build the index with densification on: `retrieval.densify.tagEdges: true` (+ `knnEdges: true`) in the
   eval/index config, then index the golden corpus (kNN needs vec_chunks, populated by the embed pass;
   the boot reconcile / `deps.indexVault` paths thread the flags). LLM edges: run the densify-llm batch
   with the gateway up — separate and gated.
2. A/B: `bun packages/server/eval/run.ts <config>` (baseline) vs `DENSIFY=1 bun packages/server/eval/run.ts <config>`.
3. Ship rule (same as every wave): paired permutation, BH-FDR q=0.10, non-inferiority floor delta > -0.015.
   Bar to beat: bridge recall 0.831, graph nDCG@10 0.786. Tune `retrieval.densify.derivedWeight` + `knnK` +
   `maxTagFanout` on a dev slice only.
4. Flip `includeInWalk` (and the build flags) to default-on ONLY if it wins; else it stays dark with
   numbers on file, joining sparse / ColBERT / rerank.

Honest expectation: the THE-135 query-time virtual-hop hit an 80% bridge-recall ceiling below the current
champion, so this likely stays dark unless stored-kNN + tag + LLM edges clear a bar the virtual-hop could
not. The measurement decides; the code ships dark either way.
