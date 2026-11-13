---
title: "git_commit"
description: "Commit the staged changes of the vault's git repo."
editUrl: false
---

Commit the staged changes of the vault's git repo. Always requires human confirmation (execute:git is a HITL-floor family) — a commit is irreversible-in-effect from the agent's side.

| | |
|---|---|
| **Domain** | git |
| **Scopes** | `execute:git` |
| **Access** | write |
| **Tags** | `writes`, `hitl`, `plugin-bridge`, `domain:git` |
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

A single-use `elicit_token` (or a transport-verified confirmation) is required on every call.

- The confirmation binds to a fingerprint of the state being approved, so a confirmation given for since-changed state is refused with `replay_drift`.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `message` | `string` | yes | — | length 3–2000 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `committed` | `number \| null` | yes | — |
| `fired_at` | `string` | yes | — |
| `stamped_trailers` | `string[]` |  | — |

## Related tools {#related-tools}

Other tools in the `git` domain: [`git_diff`](/tools/reference/git_diff/), [`git_log`](/tools/reference/git_log/), [`git_stage`](/tools/reference/git_stage/), [`git_status`](/tools/reference/git_status/).

Back to the [tool catalog](/tools/tool-catalog/).
