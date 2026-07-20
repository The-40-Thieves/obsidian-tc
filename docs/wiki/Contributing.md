# Contributing

This is a condensed guide. The authoritative version is [`CONTRIBUTING.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/CONTRIBUTING.md); start there and in [`ARCHITECTURE.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/ARCHITECTURE.md).

## Toolchains

- **Bun** `>= 1.1.0` (CI pins 1.3.x)
- **Node** `>= 24 LTS` (the server test runner uses `node:sqlite`)
- **Rust** (rustup, stable) + **napi-rs CLI** `>= 3` — only for native-module work; otherwise the pure-JS fallback covers it

## Bootstrap

```bash
git clone https://github.com/the-40-thieves/obsidian-tc.git
cd obsidian-tc
bun install      # native falls back to pure-JS if Rust is absent
bun run build    # shared + native + server + plugin
bun run test
```

No Rust? `bun run --filter='!@the-40-thieves/obsidian-tc-native' build`.

## Dev loops

```bash
cd packages/server && bun run dev    # server, stdio auto-reload
cd packages/plugin && bun run dev    # plugin, esbuild watch
cd packages/native && cargo test     # Rust unit tests
```

Point your config at a **scratch vault**, never your real one. Force the fallback path with `OBSIDIAN_TC_FORCE_JS_FALLBACK=1 bun run test`; CI runs both native and fallback.

## Conventions

- **TypeScript:** strict, no implicit `any`. Linted/formatted by [Biome](https://biomejs.dev) (`bun run lint`, `bun run format`).
- **Rust:** `rustfmt` + `clippy` clean; `#![deny(unsafe_code)]` outside the napi-rs FFI boundary.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org). Scopes match the package (`feat(server): ...`, `fix(native): ...`).
- **Branches:** trunk-based, short-lived `feat/...` off `main`, rebase before PR.

## Adding a tool

A typical tool touches four files:

1. `packages/shared/src/schemas/<domain>.ts` — Zod input/output schema
2. `packages/server/src/tools/<domain>/<tool_name>.ts` — implementation
3. `packages/server/src/tools/<domain>/<tool_name>.test.ts` — tests
4. `docs/src/content/docs/tools/<domain>/<tool_name>.md` — user reference

Annotate the tool with **ACL / HITL / idempotency / rate-limit** metadata per the [G2.1 conventions](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/G2.1-tools.md). Any new Rust function must ship a numerically identical TypeScript fallback that passes the same tests.

## Pull requests

Open against `main`. To merge: CI green (`ci-server`, `ci-plugin`, `ci-native` × 8 platforms, `ci-version`, `ci-docs`, `ci-install-smoke`, plus the CodeQL security and Code Quality analyses), one maintainer review, Conventional-Commit PR title (feeds the changelog), tests for new behavior, and docs updated when the change is user-visible.

## Releases

Maintainers run `bun run release <patch|minor|major>` (sets versions across every `package.json` + `server.json` + `manifest.json`, rolls the CHANGELOG, runs the version-coherence gate), open a release PR, then tag `v<x.y.z>`. `publish.yml` builds the 8-platform native matrix (linux x64/arm64 gnu+musl, darwin x64/arm64, win x64/arm64), publishes to npm, pushes the GHCR image, and drafts the GitHub Release. The plugin versions on its own cadence and is submitted separately to `obsidianmd/obsidian-releases`.

## Getting help

GitHub Discussions for design questions, Issues for bugs/features. Security issues go through [`SECURITY.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/SECURITY.md), never public Issues. The project follows the [Contributor Covenant](https://github.com/The-40-Thieves/obsidian-tc/blob/main/CODE_OF_CONDUCT.md).
