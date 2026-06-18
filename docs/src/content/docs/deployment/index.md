---
title: Deployment
description: How obsidian-tc is packaged, released, and run in production.
---

## Artifacts

A tagged release (`v*`) produces, via GitHub Actions:

- **npm packages** — `obsidian-tc` (the server, with the `obsidian-tc` bin) plus
  `@the-40-thieves/obsidian-tc-{shared,native}` and the four native platform
  sub-packages. Published with npm **provenance**.
- **Native prebuilds** — napi-rs binaries for `linux-x64-gnu`, `darwin-x64`,
  `darwin-arm64`, and `win32-x64-msvc`. Other platforms use the pure-JS fallback.
- **Standalone binaries** — self-contained executables (`bun build --compile`).
- **Companion plugin zip** — for `.obsidian/plugins/`.
- **Docker image** — single-stage `oven/bun:1-alpine`.

## Release is human-gated

The publish workflow is **tag-triggered only** — it fires when a maintainer pushes
a `v1.0.0` tag, never on a branch push or pull request. The build/test, coverage,
native, plugin, and docs CI jobs run on every PR; publishing is a deliberate,
separate, human action.

## Running in production

Run over HTTP with `auth.mode: jwt`, bind to loopback (or a trusted interface
behind a reverse proxy), and mint scoped tokens per client. See
[Authentication](/security/auth-model/) and
[Configuration](/configuration/config-yaml/).
