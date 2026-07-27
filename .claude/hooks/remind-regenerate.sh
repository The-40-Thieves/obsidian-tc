#!/bin/bash
# PostToolUse/Edit|Write: name the regeneration command for files whose EDIT invalidates a
# generated artifact somewhere else.
#
# This is the "adjacent artifact" problem: the file you edited is fine, but something derived from
# it is now stale, and the gate that notices lives in CI. Every case below has actually cost a CI
# round in this repo.
#
# Advisory only — always exit 0. A reminder that can block is a reminder that gets disabled.

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

DIR=$(dirname "$FILE")
ROOT=$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null) || exit 0
REL=${FILE#"$ROOT"/}
[ "$REL" = "$FILE" ] && exit 0

note() { printf '\n[obsidian-tc] %s\n%s\n' "$1" "$2" >&2; }

case "$REL" in
  packages/shared/src/config.schema.ts)
    note "config.schema.ts changed — docs/obsidian-tc.config.schema.json is now stale." \
"    bun run config:schema

Even a DESCRIPTION-only edit moves the generated JSON Schema. This exact case failed drift-gate
on PR #513. config:schema:check is NOT the same script as check:config-paths." ;;

  packages/server/src/migrations/*.sql)
    note "A migration changed — the embedded copy is now stale." \
"    bun run migrations:embed

Also required for a NEW migration: append it to CACHE_MIGRATION_FILES or
EXPERIENTIAL_MIGRATION_FILES in packages/server/src/db/migration-manifest.ts. Append, never
reorder. Never edit a migration that has already shipped — they are checksum-pinned." ;;

  README.md|ARCHITECTURE.md|docs/G2.4-observability.md|docs/wiki/Configuration.md|docs/wiki/Home.md|docs/wiki/Plugin-Bridges.md|docs/wiki/Tool-Reference.md|docs/src/content/docs/configuration/config-reference.md|docs/src/content/docs/observability/prometheus.md|docs/src/content/docs/tools/tool-catalog.md)
    note "$REL carries a docgen marker region (<!-- BEGIN GENERATED: ... -->)." \
"If you edited INSIDE a marker region, your change will be overwritten — edit the generator or the
source it reads instead. If you edited the surrounding prose, check the generated block still
agrees with it:
    cd packages/server && bun run docgen:render -- --check
    cd packages/server && bun run docgen:facts-check

Prose that restates a generated number is the drift this repo keeps re-finding." ;;

  packages/server/src/tools/*/*.ts)
    note "Tool surface may have changed." \
"Adding or removing a tool moves several counts at once:
    packages/server/test/registered-tool-count.ts   (REGISTERED_TOOL_COUNT)
    the facade domain map                            (tool-facade-domain-coverage.test.ts)
    boot.tools_registered                            (eval/perf/collectors/boot.ts, hard/exact)
    prose in ~15 doc files                           (docgen:facts-check is the strict gate)

Note boot.tools_registered is pinned at the MODULE-REGISTRAR count, which is 2 lower than
REGISTERED_TOOL_COUNT (health and index_status are registered inline in cli.ts)." ;;

  .github/workflows/*.yml|.github/workflows/*.yaml)
    note "Workflow changed." \
"    actionlint .github/workflows/*.yml

Two traps recorded in this repo: job-level continue-on-error does NOT survive a failed step, and
a required status check whose workflow is path-filtered blocks the PR forever on 'Expected —
waiting for status to be reported'. ci-server.yml and ci-docgen.yml are deliberately UNFILTERED
for that reason — do not re-add a paths: filter to them." ;;
esac

exit 0
