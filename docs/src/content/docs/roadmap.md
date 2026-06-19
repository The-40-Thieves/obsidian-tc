---
title: Roadmap
description: What ships in v1.0, what is deferred to v1.1, and what is out of scope.
---

## v1.0 (current)

The complete G2.1 tool surface — 103 tools across 28 domains — plus the M7
hardening gate: conditional OpenTelemetry tracing, the Prometheus catalog and
`/metrics` endpoint, the MORGIANA CloudEvents spool, a dispatch-wide rate limiter,
a >80% coverage gate, the 4-platform native prebuild + release workflow, and this
documentation site.

## Deferred to v1.1

- `linux-arm64` native prebuilds (the pure-JS fallback covers arm64-linux today).
- cosign binary signing and CycloneDX SBOM generation.
- The richer `obsidian-tc serve / init / auth / …` subcommand CLI (v1.0 ships a
  config-path launcher).
- Per-tool reference pages auto-generated from the live tool registry.

## Out of scope

Retrieval intelligence — clustering, graph ML, hybrid retrieval fusion — is **not** part of obsidian-tc. It is an access MCP; pair it with an external retrieval/RAG service for ranking and reasoning. An earlier reserved "V2 intelligence layer" (Python ML sidecar, k-means, ACT-R decay) has been dropped, and the remaining hooks are being removed.
