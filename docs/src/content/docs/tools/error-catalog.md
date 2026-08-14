---
title: Error Catalog
description: Every canonical error code obsidian-tc can return, generated from the shared error factory so it cannot drift from the running server.
sidebar:
  order: 4
---

The complete error vocabulary, generated from the `err` factory map in
`@the-40-thieves/obsidian-tc-shared` so it never drifts from the running server. See the
[API Reference](/tools/api-reference/) for the response envelope these codes travel in, and the
[Tool Catalog](/tools/tool-catalog/) for the surface that raises them.

Errors arrive in the standard MCP error shape. The `code` below is what appears in the structured
payload; it is stable across releases and is what a client should branch on. Messages are defaults
and may be replaced at the throw site with something more specific about the failure.

:::note
This table is generated from the error factory (`bun run docgen:render`). Do not hand-edit the
region between the markers — add the error to the shared `err` map and regenerate.
:::

<!-- BEGIN GENERATED: errors -->
Every failure obsidian-tc returns carries one of these **35** canonical codes, **35** of which ship a recovery hint. The code is the stable contract — branch on it rather than on the message, which is a human-readable default that may be replaced with something more specific at the throw site.

| Code | Default message | Recovery |
|---|---|---|
| `aborted` | operation aborted by caller | The caller's AbortSignal fired before the operation finished. Re-issue the call fresh if the work is still wanted; this is not a transient failure of the operation itself. |
| `acl_denied` | path denied by folder ACL | This path is outside the folder ACL for this caller. Call inspect_acl to see which roots are permitted and retry within one of them. |
| `bases_syntax_error` | invalid .base YAML or filter syntax | The .base file's YAML or filter syntax is invalid. Fix the file — read_base shows how the server parses it. |
| `command_not_allowlisted` | command is not in the vault allowlist | The command is not in this vault's allowlist. Add it there (deny-by-default is intentional) — list_commands shows what is currently permitted. |
| `compute_budget_exceeded` | operation exceeded its compute budget | The input exhausted its compute budget and will do so again identically — do not retry. Simplify the pattern or expression, or narrow what it runs over. |
| `concurrent_modification` | note changed since it was read | The note changed after you read it. Re-read it, re-apply your edit to the new content, and retry with the fresh CAS token — do not retry the stale one. |
| `conflict` | conflict | Re-read the current state, re-apply the change on top of it, and retry. |
| `dql_error` | Dataview DQL error | Dataview rejected the query. Check it with validate_dql, which reports the syntax error without running it. |
| `elicit_invalid` | elicit token invalid or expired | The token was rejected or expired. Re-issue the original call with no token to trigger a fresh confirmation prompt. |
| `elicit_required` | human confirmation required | A human must approve this call. A client with MCP elicitation gets an inputRequired prompt; otherwise mint one with `obsidian-tc elicit --hash <args_hash> --tool <name>` and resend. Never reuse an old token. |
| `embedding_provider_error` | embedding provider failed | The embedding backend failed. Retryable; if it persists, confirm the provider is reachable and the configured model is present (server_health reports the provider). |
| `execute_command_disabled` | command execution is disabled for this vault | Command execution is off for this vault. It must be enabled in configuration; this is a policy decision, not a transient failure. |
| `forbidden` | scope or ACL denied | Missing a required scope (details.required lists it). Re-authenticate with a credential that grants it, or call inspect_acl to see what this caller may reach. |
| `internal` | internal error | Unexpected server-side failure. Retryable once; if it persists, check server_health and the server log rather than retrying further. |
| `internal_error` | internal error | Unexpected failure inside the handler. Retryable once; if it persists, capture the call and check the server log. |
| `invalid_input` | invalid input | Check the argument types and required fields against describe_capability's inputSchema before retrying. |
| `jsonlogic_error` | JSONLogic expression invalid | The JSONLogic expression is malformed. Verify the operator names and that every operator's argument arity matches. |
| `not_found` | not found | Confirm the target exists before retrying — note_exists checks one path, list_notes enumerates, and search_vault finds by content when the exact path is unknown. |
| `note_exists` | note already exists | Something is already at that path. Choose a different path, or use the tool's overwrite/append option if it has one. |
| `note_not_found` | note not found | Confirm the path first: note_exists checks it, list_notes enumerates the folder, search_vault finds the note by content. |
| `operation_timeout` | operation timed out | The operation exceeded its time budget. Retryable, but narrow it first — a smaller limit or a more selective query is more likely to finish. |
| `overflow` | response exceeds byte budget | The response exceeded the byte budget. Narrow the request — a smaller limit, fewer paths, or a compact/paginated read — rather than retrying unchanged. |
| `path_ambiguous` | path resolves to multiple notes | More than one note matches. Pass the full vault-relative path — list_notes or search_vault will show the candidates to choose between. |
| `path_invalid` | path is invalid | Paths are vault-relative, must stay inside the vault, and must not traverse upward. Rewrite the path rather than retrying it. |
| `plugin_incompatible` | companion plugin API version is incompatible with this server | The companion plugin's API major does not match this server's. Permanent until one side is upgraded; retrying will not help. |
| `plugin_missing` | required Obsidian plugin not detected | The required Obsidian plugin is not installed or not enabled. Enable it in Obsidian, then run refresh_plugin_capabilities so the server re-probes. |
| `plugin_unreachable` | plugin detected but REST endpoint failed | The plugin is present but its endpoint failed. Retryable; check Obsidian is running and the Local REST API is enabled and reachable. |
| `read_only` | server is in read-only mode | The server is in read-only mode, so no write will succeed until that changes. Use a read tool, or take this up with whoever runs the server. |
| `read_only_mode` | vault is in read-only mode | This vault is configured read-only. Target a writable vault, or change the vault's configuration; retrying cannot help. |
| `requires_live_obsidian` | this operation requires a live Obsidian (Local REST API) connection | This capability needs a live Obsidian connection and the vault is headless. Start Obsidian with the Local REST API, or use a filesystem-only equivalent. |
| `throttled` | rate limit exceeded | Rate limit for this scope class. Back off before retrying, and reduce batch size or spread the calls; a tight retry loop will keep hitting it. |
| `unauthorized` | authentication required | Authenticate first: send a credential this server accepts, then re-issue the call. |
| `unsupported_base_filter` | base uses the Obsidian Bases expression DSL, which query_base does not evaluate | This base uses Obsidian's Bases expression DSL, which query_base does not evaluate. Read the base and filter the rows yourself, or simplify the base's filter. |
| `validation_error` | input validation failed | Read the tool's inputSchema via describe_capability and correct the arguments; details names the offending field where one could be identified. |
| `vault_not_found` | vault not found | Use one of the ids from list_vaults, or register the vault first with add_vault (no restart needed). |
<!-- END GENERATED: errors -->

## Reading the Recovery column

Recovery hints say *what to do instead*; the `retryable` flag on the error says *whether* to retry.
They are deliberately separate — a code can be non-retryable and still have a clear next step.

A hint is a fixed string chosen by `code` alone. No path, query, caller, vault or argument is in
scope where it is selected, so a hint cannot leak vault content by construction rather than by
review. An em dash means the taxonomy declares no hint for that code — a considered choice, made
because guidance that only restates the message is noise, not an omission.

Where a failure can name specifics, those arrive in the error's `details` object (for example
`details.required` on `forbidden`, or the offending field on `validation_error`). Read `details` in
preference to parsing message text.
