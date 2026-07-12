---
title: V2 Preview
description: A look ahead — capabilities reserved for the next substrate generation.
---

The v1.x line went further than this page originally scoped: the 2026-07 retrieval
campaign shipped the general BM25 + dense hybrid retriever (enriched lexical +
enriched dense + hop-ordered graph expansion under RRF), k-means clustering and
ACT-R activation as offline CLI passes, and the v1.6–v1.7 memory engine (the
experiential work-memory tier, composite context surfaces, dependency-aware
deletion, the knowledge flywheel). See the [Roadmap](/roadmap/) for the shipped
list.

What remains genuinely reserved for **V2** — the next substrate generation:

- **The typed-atom MemIR substrate** — claim atoms, bi-temporal
  `authoritative_claims`, `derives_from` provenance edges. Parked with an explicit
  revisit trigger (THE-235): it lands with a purpose-built claim-extraction
  pipeline, and pulls reference-counted derived-artifact GC (upgrading `forget`'s
  cascade) with it.
- **An episode → authored-claim promotion path** — deliberately absent today (the
  experiential store is a membrane; injected episodes structurally cannot reach
  authored atoms). If V2 adds promotion, the pre-recorded safety precondition
  applies: full dependency-closure deletion becomes a write-on gate.
- **Cross-store fused ranking** — the authored vault and the experiential store
  federate at query time as separate legs by design. A single fused ranking (and
  the PIT score calibration it would need) is a V2 question, taken up only with a
  concrete proposal.

Dark v1.x mechanisms (rerankers, learned sparse, query decomposition, the query
class router, convex fusion) are not V2 items — each ships behind a flag with a
one-command re-test against the golden-set harness, and re-enters whenever a
larger eval set or better serving stack changes its measured verdict.

These are previews of direction, not commitments of schedule. The v1.x tool
surface is stable; V2 capabilities will be added additively.
