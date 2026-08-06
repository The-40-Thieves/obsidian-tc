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
bun run typecheck   # all four packages, PLUS packages/server/tsconfig.bun-smoke.json
bun run test        # per-workspace; server is vitest under Node, native is cargo test
just                # list recipes (build, test, lint, format, bundle, map, release)
```

**`bun-smoke/` is a SEPARATE tsc project** (`packages/server/tsconfig.bun-smoke.json`, THE-687). It
is not in the main config's `include`, because it is the only code allowed to see Bun's globals —
`src`/`test` pin `types: ["node"]` so they keep compiling against the Node floor that `build-test`
runs on. Before it was wired in, `bun run typecheck` reported 0 while nine bun-smoke files did not
compile, and CI's `bun-smoke` job found them as *runtime* failures instead. If you change a
signature in the vec/indexing path, the bun-smoke project is what catches those call sites.

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

**Twelve** doc files additionally carry docgen **marker regions** (`<!-- BEGIN GENERATED: ... -->`).
Those are only partly generated — edit the prose around them freely, never inside them, and re-run
`docgen:render -- --check`.

Do not count them by grepping for `BEGIN GENERATED`: that also hits this file (which names the
string in prose), `TREE.md` (a different generator), and docgen's own README, which is how the
figure here read "ten" for a while. The authoritative list is **`GENERATED_DOC_FILES`** in
`packages/server/scripts/docgen/targets.ts` — `render.ts` asserts its own targets against it, so
that constant is the one thing that cannot drift from reality.

## Conventions that bite

- **Migrations are append-only, hand-registered, checksum-pinned.** Add the `.sql`, append it to
  `db/migration-manifest.ts`, regenerate the embedded copy. Editing a *shipped* migration is a hard
  startup error. There is no down-migration and no dry-run.

  **There is a FOURTH step, and nothing gates it: `just migration-impact <file.sql>`.** Those three
  steps are all gated (`migrations-manifest.test.ts`, `migrations:embed:check`) — the test suite is
  not. **62 test files hand-build their own literal migration chain**; only 16 read the manifest.
  A new migration leaves all 62 behind, and without this lookup you find the affected ones one red
  CI build at a time — that cost three separate rounds on 2026-08-06. The duplication is deliberate
  (a minimal chain makes a test's schema dependencies explicit; see `citation.test.ts`'s own note),
  so the fix is knowing the set, not collapsing it. It prints the chains that CREATE the table your
  migration touches; not all of them will break, it is the set to CHECK.
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

## Adding a tool moves eight things

Five always, three more if the tool mutates or takes a vault. Measured 2026-08-03 adding three
tools (154 → 157): the first four were known, **CI caught the last three**, and a local sweep that
skipped `bun run lint` at the repo root missed two of those. Item 5 was added 2026-08-04 adding
`explain_answer` (157 → 158) — this file said *seven*, all seven were moved, and CI failed anyway
on an eighth nobody had written down.

**Always:**

1. **`REGISTERED_TOOL_COUNT`** — `test/registered-tool-count.ts`. Parsed by
   `scripts/check-version-coherence.mjs`, so the declaration must stay a plain
   `export const REGISTERED_TOOL_COUNT = <digits>;`.
2. **The facade domain map** — `test/tool-facade-domain-coverage.test.ts`. Reusing an existing
   `domain` only trips its count assertion (it imports `REGISTERED_TOOL_COUNT`); a **new** domain is
   what makes the map itself load-bearing.
3. **`boot.tools_registered`** — `eval/perf/baseline.small.json`, hard/exact. Pinned **2 lower**
   than `REGISTERED_TOOL_COUNT`, since `health` and `index_status` register inline in `cli.ts`.
4. **Docs prose — two separate gates, and running one is not running the other.**
   `docgen:facts-check` finds narrative counts (25 sites across 14 files last time),
   `check-version-coherence.mjs` separately pins ~9 *headline* anchors, and **`docgen:render`** owns
   the generated marker regions (it rewrote 8 files last time). Running `docgen:facts-check` and
   skipping `docgen:render` is what failed `drift-gate` — `docgen:render -- --check` is the one that
   tells you.
5. **The m7 metadata parity snapshot**, *if the tool lives in `m7/knowledge`* —
   `test/m7-tool-metadata-parity.test.ts` pins an ordered, **byte-identical** snapshot of every m7
   tool's public metadata (name, description, domain, scopes, tags, `hasPathAcl`, and the top-level
   input/output keys), so a new tool in `buildKnowledgeTools` moves it by construction. It is an
   inline literal rather than `toMatchSnapshot()` on purpose — there is no `__snapshots__` dir, so
   an auto-written snapshot would be created-and-pass on its first run. **Derive the new entry from
   the tool and read it back**, don't hand-type it.

   A `z.union` outputSchema (the `availableWith` envelope) snapshots as **`outputKeys: []`** —
   `topLevelShape` returns `undefined` for a union, correctly. That is the honest value, and it
   also means the parity gate stops guarding that tool's output shape, so pair it with a
   round-trip parse test. Compare **key sets** after parsing, not just `safeParse` success: Zod
   objects are non-strict, so a field with no schema entry is silently stripped and still parses.

**If the tool MUTATES** (`destructive: true`, or any `write:`/`admin:` scope):

6. **`pathAcl`, or a documented exemption** — `test/acl-extraction-coverage.test.ts` (THE-414). A
   mutating tool that names no caller-controlled vault path belongs in `EXEMPT_NO_PATH` **with a
   comment saying why**. Being vault-*scoped* and *naming a path inside a vault* are different
   things; only the second is `pathAcl`'s business.

**If it also takes a vault:**

7. **`vaultArg`, and the field must be the branded `VaultId`** —
   `test/vault-arg-coverage.test.ts` (THE-513 Part 2). The gate recognises a vault-shaped field by
   that schema, so `vault: z.string()` reads to it as *a mutating tool with no vault at all* and
   fails with a confusing message about a set you did not touch.

**Whenever the target file is near the ceiling:**

8. **biome's 700-line `noExcessiveLinesPerFile`** — three tools took `experiential-tools.ts` to 839.
   Splitting is the fix, but a naive split creates a **circular import** (`check:boundaries`,
   baseline **0**): lift the shared deps and helpers into a third module rather than having the new
   file import from the old one.

**Run `bun run lint` at the REPO ROOT before committing**, not `biome check --write` per file. The
line-ceiling rule is invisible per-file, and per-file formatting leaves drift a later edit re-breaks.

## Security posture

`trusted-local` is the default and leaves `snapshots.enabled` **on** (THE-648) — destructive note
writes capture an undo via `restore_note` unless a config explicitly opts out
(`snapshots: { enabled: false }`). Retention (10 versions/note) is pruned inline and orphan blobs
are GC'd, so growth is bounded by construction. Worth knowing either way before running anything
that deletes.
