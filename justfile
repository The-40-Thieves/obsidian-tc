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
