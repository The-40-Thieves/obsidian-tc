# Changelog

All notable changes to obsidian-tc are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the spirit of
[Keep a Changelog](https://keepachangelog.com/).

## [1.0.2] - 2026-06-21

Security patch. Closes the unauthenticated-bind exposure present in 1.0.1 and
rolls up the post-1.0.1 rate-limiter and housekeeping work already on `main`.

### Security

- **F2: the HTTP transport now refuses to bind a non-loopback host when
  `auth.mode` is `none`.** Enforced fail-closed at config load with no insecure
  override; loopback detection is centralized in a shared `net-host` helper with
  strict IPv4 octet validation and bracket-normalized IPv6 binding. 1.0.1 could
  serve an unauthenticated vault on a non-loopback address. (THE-113 audit, F2.)

### Fixed

- **F1: the native build no longer clobbers its prebuild output directory.**
- **F4 / F8 and audit hygiene** from the THE-113 end-to-end audit; the committed
  audit report is removed from the tree.
- Rate limiter: single deletes tier at the `delete` scope class (THE-212) and
  idle buckets are reclaimed (THE-213).

### Changed

- Docs reconciled to the access-only V2 framing and freshened post-1.0.1;
  tool-surface count corrected to 103 across 28 domains (THE-217).

### CI

- Pure-JS native fallback test job (THE-216) and a decoupled `release-image`
  workflow for GHCR-only image re-releases.

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
