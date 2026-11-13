---
title: "git_log"
description: "Recent commits of the vault's git repo (hash/message/author/date), via the Obsidian Git companion bridge."
editUrl: false
---

Recent commits of the vault's git repo (hash/message/author/date), via the Obsidian Git companion bridge. Unavailable under a read whitelist (log messages enumerate paths).

| | |
|---|---|
| **Domain** | git |
| **Scopes** | `read:git` |
| **Access** | read |
| **Tags** | `read-only`, `plugin-bridge`, `domain:git` |
| **Profile** | full only |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | yes |
| Destructive | no |
| Idempotent | no |
| Accepts an idempotency key | no |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

No human confirmation is required to call this tool.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `limit` | `integer` |  | `20` | range 1–100 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `entries` | `object[]` | yes | — |
| `entries[].hash` | `string` | yes | — |
| `entries[].message` | `string` | yes | — |
| `entries[].date` | `string` | yes | — |
| `entries[].author` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `git` domain: [`git_commit`](/tools/reference/git_commit/), [`git_diff`](/tools/reference/git_diff/), [`git_stage`](/tools/reference/git_stage/), [`git_status`](/tools/reference/git_status/).

Back to the [tool catalog](/tools/tool-catalog/).
