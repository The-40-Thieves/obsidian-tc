---
title: "git_status"
description: "Working-tree status of the vault's git repo (changed/staged/conflicted), via the Obsidian Git companion bridge."
editUrl: false
---

Working-tree status of the vault's git repo (changed/staged/conflicted), via the Obsidian Git companion bridge. Unavailable under a read whitelist (repo status enumerates every path).

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

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `changed` | `object[]` | yes | — |
| `changed[].path` | `string` |  | — |
| `changed[].working_dir` | `string` |  | — |
| `changed[].index` | `string` |  | — |
| `staged` | `object[]` | yes | — |
| `staged[].path` | `string` |  | — |
| `staged[].index` | `string` |  | — |
| `conflicted` | `string[]` | yes | — |

## Related tools {#related-tools}

Other tools in the `git` domain: [`git_commit`](/tools/reference/git_commit/), [`git_diff`](/tools/reference/git_diff/), [`git_log`](/tools/reference/git_log/), [`git_stage`](/tools/reference/git_stage/).

Back to the [tool catalog](/tools/tool-catalog/).
