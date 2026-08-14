---
title: HITL Elicitation & the Governor
description: Human-in-the-loop confirmation for sensitive actions and the response-size governor.
---

## Human-in-the-loop elicitation

Sensitive operations require explicit human confirmation before they run. The
server issues an MCP **elicitation** request; the action proceeds only once the
human approves. Approval is single-use: it is consumed at the point the handler
runs (emitting `tc.elicit.consumed`), and a fresh request (`tc.elicit.requested`)
is required for the next sensitive call. The approval is bound to the exact vault, tool,
argument hash, and **issuing caller**, so on a multi-caller HTTP deployment one caller cannot
redeem another's approval.

The elicitation thresholds are **hardcoded floors** — a client cannot configure
them away. This keeps the confirmation gate present even under a permissive config.

## When your client can't render the prompt (THE-826)

The mechanism above assumes the client implements the MCP **elicitation** capability
(`elicitation/create`, SEP-2260/2322). Several real clients — Claude Code among them — do
not, so a call to one of the 16 conditionally-gated tools (`move_note` across a folder
boundary, `delete_note`, `restore_note`, `prune_hub_links`, and others) simply fails with
an `elicit_required` error and no round trip to complete it:

```json
{ "code": "elicit_required", "details": { "args_hash": "…" } }
```

There is no way to weaken this gate, and no reason to route around it by editing the
vault directly — doing so bypasses the audit trail, the folder ACL, and (for `delete_note`)
the snapshot `restore_note` depends on, all at once. Instead, mint the confirmation token
from the command line:

```sh
obsidian-tc elicit --hash <args_hash> --tool <tool_name> [--vault <id>] [--caller <id>]
```

- **`--hash`** is the `args_hash` the `elicit_required` error's `details` carried.
- **`--tool`** names the tool the confirmation is for (recorded for audit; the binding
  itself is the args_hash, which already encodes the tool name).
- **`--vault`** is required when the config lists more than one vault.
- **`--caller`** defaults to `"stdio"`, the identity every locally-spawned MCP client
  presents over the trusted stdio transport (`obsidian-tc serve <vault>`) — the common
  case this command exists for. On an HTTP/`jwt` deployment, pass the same value given
  to `token mint --sub`.

The command prints the token, and nothing else, to stdout; send the same call again with
`elicit_token: <token>` and it proceeds. The token carries every property the mechanism
above requires: it is bound to the exact vault, args_hash, and caller given (a token minted
for one call is refused for a different one), single-use, and expires after the configured
`elicitTtlSeconds` — there is no `--ttl` flag, so a mint can never outlive what the live
server itself would have issued.

**Authorization.** Minting requires opening the same `cache.db` the live server reads
`elicit_tokens` from — filesystem access to the vault's cache directory. That directory
already holds `auth.jwtSecret` and every configured provider API key; `token mint` already
treats read access to it as sufficient authority to issue a bearer credential with wildcard
scopes. This command asks for nothing stronger: whoever can read that directory could
already run `obsidian-tc serve` against it and dispatch the exact call being gated, with no
confirmation at all. There is deliberately no MCP tool for this — a tool would let the model
under the gate clear its own gate; the CLI keeps it a human-operator action.

## The response governor

A shared **governor** caps the byte size of any single tool response
(`governor.maxResponseBytes`). When a result would exceed the cap the call is
**refused** with an `overflow` error (rather than returning an unbounded payload);
the refusal is counted (`governor_truncations_total`) and emitted as
`tc.governor.overflow`. This bounds memory and protects clients from
pathologically large payloads.

An MCP `resources/read` honors the same configured `governor.maxResponseBytes` ceiling
(THE-514) — lowering it refuses an oversized resource too, not just an oversized tool
response. A resource's rejection is a plain `invalid_input` error (checked via a cheap
`stat()` before the file is read, rather than serializing the result first), so it does
not increment `governor_truncations_total` or emit `tc.governor.overflow` — those stay
specific to the tool-dispatch governor stage.

See [Observability](/observability/prometheus/) for the counters these emit.
