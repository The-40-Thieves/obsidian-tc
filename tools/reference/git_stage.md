---
title: "git_stage"
description: "Stage vault files for the next commit, via the Obsidian Git companion bridge."
editUrl: false
---

Stage vault files for the next commit, via the Obsidian Git companion bridge. Write-family: the readOnly kill switch applies.

| | |
|---|---|
| **Domain** | git |
| **Scopes** | `write:git` |
| **Access** | write |
| **Tags** | `writes`, `plugin-bridge`, `domain:git` |
| **Profile** | full only |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
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
| `paths` | `string[]` | yes | — | items 1–200 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `staged` | `integer` | yes | range ≥ 0 |

## Related tools {#related-tools}

Other tools in the `git` domain: [`git_commit`](/tools/reference/git_commit/), [`git_diff`](/tools/reference/git_diff/), [`git_log`](/tools/reference/git_log/), [`git_status`](/tools/reference/git_status/).

Back to the [tool catalog](/tools/tool-catalog/).
