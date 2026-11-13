---
title: "git_diff"
description: "Unified diff for one vault file (working tree, or the staged copy with staged: true), via the Obsidian Git companion bridge."
editUrl: false
---

Unified diff for one vault file (working tree, or the staged copy with staged: true), via the Obsidian Git companion bridge.

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
| `path` | `string` | yes | — | length 1–1024 |
| `staged` | `boolean` |  | `false` | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `staged` | `boolean` | yes | — |
| `diff` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `git` domain: [`git_commit`](/tools/reference/git_commit/), [`git_log`](/tools/reference/git_log/), [`git_stage`](/tools/reference/git_stage/), [`git_status`](/tools/reference/git_status/).

Back to the [tool catalog](/tools/tool-catalog/).
