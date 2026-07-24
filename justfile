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
