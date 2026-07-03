---
title: V2 Preview
description: A look ahead — capabilities scoped to V2, not part of the v1.0 surface.
---

v1.0 ships the complete G2.1 tool surface and the M7 hardening gate, including the
retrieval intelligence folded in by the 2026-06-25 converged-engine decision
(GraphRAG, FTS5 BM25, dense-vector search, gateway-optional rerank). A few
capabilities remain deliberately **out of scope** and reserved for V2:

- **Clustering & graph ML** — k-means and the removed Python ML sidecar / ACT-R
  decay hooks stay out of scope; the typed-atom MemIR substrate is a downstream
  engine-build phase (THE-235).
- **A general BM25 + vector hybrid retriever** — v1.x ships FTS5 BM25 and dense-
  vector search as separate modes, with RRF fusion inside GraphRAG only. A unified
  lexical+vector RRF retriever for all vault search is THE-196.

These are previews of direction, not commitments of schedule. The v1.0 tool surface
is stable; V2 capabilities will be added additively.
