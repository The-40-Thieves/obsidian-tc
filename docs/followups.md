# Audit follow-ups — THE-113

Filed from the 2026-06-19 obsidian-tc technical audit. F1 and F2 shipped on branch
`fix/audit-hardening`; the three below are recorded here because the Linear MCP was
not authenticated in the remediation session. Create them as issues under Linear
epic [THE-113](https://linear.app/the-13th-letter/issue/THE-113).

## [med-high] F3 — Non-atomic publish

Up to 7 sequential immutable `npm publish` calls (4 platform sub-packages + the
native umbrella + shared + server) run in one job with no rollback. A mid-sequence
failure leaves a version-skewed half-release, and the immutable `v*` tag cannot be
re-run cleanly (npm versions cannot be overwritten).

Direction: a single transactional release step (changesets / turbo) or a
publish-or-rollback script with a `--dry-run` preflight that verifies all target
versions are unpublished, publishing the cross-referencing packages (umbrella +
server) last, plus a documented partial-publish recovery runbook.

Source: `.github/workflows/publish.yml`.

## [med] F4 — `acl_denied` misclassified in metrics/events

Handler-level path-ACL denials throw `acl_denied`, but dispatch's
`callStatusForError` maps only `forbidden` (plus `unauthorized` / `elicit_required`
/ `throttled`) to the `denied` status, and `incAclDenied` / the `tc.acl.denied`
MORGIANA event fire only for `forbidden`. So path-ACL blocks are recorded as
generic `error` and never counted as denials.

Fix: map `acl_denied` to the `denied` class and ensure the `acl_denied` metric and
`tc.acl.denied` event fire for it.

Source: `packages/server/src/mcp/registry.ts` (`callStatusForError`,
`emitCompletion`, the `incAclDenied` call), `packages/server/src/vault/acl-path.ts`.

## [med] F5 — Docs cite non-existent tools

The docs Tool Reference lists tool names absent from the registry: `set_frontmatter`,
`edit_canvas`, `daily_note`, `run_dql`, `run_command`, `memory_write`, `capture`,
`recall`, `bulk_read` / `bulk_write` / `bulk_delete`, `build_uri`, `get_health`.
The real names are e.g. `update_frontmatter`, `update_canvas`,
`create_periodic_note`, `search_dql`, `execute_command`, `add_observation`,
`enqueue_capture`, `plur_recall`, `bulk_create_notes` / `bulk_move_notes` /
`bulk_set_property`, `generate_uri`, `server_health`.

Fix: regenerate the Tool Reference from the live `ToolRegistry` (103 tools / 28
domains) or correct the examples; add a docs-vs-registry check in CI so the page
cannot drift again.

Source: `docs/src/content/docs/tools/index.md`.
