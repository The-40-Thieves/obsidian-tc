<!-- TEMPLATE / BLUEPRINT — Contribution Guide. -->

# Contributing

Thanks for helping improve obsidian-tc. This page is the fast path from clone to merged PR.

> [!IMPORTANT]
> All commits must be **DCO signed-off** (`git commit -s`). CI's `dco-check` fails unsigned commits, and they cannot be merged.

## Development setup

```bash
git clone https://github.com/The-40-Thieves/obsidian-tc.git
cd obsidian-tc
< install: bun install / workspace bootstrap >
```

The repo is a Bun workspace monorepo:

| Package | Role |
|---|---|
| `packages/server` | the MCP / HTTP server |
| `packages/shared` | error types, Zod schemas, utilities |
| `packages/native` | optional Rust native acceleration |
| `docs/` | the documentation site + this wiki's seed |

## The gate (run before every push)

```bash
cd packages/server
bunx biome check <changed files>   # lint + format
bunx tsc --noEmit                  # types
bunx vitest run <changed tests>    # tests
```

> [!TIP]
> A change to a widely-imported file (e.g. `cli.ts`, `indexer.ts`) warrants the **full** suite: `bunx vitest run`. Green local gate ≈ green CI.

## Pull-request checklist

- [ ] Branched off the latest `main`
- [ ] Behavioral changes are **off by default** behind a config flag
- [ ] Commits are `-s` signed-off (DCO)
- [ ] `biome` + `tsc` + `vitest` all green locally
- [ ] Tests cover the change (including a regression test for a bug fix)
- [ ] PR description explains the *why*, not just the *what*

> [!WARNING]
> Never batch a force-push with a merge. Push, confirm the branch landed and checks are green as **separate** steps, then merge.

## Documentation

Most reference docs are **generated from code** (the tool reference, config reference, schema, metrics, errors). Do **not** hand-edit content inside `<!-- BEGIN GENERATED … -->` markers — change the source and regenerate:

```bash
< bun run docgen >   # regenerates the model, pages, README/wiki sections
```

CI's docs-drift gate fails a PR that changes a tool/config/metric without regenerating. Hand-authored prose (guides, positioning) lives **outside** the markers and is yours to write.

## Reporting bugs & requesting features

Open an [issue](https://github.com/The-40-Thieves/obsidian-tc/issues) with:

- what you expected vs. what happened,
- a minimal repro (config + steps),
- server version + runtime.

## Code of conduct & license

By contributing you agree your work is licensed under **AGPL-3.0**. Be respectful; see `CODE_OF_CONDUCT.md` if present.
