---
title: Deployment
description: How obsidian-tc is packaged, released, and run in production.
---

## Artifacts

A tagged release (`v*`) produces, via GitHub Actions:

- **npm packages** — `obsidian-tc` (the server, with the `obsidian-tc` bin) plus
  `@the-40-thieves/obsidian-tc-{shared,native}` and the native platform
  sub-packages. Published with npm **provenance**.
- **Native prebuilds** — napi-rs binaries for eight triples: `linux-x64-gnu`,
  `linux-arm64-gnu`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`,
  `darwin-arm64`, `win32-x64-msvc`, `win32-arm64-msvc`. Other platforms use the
  pure-JS fallback.
- **Standalone binaries** — self-contained executables (`bun build --compile`,
  bytecode + minified).
- **`.mcpb` bundle** — a one-click MCP Bundle (`manifest.json`, MCPB 0.3).
- **Companion plugin zip** — for `.obsidian/plugins/`.
- **Docker image** — `oven/bun:1-slim` (Debian, glibc) on GHCR.

The published server bundle is minified with a linked sourcemap.

## Release is human-gated

The publish workflow is **tag-triggered only** — it fires when a maintainer pushes
a `v*` tag (e.g. `v1.2.1`), never on a branch push or pull request. The
build/test, coverage, native, plugin, Docker-build, and docs CI jobs run on every
PR; publishing is a deliberate, separate, human action.

## Running in production

Run over HTTP with `auth.mode: jwt`, bind to loopback (or a trusted interface
behind a reverse proxy), and mint scoped tokens per client. See
[Authentication](/security/auth-model/) and
[Configuration](/configuration/config-yaml/).
