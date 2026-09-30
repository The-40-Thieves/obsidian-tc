---
title: HITL Elicitation & the Governor
description: Human-in-the-loop confirmation for sensitive actions and the response-size governor.
---

## Human-in-the-loop elicitation

Sensitive operations require explicit human confirmation before they run. The
server issues an MCP **elicitation** request; the action proceeds only once the
human approves. The approval is bound to the exact vault, tool, argument hash,
and **issuing caller**, so on a multi-caller HTTP deployment one caller cannot
redeem another's approval.

**Single-use, precisely: it depends on which mechanism cleared the gate.** The
`obsidian-tc elicit` CLI token and the legacy server-initiated shim (stdio) are
genuinely single-use — the CLI token is consumed with `UPDATE ... WHERE
consumed_at IS NULL`, and the shim's confirmation never leaves the server at
all, so there is nothing a client could replay. The 2026-07-28 client-driven
`requestState` (SEP-2260/2322) is **replayable within its TTL** — a deliberate,
documented trade (see `elicit-request-state.ts`): the codec authenticates and
expires the state but does not consume it, so a captured `requestState` can
authorize the same call more than once until it expires. Either way,
`tc.elicit.consumed` fires once per handler run (not once per approval), and a
fresh confirmation (`tc.elicit.requested`) is required for the next sensitive
call.

**Stale confirmations are refused.** An approval covers the state of the target as it was
when the request was raised, not just the tool and arguments. When the call's target paths
(the ones the tool declares for the folder ACL) change between the request and the
redemption, whether by an edit, an mtime change, or a note appearing or disappearing, the
server answers `replay_drift` and applies nothing. The token is spent; re-issue the original
call with no token to request a fresh confirmation. This holds for every route a
confirmation can arrive by: a token minted by `obsidian-tc elicit`, the stdio form round
trip, the 2026-07-28 `requestState`, and the lean facade's `call_capability`. A token minted
with no raised request behind it, and tools that declare no target paths (`execute_command`,
`git_commit`, `trigger_quickadd`, `session_rerun`, `reset_vault_cache`, `delete_entity`,
`rewrite_link`, `ocr_bulk`), are bound to the arguments alone.

The elicitation thresholds are **hardcoded floors** — a client cannot configure
them away. This keeps the confirmation gate present even under a permissive config.

## The `inputRequired` round trip, on stdio too

A client that advertises the MCP **elicitation** capability (`elicitation/create`,
SEP-2260/2322) gets the confirmation as an actual protocol round trip — the server
answers `inputRequired({ requestState, inputRequests: { confirm: … } })`, and the
call completes once the human answers `accept` with `approve: true`. This works on
**both** stdio and HTTP, and on **both** protocol eras:

- On a MODERN (2026-07-28) connection, the client drives the round trip itself:
  it shows the form, resubmits the call echoing back `requestState` and the
  answer, and the server verifies both before trusting them.
- On a LEGACY (2025-11-25/2025-06-18) connection, the underlying MCP SDK's
  low-level `Server` fulfils the round trip *server-side*: it sends the
  `elicitation/create` request itself, waits for the answer, and re-enters the
  handler with a verified `requestState` — the client sees nothing different
  from the modern case except the wire shape. This legacy path is opt-in and
  **stdio-only** (`legacyElicitationShim`); Streamable HTTP never takes it, since
  a server-initiated request over stateless HTTP is unverified against real
  clients and out of scope. A legacy-era HTTP session behaves exactly as it did
  before this mechanism existed: the plain `elicit_required` error below.

Either way: a decline, a cancel, or an explicit `approve: false` renders the same
`elicit_required` error as an unconfirmed call — never a second prompt, and never
treated as an approval (a verified `requestState` alone proves the confirmation is
*authentic*, never that it was *granted* — the server also checks the elicitation's
own answer before trusting it). The single-use elicit-token/CLI mechanism below is
what a client with no elicitation capability at all still falls back to.

A client that declares a bare `elicitation: {}` capability (no `form`/`url` sub-key)
is treated as supporting form mode — the 2025 spec's pre-mode default — not as
declining elicitation; this applies uniformly, on every transport and era.

## When your client can't render the prompt

A client with NO elicitation capability at all gets nothing to act on: a call to
one of the 16 conditionally-gated tools (`move_note` across a folder boundary,
`delete_note`, `restore_note`, `prune_hub_links`, and others) simply fails with
an `elicit_required` error and no round trip to complete it. The error text itself
leads with a directive telling the AGENT to ask the human before running anything —
it is not an instruction the agent should act on unilaterally:

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

`read_notes` is the exception to that refusal: it stays under the cap by paging. It returns the
notes that fit plus a `next_cursor`, and the caller repeats the same request with `cursor` set until
`next_cursor` is `null`. Every page makes progress; a note that could never fit is reported as a
per-path `too_large` error (with its `size` and the `budget`) and skipped. The cursor is HMAC-signed
and bound to the caller, the tool and the request arguments, expires after ten minutes, and is
refused as `invalid_input` (`details.reason` is `expired`, `invalid`, `foreign` or
`request_mismatch`) if replayed by another caller or against a different request. The folder ACL is
re-checked per note on every page, so a path revoked mid-walk is not served.

An MCP `resources/read` honors the same configured `governor.maxResponseBytes` ceiling
— lowering it refuses an oversized resource too, not just an oversized tool
response. A resource's rejection is a plain `invalid_input` error (checked via a cheap
`stat()` before the file is read, rather than serializing the result first), so it does
not increment `governor_truncations_total` or emit `tc.governor.overflow` — those stay
specific to the tool-dispatch governor stage.

See [Observability](/observability/prometheus/) for the counters these emit.
