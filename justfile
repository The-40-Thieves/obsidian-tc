# obsidian-tc — monorepo tasks (thin wrappers over package.json scripts,
# kept so `just test` / `just lint` work uniformly across all repos)
# `just` with no args lists recipes.

_default:
    @just --list

build:
    bun run build

test:
    bun run test

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
