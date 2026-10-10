#!/bin/bash
# PreToolUse/Edit|Write guard: refuse hand-edits to WHOLLY generated artifacts.
#
# WHICH paths are protected comes from .claude/generated-paths.txt (`<path>\t<regenerate command>`),
# the single source of truth shared with generated-drift-backstop.sh and the global Bash guard.
# Adding a path there protects it everywhere; a path named only in this script is NOT blocked. The
# `case` below only holds the long per-file explanations, keyed by the same path. A listed path with
# no entry there gets a generic message that names its regenerate command.
#
# Each file is produced in full by a generator and verified by a CI gate. Editing one by
# hand does not fail loudly — it fails at the drift gate, one CI round later, with a message that
# does not say which edit caused it. Worse, a hand-edit that happens to match what the generator
# would have produced passes, teaching the next person that hand-editing is fine.
#
# Only artifacts that are still COMMITTED in full belong in the list. Everything that changes whenever any
# source file changes (TREE.md's counts, the dependency graph, the decisions index, the docgen
# marker regions) is no longer committed at all: it is generated at build time into gitignored
# paths (generated/, docs/src/content/docs/contributing/decisions-index.md) or committed
# canonical-empty, so there is nothing to hand-edit and nothing to block. TREE.md is hand-written
# prose. docs/wiki/* and the other docgen target files are prose around empty marker regions and get
# a PostToolUse reminder instead (remind-regenerate.sh).
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
[ "$REL" = "$FILE" ] && exit 0 # outside the repo — not ours to police

# Exact match against the list. No list = nothing is protected (fail open).
LIST="$ROOT/.claude/generated-paths.txt"
[ -r "$LIST" ] || exit 0
GEN=""
FOUND=0
while IFS=$'\t' read -r P G || [ -n "$P" ]; do
  case "$P" in "" | "#"*) continue ;; esac
  if [ "$P" = "$REL" ]; then
    FOUND=1
    GEN=$G
    break
  fi
done <"$LIST"
[ "$FOUND" = 1 ] || exit 0

block() {
  printf 'BLOCKED: %s is generated — do not hand-edit it.\n\n%s\n' "$REL" "$1" >&2
  exit 2
}

case "$REL" in
  docs/obsidian-tc.config.schema.json)
    block "Generated from the Zod schema in packages/shared/src/config.schema.ts.
Edit the Zod schema, then:
    bun run config:schema          # regenerate
    bun run config:schema:check    # what CI runs (drift-gate step 3)

NOTE: config:schema:check is a DIFFERENT script from check:config-paths despite the similar
name. Running the latter does not cover this artifact."
    ;;

  packages/server/src/db/migrations-embedded.ts)
    block "Generated from packages/server/src/migrations/*.sql by scripts/gen-embedded-migrations.mjs.
It exists because 'bun --compile' bakes import.meta.url and embeds no assets, so the .sql files
cannot be read at runtime from a compiled binary.
Edit the .sql file, then:
    bun run migrations:embed          # regenerate
    bun run migrations:embed:check    # what CI runs (drift-gate step 5)

Migrations are append-only, hand-registered in db/migration-manifest.ts, and checksum-pinned —
editing a SHIPPED migration is a hard error at startup, not a warning.

If you are resolving a merge conflict here, the repo configures a merge driver for exactly this
(scripts/merge-drivers/regen.mjs, named by .gitattributes) — it merges the two sides as data and
re-renders. Run 'bun install' so the driver is registered, then re-attempt the merge. GitHub's own
mergeability check ignores merge drivers, so a PR-page conflict still needs a local merge."
    ;;
  *)
    block "Regenerate it instead of editing it:
    ${GEN:-the generator named in .claude/generated-paths.txt}"
    ;;
esac
# Unreachable by design: every listed path blocks above, and an unlisted one exited 0 earlier.
