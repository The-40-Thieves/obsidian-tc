# obsidian-tc — structural map

Generated 2026-07-23 against `f1360b8`. Every path below was verified against the
filesystem, not inferred. Counts come from `find` / `wc -l` / `tokei`, excluding
`node_modules`, `dist`, and `target`.

**Scale:** 773 files, 124,033 lines total, 93,787 lines of code.

> This file is hand-generated and **will drift**. THE-470 (automated docs pipeline)
> covers generating it from code. Until then, treat counts as of the commit above.

---

## 1. Workspace packages

Root `package.json` declares four bun workspaces; `docs/` and `services/` are separate.

| path | package name | role |
|---|---|---|
| `packages/server` | `obsidian-tc` | the MCP server — all tools, retrieval, indexing, storage, transports |
| `packages/shared` | `@the-40-thieves/obsidian-tc-shared` | Zod config schema + shared types. Consumed by server and plugin |
| `packages/native` | `@the-40-thieves/obsidian-tc-native` | Rust/napi-rs module — batched cosine similarity, prebuilt per target |
| `packages/plugin` | `@the-40-thieves/obsidian-tc-plugin` | Obsidian companion plugin exposing REST extensions |
| `docs/` | `obsidian-tc-docs` | Astro Starlight site + `docs/wiki/`. **Separate workspace** — root `bun audit` and overrides do not reach it |
| `services/bge-m3-service` | (python) | embedding sidecar; deps hash-locked via `uv pip compile --generate-hashes` |
| `services/docs-ingest` | (python) | vendor-docs ingestion |

Note `packages/server`'s own `tsconfig` maps the shared package to `../shared/src`
via `paths`, so a typecheck does **not** require `packages/shared/dist` to be built.
A fresh `git worktree add` has no `node_modules` at all — run `bun install` at the
root first, or vitest silently resolves against the wrong tree.

---

## 2. Directory tree

```
packages/
  native/          Rust napi-rs module
    src/           lib.rs — cosine_similarity, cosine_batch
    benches/       Criterion benches (dims x docs matrix)
    bench/         JS-vs-native comparison harness
  plugin/
    src/           Obsidian plugin; routes.ts is the REST surface (953 lines)
  shared/
    src/           config.schema.ts (1283 lines) — the Zod config surface
      schemas/     shared Zod fragments
    test/
  server/
    src/           see §3
    test/          301 test files
    eval/          retrieval eval harness (run.ts, metrics, compare, stats)
      perf/        perf harness — scenarios, gate, baseline
        collectors/  per-domain metric collectors
    scripts/
      docgen/      render.ts — generates marker regions in docs; drift-gated in CI
    bun-smoke/     minimal boot smoke test
scripts/           repo-level check-*.mjs guards (vault-leak, config-threading,
                   release-lag, version-coherence, boundaries)
services/
  bge-m3-service/  Python embedding sidecar
  docs-ingest/     Python vendor-docs ingestion
```

---

## 3. Module boundaries — `packages/server/src`

| subsystem | files | lines | notes |
|---|---:|---:|---|
| `tools/` | 58 | 10,999 | domains m1–m8 + admin. The MCP tool surface (~144 capabilities) |
| `search/` | 42 | 7,464 | retrieval + indexing. Includes `graph_search_stages/` (THE-465) |
| `mcp/` | 6 | 2,146 | registry + facade + transport binding |
| `experiential/` | 10 | 1,868 | work-memory tier: activation, retrieval log, forget, citations |
| `vault/` | 16 | 1,667 | filesystem primitives — paths, links, ACL, snapshots, prune |
| `formats/` | 6 | 1,241 | canvas, base, dataview, kanban parsing |
| `scheduler/` | 2 | 796 | unified background scheduler + durable job queue (THE-517) |
| `plane/` | 7 | 791 | generative plane; `jobs/` holds the contradiction detector |
| `bridge/` | 8 | 745 | Obsidian plugin bridge clients |
| `migrations/` | 19 | 722 | hand-registered SQL. **Two chains** — see below |
| `model/` | 7 | 638 | model-service clients |
| `embeddings/` | 6 | 608 | providers incl. the deterministic fake used in tests |
| `capability/` | 6 | 577 | `defineTool` and the capability registry |
| `db/` | 10 | 517 | provisioning, migrate runner, experiential store |
| `cli/` | 2 | 506 | arg parsing |
| others | — | — | auth, capture, config, doctor, gateway, memory, metrics, morgiana, otel, plur, transports, util, workspace |

**Migrations have two separate chains, deliberately:**
- `cache.db` → `CACHE_MIGRATIONS` in `src/db/provision.ts`
- `experiential.db` → an inline array in `src/cli.ts` (~line 146)

Neither auto-discovers. A new migration needs a `readFileSync` const **and** an array
entry, or it silently never runs. Versions collide across chains by design.

---

## 4. Oversized files (>500 lines)

| lines | file |
|---:|---|
| **1661** | `packages/server/src/cli.ts` |
| **1474** | `packages/server/src/search/indexer.ts` |
| **1283** | `packages/shared/src/config.schema.ts` |
| **1057** | `packages/server/src/mcp/registry.ts` |
| 958 | `packages/server/src/tools/m7/knowledge-tools.ts` |
| 953 | `packages/plugin/src/routes.ts` |
| 787 | `packages/server/src/tools/m1/notes-tools.ts` |
| 779 | `packages/server/eval/run.ts` |
| 534 | `packages/server/src/formats/bases-expr.ts` |
| 514 | `packages/server/src/tools/m3/base-tools.ts` |
| 514 | `packages/server/src/tools/m2/search-tools.ts` |
| 510 | `packages/server/src/search/derived-edges.ts` |

THE-466 targets `cli.ts`, `indexer.ts`, `graph_search.ts`, `registry.ts`. Two updates:
**`graph_search.ts` is already done** (THE-465 took it 1066 → 237), and
**`config.schema.ts` at 1283 is not in its scope but is now the third-largest file.**

---

## 5. Entry points and execution surfaces

- **CLI** — `src/cli.ts`, args in `src/cli/args.ts`. Subcommands include `index`,
  `metrics`, `contribution-report`, `citation-infer`, `reflect`, `config show`.
- **MCP** — `src/mcp/registry.ts` dispatch; a 3-meta-tool facade fronts ~144 capabilities.
  STDIO and Streamable HTTP transports in `src/transports/`.
- **Obsidian plugin** — `packages/plugin/src/routes.ts` REST surface, reached via `src/bridge/`.
- **Scheduled** — one unified scheduler (`src/scheduler/`), registrations in `cli.ts`,
  `db/maintenance.ts`, `experiential/activation.ts`, `plane/plane.ts`.
- **Eval** — `eval/run.ts` (retrieval quality) and `eval/perf/` (performance gate).

---

## 6. Test topology

301 test files in `packages/server/test/`, flat (not mirroring `src/`).

| subsystem | src files | dedicated tests |
|---|---:|---:|
| search | 42 | ~7 |
| vault | 16 | ~7 |
| tools/m3 | 9 | ~5 |
| formats | 6 | ~5 |
| mcp | 6 | ~4 |
| scheduler | 2 | ~4 |
| metrics | 2 | ~4 |
| tools/m2 | 3 | ~3 |
| db | 10 | ~2 |
| plane | 7 | ~2 |
| tools/m1 | 9 | ~2 |
| otel | 1 | ~2 |
| tools/m8 | 2 | ~1 |
| experiential | 10 | ~1 |
| embeddings | 6 | ~1 |
| **tools/m7** | **3** | **0** ← no dedicated test file |

**`tools/m7` has no test file named for it.** That is `knowledge-tools.ts` (958 lines),
holding all four `graphSearch` call sites, THE-451's HyDE param, and THE-536's
`adaptiveRrf` threading. It is covered indirectly by `vault-context`, `reflect-tool`,
and `knowledge-search` tests, but nothing is named for the module.

`experiential` (10 files, ~1 test) and `embeddings` (6 files, ~1) are next thinnest.
