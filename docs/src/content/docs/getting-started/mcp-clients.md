---
title: MCP client compatibility
description: Which MCP clients connect to obsidian-tc, over which transports, and what each one actually sees. Measured rows only — untested cells say so.
---

**This table is incomplete on purpose.** Every filled cell was observed against a running server;
every unfilled one says `UNTESTED` rather than guessing. A compatibility matrix whose blanks are
inferred is worth less than no matrix, because a reader cannot tell which cells were measured.

Contributions welcome — the [reproduction steps](#reproducing-a-row) below are the whole method.

See also [`MCP-CLIENT-COMPAT-MATRIX.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/MCP-CLIENT-COMPAT-MATRIX.md)
for known MCP client versions' protocol-revision ceilings sourced from outside this repo
(not measured against a running obsidian-tc), alongside this server's own per-revision behavior for
client identity and the deprecated Logging/Roots/Sampling features.

## The matrix

Measured against **obsidian-tc 1.19.0** on **Ubuntu 24.04 aarch64** (Ampere), which is also the
platform of a required CI leg and of the maintainer's production deployment.

**Re-verified on 1.20.0 (2026-08-07)** by re-running the stdio probe from
[Reproducing a row](#reproducing-a-row). Every claim in the Claude Code row still holds: the
negotiated version is `2025-11-25`, `tools/list` returns exactly the three facade tools, each
carrying `name` / `title` / `description` / `inputSchema` / `annotations`, and the advertised
capabilities are `tools` / `prompts` / `resources` / `logging`. The captured output below is left at
its original 1.19.0 capture rather than restamped — it was a real observation on a real config, and
re-labelling it with a version it was not taken under would be the kind of quiet drift this page
exists to avoid.

| Client | stdio | Streamable HTTP | Surface | `outputSchema` | Auth | Recommended `toolFacade.mode`[^mode] |
|---|---|---|---|---|---|---|
| **Claude Code** | ✅ connects | ✅ connects | 3-tool facade | ✅ honoured | bearer on HTTP; none on stdio | `triad` — measured |
| **Codex CLI** | ✅ connects (0.159.2, headless) | `UNTESTED` | 3-tool facade | `UNTESTED` | none on stdio | `domain` — measured |
| Claude Desktop | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` | `triad` — unmeasured |
| Cursor | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` | `triad` — unmeasured, from docs |
| Gemini CLI | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` | `triad` — unmeasured, from docs |
| VS Code | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` | `triad` — unmeasured |

The unfilled rows need a desktop session driving GUI clients (or, for Gemini CLI, a run nobody has
done yet). Nothing about them is known to be broken; they simply have not been exercised.

[^mode]: The facade mode to set for that client, and how firmly the evidence supports it — the
    measurement, its limits and the per-client reasoning are in
    [Choosing a facade mode per client](#choosing-a-facade-mode-per-client). **Measured** means
    real headless runs of that client; **unmeasured** means no run exists and the cell is a
    recommendation from the client's own documentation (or, for Claude Desktop and VS Code, only
    the shipped default).

**Why daily production use does not fill them.** It is reasonable to assume a server in constant use
must know which clients connect to it — obsidian-tc even captures `client_name` / `client_version`
from MCP `_meta`. In the maintainer's deployment those columns are `NULL` on every session, because
every request arrives through a gateway that presents its own principal; the end-user client sits
behind that hop and is structurally invisible to the server. So this matrix cannot be back-filled
from traffic, however much traffic there is. It needs **direct** client-to-server connections, which
is exactly what the reproduction steps below describe.

## Choosing a facade mode per client

`toolFacade.mode` picks what `tools/list` advertises (see the
[tool-surface facade](/tools/#tool-surface-facade)): `triad` (three meta-tools, the default),
`domain` (about a dozen `{ action, args }` domain tools) or `flat` (every tool, around 300 KB of
`tools/list` against about 2 KB for `triad`). Set it explicitly per client (`auto`, which guessed from the
client's name, is deprecated, now resolves to `triad` for every client, and will be removed in the next major version). Several clients now do their own progressive disclosure of MCP tools,
which could make the triad's find/describe layer redundant, so the three modes were run against
real headless clients on a fixed task set before any recommendation was written.

**Short answer: leave `triad` (the default) for Claude Code** (with its tool search on, which is its
default): no mode beat it by the margin fixed in advance, and where a mode differed, the difference was
cost, not whether the model found the right tool. **For Codex, set `toolFacade.mode: domain`**: all three
modes found the right tool every time (192 of 192 trials), and `domain` needed half the calls of `triad`
with no tool-not-found. `flat` is a near tie with it (see [Codex CLI](#codex-cli)). The shipped default
stays `triad`.

### How it was measured

- **Pre-registered.** The task set, metrics and decision rule were frozen before the first measured
  run (`PREREGISTRATION.md`, sha256
  `aecd3a921eb4c5c272ef777a49ff9659104752b0623aa39a6cfbc9abbb339588`, recorded 2026-10-02T04:28:53Z).
  The harness is [`eval/write-ergonomics`](https://github.com/The-40-Thieves/obsidian-tc/tree/main/packages/server/eval/write-ergonomics)
  (`--facade triad|domain|flat --task-set facade`).
- **Tasks.** 16, all arm `main`: six write tasks that begin with a find step (tag a note found by title,
  bulk-tag five notes, update a memory observation, rename with backlinks, set a frontmatter field,
  append to a daily note) and ten read-and-answer discovery tasks (backlinks, outgoing links, dangling
  links, tags in a folder, notes by property value, open checkbox tasks, a canvas graph, a base view,
  memory recall, a full-text fact). Every verdict is a deterministic checker over the vault or the final
  answer.
- **Metrics.** Task success; calls-to-success (server `tools/call` plus the client's own tool-search
  calls, passing trials only); tool-not-found errors (the server's unknown-tool answers plus the
  client's own "no such tool" for an obsidian-tc tool).
- **Rule.** Modes within 2 trials of the best success are tied; among tied modes, fewer calls, then fewer
  not-found, then fewer tokens. The default is kept unless another mode beats it on success by more than
  the tie band, or ties it on success and is better on both calls and not-found. Detectable difference
  at 32 trials per cell is roughly 20–35 points of success rate; smaller gaps are "not distinguished".
- **Scope.** Claude Code 2.1.285 (`claude-sonnet-5-5`), Codex CLI 0.159.2 (default model `gpt-6.1-sol`,
  Pro plan; see [Codex CLI](#codex-cli) for its own pre-registration), obsidian-tc 1.31.8, stdio,
  local embedder (semantic search degraded, identical on every trial), a 1,357-note vault plus seeded
  notes. The note with unparseable frontmatter used by the write-ergonomics tasks was left out because it
  makes backlink, tag and base queries fail vault-wide, which would swamp this comparison.

### Claude Code

Claude Code's client-side tool search is on by default: unless `ENABLE_TOOL_SEARCH` is set, MCP tools
are deferred and loaded on demand
([MCP docs](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search)). The runs kept it on
(`ToolSearch` available) and, as a secondary arm, removed it (every MCP definition loads upfront, the
same effect as `ENABLE_TOOL_SEARCH=false`). 32 trials per mode and arm.

| Claude Code | success | median calls-to-success | trials with an error (errors) | tool-not-found | median billable tokens |
|---|---|---|---|---|---|
| `triad`, tool search on | 32/32 | 5 | 14 (17) | 0 | 6.5k |
| `domain`, tool search on | 32/32 | 4 | 32 (46) | 0 | 6.5k |
| `flat`, tool search on | 32/32 | 4.5 | 4 (4) | 0 | 9.0k |
| `triad`, tool search removed | 32/32 | 4 | 22 (23) | 0 | 5.4k |
| `domain`, tool search removed | 32/32 | 2 | 32 (42) | 0 | 4.1k |
| `flat`, tool search removed | 32/32 | 2 | 2 (4) | 0 | 3.9k |

Billable tokens are uncached input plus cache writes plus output, with the prompt cache warm from the
previous trial; read them as a ratio between rows, not as a price.

- **Success is at the ceiling (96 of 96 with tool search on), so it cannot separate the modes.** The
  deferred-tool path works: the model reads the advertised names, loads the one it wants with
  `ToolSearch`, and calls it, in every mode. No trial hit a "no such tool" for an obsidian-tc tool.
- **`domain` makes the model guess arguments.** Every one of its 32 trials had at least one validation
  error, usually the missing `vault`: a domain tool's schema is `{ action, args }`, so the per-action
  schema is not visible until the call fails. `triad` shows it through `describe_capability`, `flat`
  through the tool's own schema (4 trials with an error).
- **`flat` costs about 38% more billable tokens** with tool search on (a full list is loaded into the
  deferred set) and needs two `ToolSearch` calls per trial against one for the others, for no gain in
  success. Its calls-to-success (4.5 vs 5) is inside the tie band, so the default stands.
- **`triad` is one call longer** at the median than `domain`: the `describe_capability` step the
  client-side search makes partly redundant. That is a cost of one call, not a failure.
- **If you have turned tool search off** (secondary arm, descriptive, not part of the decision rule),
  `flat` and `domain` took half the calls of `triad` (2 vs 4) with the same success; `flat` also held
  errors to 4 against 23 and 42. That is the one setting where this data would favour changing the mode.

### Codex CLI

Codex defers every MCP tool behind its own `tool_search`; the feature flags that used to control it are
no-ops ([`codex-rs/features`](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs),
[PR #29486](https://github.com/openai/codex/pull/29486)). It has a known weakness that matters for any
find-then-call facade: `tool_search` can miss a deferred tool even when the query names it exactly
([#21503](https://github.com/openai/codex/issues/21503)).

The Codex cells were measured in a follow-up once the usage limit that cut the first matrix short had
lifted: a separate pre-registration (sha256
`e7402a1cff9681203275ee97af08c9b73b002474d744c937896bf57131675289`, recorded 2026-10-02T21:33:31Z, four
addenda) with the same 16 tasks, corpus, checkers, server build (obsidian-tc 1.31.8 at `eb637ce3`) and rule.
All three modes were re-run together, sequentially, one headless Codex process at a time, under Codex CLI
0.159.2 and one default model (`gpt-6.1-sol`, probed before and after every cell), because the earlier
`triad` cell did not record its model and its one miss was the since-fixed checker. 64 trials per mode
(4 reps, because the rule's "close cell" test asked for reps 3 and 4), every trial confirmed complete (a
`turn.completed` event, exit 0, a final message). The record is in
[the Codex cells measurement note](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/plans/2026-10-02-facade-codex-cells-measurement.md).

| Codex CLI | success | median calls-to-success | trials with an error (errors) | tool-not-found | median billable tokens |
|---|---|---|---|---|---|
| `triad` | 64/64 | 5 | 7 (12) | 5 trials (10 events) | 20.4k |
| `domain` | 64/64 | 2.5 | 55 (65) | 0 | 20.5k |
| `flat` | 64/64 | 3 | 8 (8) | 0 | 20.8k |

- **Success is at the ceiling in every mode, so it separates nothing**; the rule falls through to
  calls, then tool-not-found. `domain` beats `triad` on both (2.5 against 5 calls; 0 against 5 trials
  with a tool-not-found), so the pre-registered rule picks `domain`.
- **`flat` is not distinguished from `domain`.** Its median is 3 calls against 2.5 (means 3.25 against 3.19),
  also with no tool-not-found, so the rule's own "close" test still flags the pair after four reps. The
  difference that does show is friction: `domain` had at least one validation error in 55 of 64 trials
  (49 of its 65 errors were the missing `vault`, the rest wrong argument shapes, because a domain action's
  schema cannot be seen before the call fails; every one was followed by a retry that worked), `flat` in 8. If you prefer fewer failed calls to fewer calls, `flat` is the equally
  supported choice for Codex.
- **Billable tokens do not differ** (20.4k, 20.5k, 20.8k), as expected: Codex defers every MCP tool behind
  `tool_search`, so the 318 KB `tools/list` of `flat` is not paid for upfront the way it is by a client
  that loads definitions.
- **`triad` costs about two more calls.** Its tool-not-found events are all the model guessing capability
  names (`search_entities`, `list_entities`, `delete_observation`) in `describe_capability` before finding
  the real one; every such trial still passed. The `tool_search` exact-name miss feared above did not show up in `flat` or
  `domain` (0 trials).
- **Against the first `triad` cell** (16 trials, 15 of 16, median 5 calls, 20.7k): the same behaviour, now
  64 of 64 with the fixed checker.

Caveats specific to Codex: one model (the CLI's default, `gpt-6.1-sol`, not pinned by the harness, and the
first `triad` cell's model was not recorded), one plan, headless runs with the shell tool off; the account
had Codex connectors available and no trial called one. A different default model could move the result.

### Clients that could not be run headless

These rows are **unmeasured — recommendation from docs**, not a result.

- **Cursor** — recommend `triad`. Cursor now keeps only tool names in static context and syncs tool
  descriptions to a folder the agent reads on demand
  ([Dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery): "a small bit of static
  context, including names of the tools"; 46.9% fewer agent tokens in runs that called an MCP tool). A
  40-active-tool cap was reported on the
  [Cursor forum](https://forum.cursor.com/t/tool-specialized-agent-switching-in-cursor-dynamic-mcp-tools-management/74196);
  whether it still applies was not verified, but it is one more reason not to advertise `flat`.
- **Gemini CLI** — recommend `triad`. Each MCP tool is exposed as `mcp_<server>_<tool>`, characters other
  than letters, digits, `_`, `-`, `.` and `:` become `_`, and names over 63 characters are truncated
  ([MCP server docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)).
  obsidian-tc's longest tool name is 28 characters, so `mcp_obsidian-tc_<tool>` stays under that limit in
  every mode; the choice is therefore about context cost, and the three-tool surface is the smallest.
  The page documents no deferral of MCP tools.
- **Claude Desktop, VS Code** — no client-specific evidence was gathered; keep the default.

### Caveats

One model per client, one 16-task set, one vault, a degraded embedder, stdio only. Success sat at the
ceiling for Claude Code, so the data separates the modes on cost and friction, not on whether a model can
find a tool. A task set where the right tool is harder to find (several near-duplicate tools, a much larger
vault) could separate them; the harness takes more tasks.

## Approval prompts when the client runs headless

Some tools ask for a human confirmation (see [Human-in-the-loop](/security/hitl-elicit/)). A headless
client has no human to ask, and the two measured clients answer the server's `elicitation/create`
within milliseconds:

| Client | What it does headless | What the server returns | What to do |
|---|---|---|---|
| Claude Code (`claude -p`) | Advertises elicitation, then auto-**cancels** | `approval_not_obtained`, with a `recovery` that names the `obsidian-tc elicit` route | Offer the out-of-band route: mint a token with `obsidian-tc elicit` and let the agent retry, or run the operation yourself |
| Codex (`codex exec`) | Advertises elicitation, then auto-**declines** | `approval_declined`: a hard stop, the agent is told not to retry or mint a token | The agent cannot recover. Approve it yourself: mint the token with `obsidian-tc elicit` in your own shell and retry, or run the tool interactively |
| Cursor, Gemini CLI, Claude Desktop, VS Code | Not measured | | Follow the [HITL page](/security/hitl-elicit/); do not assume a prompt is rendered |

Measured in the write-ergonomics study with Claude Code 2.1.285 and Codex 0.159.2: both advertised
elicitation and answered within milliseconds without a human. The facade mode does not change this; it
applies in `triad`, `domain` and `flat` alike.

## What was observed

### stdio

The server announces itself and serves without a token:

```
security: profile=trusted-local auth=jwt readOnly=false strictRead=false requireCas=false http=on
obsidian-tc 1.19.0 ready on stdio (vault agents; native=on vec=on)
```

`initialize` returns:

```json
{ "protocolVersion": "2025-11-25",
  "serverInfo": { "name": "obsidian-tc", "version": "1.19.0" },
  "capabilities": { "tools":     { "listChanged": true },
                    "prompts":   { "listChanged": true },
                    "resources": { "listChanged": true, "subscribe": true },
                    "logging":   {} } }
```

`tools/list` returns exactly three tools — `find_capability`, `describe_capability`,
`call_capability` — each carrying `name`, `title`, `description`, `inputSchema`, `annotations`.

**On the negotiated version.** A client that sends a 2025-era `initialize` gets `2025-11-25` back,
*even if it names a later version in the request*. That is correct rather than a downgrade: the
2026-07-28 revision **removed the initialize/initialized handshake entirely** (SEP-2575), so a
2026-era client does not handshake at all and is classified per request instead. Asking for
`2026-07-28` inside an `initialize` is a contradiction in terms, and the server resolves it the
only way it can.

Legacy support is deliberate and load-bearing, not residual: the gateway in front of the
maintainer's deployment pins an MCP client whose ceiling is `2025-11-25`. Dropping the older era
would take that plane down.

### Streamable HTTP

Requires a bearer token, and refuses cleanly without one — HTTP `401` with a well-formed JSON-RPC
error rather than a bare status or a hang:

```json
{ "jsonrpc": "2.0", "error": { "code": -32001, "message": "missing bearer token" }, "id": null }
```

Authenticated, `describe_capability` returns a full JSON Schema `output_schema` alongside
`required_scopes` and `annotations { read_only, destructive }`.

**Auth applies per transport.** With `auth.mode: "jwt"` configured, HTTP demands a bearer while
stdio does not — stdio's trust boundary is the process boundary. Worth knowing before exposing a
port.

### Cross-platform

Four `build-test` legs are **required** on every pull request:

| leg | |
|---|---|
| `ubuntu-latest` | x86_64 |
| `ubuntu-24.04-arm` | **aarch64** |
| `macos-latest` | |
| `windows-latest` | |

The aarch64 leg is not padding. `search/vec.ts` records the same commit producing nDCG@10
**0.8028** on aarch64 and **0.8414** on x86_64 — while `recall_at10` and the candidate counts
matched *exactly*. The difference is **tie ordering**, not retrieval quality: chunks with identical
content embed to bit-identical distances, and on that corpus the rank-10 distance spans the top-10
cut, so the tie order decides top-10 membership. Ranking metrics move; set-based ones do not.

That is a narrow effect on a duplicate-heavy fixture rather than a statement about arm retrieval
being worse. It is still the reason arm is a first-class target rather than a portability
courtesy — a platform where the SAME commit's ranking metrics can diverge like this is one the
required `build-test` matrix has to catch on every PR, not one measured occasionally and trusted
the rest of the time.

## Reproducing a row

### stdio

Pipe a handshake straight into the server; no client required.

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"0.1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| obsidian-tc serve ./my-config.json
```

The process stays alive after answering — stdio has no end-of-stream. Read the responses and stop it.

### Streamable HTTP

```bash
curl -s -X POST http://127.0.0.1:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"0.1"}}}'
```

Omit the `Authorization` header to observe the refusal path.

## What each column means

- **stdio / Streamable HTTP** — whether the transport connects and completes a handshake at all.
- **Surface** — whether the client is shown the 3-tool facade (`find_capability` /
  `describe_capability` / `call_capability`) or the full per-tool catalogue. The facade exists
  because tool-selection quality collapses well before a catalogue this size (the measured per-client advice is [above](#choosing-a-facade-mode-per-client)).
- **`outputSchema`** — whether the client requests and honours structured output. The server emits
  `structuredContent` whenever a tool declares an output schema, including on the **error** path so
  a model can self-correct from the validation issues. Every result also carries a text block that
  answers the call on its own, for clients that read only `content`. If a client mishandles the
  advertised schema itself, set `toolFacade.outputSchema: omit` (see
  [MCP compatibility](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/MCP-COMPATIBILITY.md)).
- **Auth** — which transports demand a bearer under `auth.mode: "jwt"`.
