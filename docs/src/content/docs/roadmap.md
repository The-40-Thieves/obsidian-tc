---
title: Roadmap
description: What has shipped through v1.8, and what remains deferred or out of scope.
---

## Shipped (current: v1.10.0)

The complete G2.1 tool surface — 145 tools across 31 domains — plus everything the
v1.x line added on top of the v1.0 hardening gate (OpenTelemetry, Prometheus,
CloudEvents, rate limiter, 8-triple native prebuilds, this docs site):

- **The measured retrieval engine** (v1.4–v1.7): enriched BM25 + enriched dense +
  hop-ordered wikilink expansion fused under RRF k=10 — a general hybrid retriever,
  gated by an n=136 golden set with a statistical ship rule (permutation test, FDR,
  a non-inferiority floor). Contextual chunk enrichment measured **+0.223 nDCG** and
  defaults on. k-means clustering and ACT-R activation recompute run as offline CLI
  passes. Per-vault GraphRAG edge isolation shipped. Mechanisms that lost their A/B
  (cross-encoder rerankers, learned sparse, ColBERT, convex fusion, query
  decomposition, MMR, the class router's lexical short-circuit) ship **dark** behind
  flags, with the numbers recorded on their tickets. **Graph densification** (derived `shared_tag` / vec0-kNN / LLM Pass-3 edges beyond authored wikilinks, `retrieval.densify.*`) is wired but **unmeasured** — it ships dark pending a multi-hop golden-set A/B (the prior THE-135 virtual-hop hit an 80% bridge-recall ceiling below the 0.831 champion).
- **The experiential work-memory tier** (v1.6): a quarantined second store with
  serve-path retrieval logging, auto-captured work episodes (poison-scanned,
  evaluator-stamped eligibility), and reader tools under a strict contract.
- **Composite context surfaces** (v1.7): `vault_context` (budget-packed one-call
  context with lesson surfacing and a TTL-enforced prewarm cache) and `reflect`
  (grounded synthesis + adversarial challenge + a typed-delta preference profile).
- **Dependency-aware deletion** with a hash-chained forget audit; **Obsidian Git**
  and **Remotely Save** companion bridges; a **knowledge-flywheel CLI family**
  (`metrics`, `gaps`, `prefetch`, `reflect`, `forget`, `citation-infer`,
  `contribution-report`, `activation-recompute`, `cluster`); and a vec0 index with
  a per-vault partition key, rebuilt in place from stored embeddings.
- CycloneDX SBOMs, generated per package on release (`npm sbom`, THE-299) and uploaded as
  build artifacts (non-blocking).

## Deferred

- cosign binary signing.
- Per-tool reference pages auto-generated from the live tool registry.
- A per-scope HITL-raise (today per-scope overrides only tighten; isolate unattended
  automation on a second instance instead).

## Out of scope for the v1.x line

- The **typed-atom MemIR substrate** (claim atoms, bi-temporal
  `authoritative_claims`) — a downstream engine-build phase, parked with an explicit
  revisit trigger (THE-235).
- **Cross-store fused ranking** between the authored vault and the experiential
  store — the stores federate at query time by design (separate legs, never one
  ranked list), so score calibration across them has no substrate (THE-237,
  closed with that verdict).
