# obsidian-tc — monorepo tasks (thin wrappers over package.json scripts,
# kept so `just test` / `just lint` work uniformly across all repos)
# `just` with no args lists recipes.

_default:
    @just --list

build:
    bun run build

# Full workspace suite, pinned to the interpreter ci-server.yml's "test server" step actually
# uses for packages/server: `node ./node_modules/vitest/vitest.mjs run`, not `bun run test`.
#
# The difference is not cosmetic. `openDatabase()` (packages/server/src/db/open.ts) branches on
# `typeof Bun !== "undefined"`: under a real Bun runtime it resolves the bun:sqlite adapter, under
# Node it resolves better-sqlite3 / node:sqlite — DIFFERENT DATABASE DRIVERS for the same tests,
# the same class of divergence THE-608 hit (a test passing on four CI runners, failing locally,
# because each ran a different implementation). CI keeps the two paths deliberately separate: this
# command for the main suite, plus a dedicated `bun-smoke` job (`bun test bun-smoke`) that exists
# specifically to exercise bun:sqlite. `bun run test` here would collapse that distinction locally
# by relying on however Bun's own script runner happens to resolve `vitest`'s bin — pinning it
# explicitly means `just test` can't silently drift from what CI actually runs.
#
# shared/plugin/native run under Bun's own script runner — none of them touch node:sqlite.
test:
    bun run --filter='!obsidian-tc' test
    cd packages/server && node ./node_modules/vitest/vitest.mjs run

# Fast local iteration, entirely under Bun (including packages/server's bun:sqlite adapter path —
# see the comment on `test` above). A pass here is NOT a CI-equivalent result; use `just test`
# before pushing.
test-bun:
    bun run test

# Contributor toolchain diagnostic: expected-vs-found per pinned tool (bun/node/python/rust)
# against mise.toml (and packages/native/rust-toolchain.toml for Rust). `mise install` is already
# most of the answer — this is read-only and exists for what it can't catch on its own (a stale
# PATH/shim, or a contributor not using mise at all). See scripts/doctor.mjs for the full story,
# including why this is NOT the `obsidian-tc doctor` CLI subcommand.
doctor:
    node scripts/doctor.mjs

# Symlinks packages/plugin/dist/ into a scratch vault's `.obsidian/plugins/obsidian-tc/`
# directory — the manual step CONTRIBUTING.md's "Running the plugin in Obsidian" section
# otherwise has a contributor build by hand every time. Builds the plugin first if `dist/` is
# missing. See examples/scratch-vault/ for a synthetic vault to point this at.
#
#   just link-plugin examples/scratch-vault
#
# On Windows this creates a directory junction instead of a symlink — junctions need no elevated
# privileges, and `build-test (windows-latest)` is a required check, so Windows contributors are
# explicitly in scope. See scripts/link-plugin.mjs.
link-plugin vault:
    node scripts/link-plugin.mjs {{vault}}

lint:
    bun run lint

format:
    bun run format

bundle:
    bun run bundle

check-version:
    bun run check:version

release:
    bun run release

# Regenerate TREE.md's dependency-graph sections (scale, subsystem mermaid, fan-in/out) from the
# real module graph. TREE.md's prose stays hand-written; only the marker regions are rewritten.
# Closes the half of THE-470 that is machine-derivable — the file used to carry a standing
# "hand-generated and will drift" warning, and it had: 232 -> 246 modules, 785 -> 978 dependencies.
map:
    node scripts/gen-tree-map.mjs

# Drift gate for `just map`. Fails if TREE.md's generated regions are stale. Run in ci-docgen.
map-check:
    node scripts/gen-tree-map.mjs --check

# Asserts the "regenerate" merge driver for TREE.md / docs/dependency-graph.json (gitattr) is
# actually configured in THIS clone's .git/config, not just named in .gitattributes — a
# .gitattributes-only change is silently vacuous (see scripts/check-merge-driver.mjs). `bun
# install` configures it automatically via the `prepare` script; run this on its own to confirm,
# or after suspecting your git config drifted.
#
# Deliberately a LOCAL recipe, not CI, for the same reason ticket-drift above is: CI never runs
# `git merge` against a conflicting branch, so this would either always fail (the Dockerfile's
# `bun install --ignore-scripts` never configures it) or always trivially pass (a normal CI `bun
# install` configures it every time) without proving anything about a developer's own machine.
check-merge-driver:
    node scripts/check-merge-driver.mjs

# THE-540 backlog hygiene: which OPEN tickets does the code already cite? This repo names ticket ids
# in comments, so the code routinely knows things the tracker does not — THE-426 sat open eight days
# after shipping, with its own number in a comment. Reports candidates for review, never closures.
#
# Deliberately a LOCAL recipe, not CI: the cross-check needs the open-ticket list, and the only
# reason to put a Linear token in CI would be to automate a weekly nag. Run it when triaging.
# With no argument it lists every ticket id the code cites (needs no credentials at all).
#
#   just ticket-drift                       # inventory: all cited ids
#   just ticket-drift open-tickets.json     # cross-check; JSON: [{"id":"THE-1","state":"Todo"}]
ticket-drift tickets="":
    #!/usr/bin/env bash
    if [ -z "{{tickets}}" ]; then node scripts/check-ticket-drift.mjs; \
    else node scripts/check-ticket-drift.mjs --tickets "{{tickets}}"; fi

# Where is a symbol, STRUCTURALLY — and how much of what `rg` reports is prose about the code
# rather than the code. ast-grep (tree-sitter with the grammars embedded) parses; ripgrep does not.
#
# This exists because a grep count is routinely quoted here as evidence a symbol is present or
# absent, and comments in this repo talk about symbols constantly — including symbols that were
# DELETED, whose explanatory comment then reads as evidence they survive. `MAX_JUDGED` in
# citation.ts is the worked example: rg says 4 lines, the parser says 2, and the 2-line difference
# is a comment about a constant removed from a different file entirely (THE-747).
#
# Exit 1 when nothing DECLARES the symbol, so "it does not exist" is checkable rather than an
# empty grep you have to interpret. Pairs with the verify-ticket-premise skill's rule that a zero
# result must be stated explicitly.
#
#   just where MAX_JUDGED                          # default: packages/
#   just where inferCitations packages/server/src  # narrow the path
where symbol path="packages":
    node scripts/where-symbol.mjs "{{symbol}}" --path "{{path}}"

# Attribute a database's size to the tables and indexes inside it, and report which SQLite is
# reading it. READ-ONLY — safe against a live production file, which is the intended use.
#
# It is a NODE script on purpose: `dbstat` is compile-time (SQLITE_ENABLE_DBSTAT_VTAB), present in
# node:sqlite and ABSENT from Bun's bundled SQLite, which is the production runtime. So the running
# server structurally cannot answer "what is in these 226 MB" and no doctor check could either.
#
#   just db-pages ~/.obsidian-tc/cache.db
db-pages +paths:
    node scripts/db-page-report.mjs {{paths}}
