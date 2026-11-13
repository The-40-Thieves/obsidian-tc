---
title: Contributing
description: Monorepo layout and how to build and test reliquary-tc. The full contributor guide is CONTRIBUTING.md at the repo root.
---

The **full contributor guide** — development setup, code conventions, commit and PR rules,
testing expectations, adding a tool, and DCO sign-off — is the canonical
[`CONTRIBUTING.md`](https://github.com/The-40-Thieves/reliquary-tc/blob/main/CONTRIBUTING.md)
at the repository root. This page is a quick local build-and-test reference.

## Layout {#layout}

reliquary-tc is a Bun workspace monorepo:

| Package | What |
| --- | --- |
| `packages/server` | the MCP server (`reliquary-tc`) — tools, dispatch, transports |
| `packages/shared` | Zod schemas and shared types |
| `packages/native` | the napi-rs native module (vector ops, BM25) + pure-JS fallback |
| `packages/plugin` | the companion Obsidian plugin |
| `docs` | this Mintlify site (standalone, not in the workspace) |

## Toolchain {#toolchain}

- **Bun** 1.3.x for installs, builds, and the bun-smoke job.
- **Vitest** for the server test suite (runs under Node's stable `node:sqlite`).
- **Biome** for lint/format (`bun run lint`).

## Build & test {#build--test}

```sh
bun install
bun run lint
bun run --filter=@the-40-thieves/reliquary-tc-shared build
bun run --filter=reliquary-tc test          # vitest, with a v8 coverage gate (>80%)
```

## Storage portability {#storage-portability}

CI runs vitest under `node:sqlite` with `--ignore-scripts` (no extension loading).
Any sqlite-extension feature (sqlite-vec, FTS5) therefore keeps a pure-JS portable
path tested in vitest, and exercises the real extension only in the bun-smoke job.
Never add a vitest test that calls `loadExtension`.
