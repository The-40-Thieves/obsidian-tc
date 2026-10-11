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
- **Docker image** — `oven/bun:1.4.2-slim` (Debian, glibc) on GHCR.
- **Sigstore signatures** — every binary artifact above (the standalone binaries, plugin
  files, `.mcpb`, and the native prebuilds) is signed keylessly with cosign; each release
  attaches a `<file>.sigstore.json` bundle beside the file, and the Docker image is signed by
  digest. The `cosign verify-blob` / `cosign verify` commands, the exact identity they pin, and
  how the signatures relate to signed tags, GitHub attestations, and npm provenance are in
  `SECURITY.md`, section "Verifying release artifacts".

The published server bundle is minified with a linked sourcemap.

## Release is human-gated

The publish workflow is **tag-triggered only** — it fires when a maintainer pushes
a `v*` tag (e.g. `v1.2.1`), never on a branch push or pull request. The
build/test, coverage, native, plugin, Docker-build, and docs CI jobs run on every
PR; publishing is a deliberate, separate, human action.

## Upgrading: restart every process that shares a cache DB together

Several processes (an HTTP server, a stdio server, CLI workers) can share one cache database, and
an upgrade only migrates it once, from the first new process to open it. The server does **not**
refuse to run against a newer schema: it applies the migrations it knows and ignores the rest. A
process still on the old version therefore keeps using the migrated database.

Scoping idempotency keys to the calling principal (migration `20261010_001`) is the case in point. The old
binary's idempotency statements match a key by vault alone, so they cannot be allowed to run against
the new table: its `key` column is renamed (`idem_key`) and `principal` has no default, so every old
statement fails with an error instead of reading, overwriting or deleting another principal's row.
For a process left on the old version that means **calls carrying an `idempotency_key` fail until it
is restarted on the new version**; calls without a key, and everything else it does, are unaffected.
Upgrade and restart every process that shares one cache DB in the same window. The migration drops
the existing idempotency rows (none recorded an owner), so a keyed call retried within
`idempotencyTtlSeconds` of the upgrade runs once more instead of replaying.

## Running in production

Run over HTTP with `auth.mode: jwt`, bind to loopback (or a trusted interface
behind a reverse proxy), and mint scoped tokens per client. See
[Authentication](/security/auth-model/) and
[Configuration](/configuration/config-yaml/).
