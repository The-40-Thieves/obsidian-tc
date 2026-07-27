#!/bin/bash
# PreToolUse/Edit|Write guard: refuse hand-edits to WHOLLY generated artifacts.
#
# Each file below is produced in full by a generator and verified by a CI gate. Editing one by
# hand does not fail loudly — it fails at the drift gate, one CI round later, with a message that
# does not say which edit caused it. Worse, a hand-edit that happens to match what the generator
# would have produced passes, teaching the next person that hand-editing is fine.
#
# PARTIALLY generated files (docgen marker regions in README.md, ARCHITECTURE.md, docs/wiki/*)
# are deliberately NOT blocked here: most of their content is hand-written prose and blocking them
# would stop legitimate work. They get a PostToolUse reminder instead (remind-regenerate.sh).
#
# Anchoring note, learned from ~/.claude/hooks/block-cave-footguns.sh: match the exact
# repo-relative path, never a substring. "TREE.md" as a substring also matches
# "docs/notes/TREE.md.bak" and any path containing it.
#
# Exit 2 = block, reason on stderr. Exit 0 = allow.

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

# Resolve repo-relative from the FILE's own directory, so this works inside git worktrees
# (parallel agents each get their own worktree; $CLAUDE_PROJECT_DIR would point at the wrong one).
DIR=$(dirname "$FILE")
ROOT=$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null) || exit 0
REL=${FILE#"$ROOT"/}
[ "$REL" = "$FILE" ] && exit 0   # outside the repo — not ours to police

block() {
  printf 'BLOCKED: %s is generated — do not hand-edit it.\n\n%s\n' "$REL" "$1" >&2
  exit 2
}

case "$REL" in
  TREE.md|docs/dependency-graph.json)
    block "Both files are produced together by scripts/gen-tree-map.mjs from the module graph.
Regenerate instead:
    bun run map          # writes both
    bun run map:check    # what CI runs (drift-gate step 4)

If you are resolving a merge conflict here, the repo configures a merge driver for exactly this
(scripts/merge-drivers/defer-regeneration.mjs) — run 'bun install' so the driver is registered,
then re-attempt the merge." ;;

  docs/obsidian-tc.config.schema.json)
    block "Generated from the Zod schema in packages/shared/src/config.schema.ts.
Edit the Zod schema, then:
    bun run config:schema          # regenerate
    bun run config:schema:check    # what CI runs (drift-gate step 3)

NOTE: config:schema:check is a DIFFERENT script from check:config-paths despite the similar
name. Running the latter does not cover this artifact." ;;

  packages/server/src/db/migrations-embedded.ts)
    block "Generated from packages/server/src/migrations/*.sql by scripts/gen-embedded-migrations.mjs.
It exists because 'bun --compile' bakes import.meta.url and embeds no assets, so the .sql files
cannot be read at runtime from a compiled binary.
Edit the .sql file, then:
    bun run migrations:embed          # regenerate
    bun run migrations:embed:check    # what CI runs (drift-gate step 5)

Migrations are append-only, hand-registered in db/migration-manifest.ts, and checksum-pinned —
editing a SHIPPED migration is a hard error at startup, not a warning." ;;
esac

exit 0
