---
title: Roadmap
description: What ships in v1.0, what is deferred to v1.1, and what is reserved for V2.
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

## V2

Clustering and advanced retrieval — see the [V2 Preview](/v2-preview/).
