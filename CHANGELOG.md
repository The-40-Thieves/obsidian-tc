# Changelog

All notable changes to obsidian-tc are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the spirit of
[Keep a Changelog](https://keepachangelog.com/).

## [1.0.1] - 2026-06-19

First public release: a comprehensive, model-agnostic, agent-ready Obsidian MCP server —
the full v1.0 tool surface (G2.1 Domains 1–28, 103 tools) plus the M7 hardening gate.

### Added

- **Tool surface (Domains 1–28)** — notes / metadata / links, search + embeddings, structured
  formats (bases, canvas, periodic), plugin-bridge tools, memory + capture, bulk operations,
  URI generation, and the server-admin surface.
- **Observability (G2.4)** — OpenTelemetry traces (conditional; a no-op until an OTLP endpoint
  is configured), the Prometheus catalog (8 counters / 2 histograms / 4 gauges) exposed via an
  optional `/metrics` scrape endpoint, and a MORGIANA CloudEvents 1.0 JSONL spool (9 event
  types). All export streams fail soft and never block tool execution.
- **Dispatch-wide rate limiting (THE-210)** — a deterministic token-bucket policy gate across
  every scope class (read / write / bulk / execute / admin) with the G2.4 tiered defaults.
- **Security model (G2.4)** — HS256 JWT auth, scope + folder ACLs, HITL elicitation with
  hardcoded floors, a shared response-byte governor, and a localhost-only-by-default posture.
- **Native module** — napi-rs vector / BM25 primitives with a pure-JS fallback. v1.0 ships
  prebuilds for 4 platforms (linux-x64-gnu, darwin-x64, darwin-arm64, win32-x64-msvc).
- **Distribution** — a tag-triggered release workflow (npm with `--provenance`, standalone Bun
  binaries, plugin zip, multi-arch Docker image), Apache-2.0 licensed, with an Astro Starlight
  documentation site.

### Deferred to v1.1

- `linux-arm64` native prebuilds (the pure-JS fallback covers arm64-linux), cosign binary
  signing, and CycloneDX SBOM generation.
- The richer `obsidian-tc serve / init / auth / …` subcommand CLI (G2.5 §5); v1.0 ships a
  config-path launcher.

[1.0.0]: https://github.com/The-40-Thieves/obsidian-tc/releases/tag/v1.0.0
