# obsidian-tc — working notes for Claude Code

An MCP server over Obsidian vaults. Bun + TypeScript monorepo with a Rust native addon and two
Python model services.

## Toolchain — pinned, do not float

| | pin | source of truth |
|---|---|---|
| Bun | **1.3.14** | `mise.toml` + `packageManager` in `package.json` — must agree |
| Node | **26.5.0** dev / **24** in CI | `mise.toml`; `engines.node: ">=24"`. Dev runs ahead of the supported floor **deliberately** — CI validates the floor |
| Python | **3.11** | `mise.toml`; both services declare `requires-python = ">=3.10"` |
| Rust | **1.97.1** exact | `packages/native/rust-toolchain.toml` |
| TypeScript | **7.0.2** | root + `packages/shared`. `docs/` is a *separate install root* still on 6.0.3 (THE-604) |
| Vitest | **4** | AST-aware coverage remapping is mandatory in v4 — numbers are not comparable to v3 |
| Biome | **2.5.x** | format + lint; there is no ESLint/Prettier here |

`@types/node` stays on **^24**, matching the CI floor rather than the dev runtime. That is
deliberate — typing against 26 would let Node-26-only APIs compile and fail on the supported floor.

**Rust pin trap:** `dtolnay/rust-toolchain` does **not** read `rust-toolchain.toml`. Pinning only
the file splits cargo's toolchain from the one targets install onto → `E0463: can't find crate for
std`. `.github/actions/setup-rust` parses `channel` out of the file and passes it as `toolchain:`.
Never hardcode a version in a workflow.

## Workspaces

`packages/server` · `packages/shared` · `packages/native` (napi-rs) · `packages/plugin`

**`docs/` is NOT a workspace member** and has its own `docs/bun.lock`. Root `bun install`,
`overrides`, and `bun audit` do not reach it — a root audit has already missed 6 advisories that
lived only there.

## Commands

```bash
bun run lint        # ONLY biome. It runs no check:* gate — see below
bun run typecheck   # all four packages
bun run test        # per-workspace; server is vitest under Node, native is cargo test
just                # list recipes (build, test, lint, format, bundle, map, release)
```

**`bun run lint` is `biome check` and nothing else.** The gates run as separate *steps* of CI's
`lint` **job**, which is a different thing with a confusingly similar name. Green locally on
`bun run lint` says nothing about them. Enumerate the real list from `.github/workflows/` — the
`lint` job currently runs biome plus `check:boundaries`, `check:dev-dep-imports`,
`check:perf-timing-scope`, `check:ingest-telemetry-wiring`, `check:config-paths`,
`check:duplicate-exports`, `check:duplication`, `check:export-surface`, `check:facade-parity` and
`test:scripts`; `check:config-threading` lives in `ci-security.yml`.

Two `check:*` scripts exist in `package.json` that **no workflow invokes** — `check:merge-driver`,
and historically `check:export-surface` / `check:facade-parity` until they were wired. A script
existing is not a gate running: grep the workflows, not `package.json`.

**Don't run the full suite locally.** This box is 4 cores shared with ~43 containers; GitHub-hosted
runners are free and unmetered for public repos, and cover three OSes:

```bash
gh workflow run ci-server.yml --ref <branch>     # lint + build-test (3 OS) + bun-smoke
```

Targeted vitest stays local. Anything heavy that must run here goes through
`scripts/with-host-budget.sh` (or `bun run test:local` in `packages/server`) — it serialises
concurrent runs with `flock` and caps CPU at 2.5 of 4 cores, leaving the rest for the services.

Before opening a PR, use the **`gates`** skill — it enumerates gates from the workflows rather than
from memory. Two scripts have confusingly adjacent names (`check:config-paths` ≠
`config:schema:check`) and substituting one for the other has cost a CI round.

## Before implementing a ticket

Use the **`verify-ticket-premise`** skill. Tickets here go stale fast: in one session, five had
premises that no longer held — one was entirely already done, another quoted a duplication rate
660× the real one. The check costs minutes; acting on a stale premise has cost days.

## Generated artifacts — never hand-edit

A `PreToolUse` hook blocks these; the message names the regeneration command.

| file | regenerate with |
|---|---|
| `TREE.md`, `docs/dependency-graph.json` | `bun run map` |
| `docs/obsidian-tc.config.schema.json` | `bun run config:schema` |
| `packages/server/src/db/migrations-embedded.ts` | `bun run migrations:embed` |

Ten doc files additionally carry docgen **marker regions** (`<!-- BEGIN GENERATED: ... -->`). Those
are only partly generated — edit the prose around them freely, never inside them, and re-run
`docgen:render -- --check`.

## Conventions that bite

- **Migrations are append-only, hand-registered, checksum-pinned.** Add the `.sql`, append it to
  `db/migration-manifest.ts`, regenerate the embedded copy. Editing a *shipped* migration is a hard
  startup error. There is no down-migration and no dry-run.
- **`bun --compile` bakes `import.meta.url` and embeds no assets.** That is why migrations are
  codegen'd into a `.ts` module. Any `readFileSync` of a `.sql`/`.json` asset ships a binary that
  only runs on the build machine.
- **Never pipe a gate through `tail`/`head`** — `$?` reports the pipe, not the command. This has
  masked a failing suite and a failing lint. Redirect to a log; check `$?` separately.
- **Parallel agents need separate worktrees.** `git worktree add <dir> -b <branch> origin/main`.
  Two agents in one checkout silently interleave edits.
- **`ci-server.yml` and `ci-docgen.yml` are deliberately unfiltered.** A required status check whose
  workflow is path-filtered leaves the PR blocked forever on *"Expected — waiting for status to be
  reported."* Do not re-add a `paths:` filter to either.
- **A new gate must be watched failing before it is trusted**, and needs a non-empty floor. A gate
  that has never failed proves nothing; one that scans zero files reports success.

## Adding a tool moves four things

`REGISTERED_TOOL_COUNT` (`test/registered-tool-count.ts`), the facade domain map,
`boot.tools_registered` (hard/exact in the perf harness — pinned **2 lower**, since `health` and
`index_status` register inline in `cli.ts`), and prose in ~15 docs. `docgen:facts-check` is the
strict gate.

## Security posture

`trusted-local` is the default and leaves `snapshots.enabled` **on** (THE-648) — destructive note
writes capture an undo via `restore_note` unless a config explicitly opts out
(`snapshots: { enabled: false }`). Retention (10 versions/note) is pruned inline and orphan blobs
are GC'd, so growth is bounded by construction. Worth knowing either way before running anything
that deletes.
