# Workload partition: TypeScript / Rust / Python

**Status:** analysis + roadmap (no build committed yet)  ·  **Date:** 2026-07-12  ·  Supersedes the
blanket "Python is out of scope" framing for the *technical* question of language fit.

## Context

An audit raised: *where would Rust or Python be a better fit than the current TypeScript?* The
honest answer is a **partition by compute profile**, decided per function — not by the prior
scope decision (the V2 Python **in-process sidecar** was cut in THE-298; that was a coupling /
deployment call, not a claim that Python is wrong for ML). This doc maps the codebase's functions
to the language whose runtime characteristics actually fit them, and proposes a build order.

## Principle

| Class | Wins when… | Language |
| --- | --- | --- |
| Control plane | async I/O, protocol/JSON glue, schema validation, integration churn | **TypeScript** |
| CPU/memory kernels | tight deterministic loops, large in-memory/mmap data, no-GC latency, SIMD/parallelism | **Rust** |
| GPU / ML / LLM | neural models, CUDA/torch, the ML ecosystem (transformers, sklearn, hdbscan) | **Python** |

## Rust — CPU/memory-bound kernels (expand `packages/native`)

Already native (correct calls): `cosineSimilarity`, `tokenize`, `bm25Score`, Unix `safe_read/write`.
The one O(corpus) per-request loop — brute cosine (`search/semantic.ts:108`) — is *already* native,
and the heavy lexical/graph work runs in SQLite (FTS5 `bm25()`, recursive-CTE graph expansion). So
Rust's remaining value is **scale-gated**, not urgent:

| Candidate | Location | Heat | Value |
| --- | --- | --- | --- |
| **ANN vector index (HNSW/IVF)** | replaces brute-force / sqlite-vec (`semantic.ts`, `search/vec.ts`) | per-request | HIGH at scale — the current vector ceiling |
| Index-time text passes | `search/chunk.ts`, `vault/links.ts`, `search/secrets.ts`, `search/edges.ts` | per-note-index | MED — large-vault indexing throughput |
| tokenizer/BM25 unification | native `tokenize`/`bm25Score` bypass the chunk-FTS path (`search/chunk_fts.ts`) | per-request | LOW — SQLite FTS5 already carries it |

**Caveat:** at *today's* scale, per-request fusion/top-k operate on ~30-item pools
(`search/graph_search.ts:519`) — rewriting those in Rust buys ~nothing. Gate Rust work on a
*measured* large-vault latency/throughput bottleneck.

## Python — GPU/ML/LLM tier (services behind the existing gateway boundary)

The neural surfaces have **no TS/Rust substitute**. Critically, the repo already has the boundary:
the HTTP model-provider interface (`embeddings/providers.ts`) and the inference gateway
(`gateway/client.ts` — Ollama / LiteLLM / vLLM). Python ML plugs in as **model services behind
that boundary**, NOT the in-process sidecar that was cut — decision-consistent, not a reversal.

| Candidate | Today | Why Python/GPU |
| --- | --- | --- |
| **Cross-encoder reranker** | seam exists, gated | a real reranker is a GPU model (sentence-transformers / TEI) |
| **Real ColBERT / PLAID** | `search/colbert.ts` is a **JS-cosine placeholder** | late-interaction needs the actual model + GPU |
| Embedding serving (bge-m3 dense+sparse+ColBERT) | vLLM can't serve bge-m3 sparse | FlagEmbedding / TEI in Python serves all three modes |
| Learned sparse (SPLADE) | `search/sparse.ts` JS dot-scan | the vectors come from a Python model |
| HDBSCAN clustering | `search/cluster.ts` is JS k-means | density clustering is an sklearn/hdbscan job |
| Retrieval-ML experimentation | TS `packages/server/eval/` harness | the ship-gate stays TS; *exploration* (ablations, new models) is a Python/notebook job |

## TypeScript — unchanged control plane

MCP protocol, dispatch/registry, auth/ACL/HITL, config, bridges, tool schemas. High integration
churn; TS is correct and stays.

## Recommended build order

1. **FIRST — Python reranker service behind the gateway.** Highest ROI: it targets the project's
   measured differentiator (retrieval quality), is immediately testable via the existing eval
   harness + statistical ship-gate, needs Python+GPU (no substitute), and reuses the gateway
   boundary with minimal architectural change. Real ColBERT/PLAID is the natural follow-on in the
   same service.
2. **SECOND — Rust HNSW index**, gated on a measured large-vault vector-latency bottleneck.
3. **THIRD — Rust index-time text kernels**, gated on measured large-vault indexing throughput.
4. Python SPLADE / HDBSCAN as retrieval research matures.

## Non-goals / discipline

- Do **not** resurrect an in-process Python sidecar; use the HTTP model-service boundary.
- Do **not** rewrite the TS control plane in Rust — it fixes none of the dispatch findings and
  loses the test-proven behavior.
- Every Rust/Python move is **measurement-gated**: it ships only if the golden-set ship-rule (or a
  measured perf bottleneck) justifies it. This mirrors the existing retrieval-eval discipline.
