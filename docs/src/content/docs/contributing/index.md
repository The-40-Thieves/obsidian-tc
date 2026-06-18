---
title: Contributing
description: Monorepo layout, toolchain, and how to build and test obsidian-tc.
---

## Layout

obsidian-tc is a Bun workspace monorepo:

| Package | What |
| --- | --- |
| `packages/server` | the MCP server (`obsidian-tc`) — tools, dispatch, transports |
| `packages/shared` | Zod schemas and shared types |
| `packages/native` | the napi-rs native module (vector ops, BM25) + pure-JS fallback |
| `packages/plugin` | the companion Obsidian plugin |
| `docs` | this Astro Starlight site (standalone, not in the workspace) |

## Toolchain

- **Bun** 1.3.x for installs, builds, and the bun-smoke job.
- **Vitest** for the server test suite (run under Node with `--experimental-sqlite`).
- **Biome** for lint/format (`bun run lint`).

## Build & test

```sh
bun install
bun run lint
bun run --filter=@obsidian-tc/shared build
bun run --filter=obsidian-tc test          # vitest, with a v8 coverage gate (>80%)
```

## Storage portability

CI runs vitest under `node:sqlite` with `--ignore-scripts` (no extension loading).
Any sqlite-extension feature (sqlite-vec, FTS5) therefore keeps a pure-JS portable
path tested in vitest, and exercises the real extension only in the bun-smoke job.
Never add a vitest test that calls `loadExtension`.
