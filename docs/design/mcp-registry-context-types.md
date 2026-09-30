# MCP registry: caller context and tool-definition types

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## SEP-2577 client features: roots and sampling (THE-583)

`CallerContext.roots` and `CallerContext.sample` surface the 2026-07-28 MCP revision's
deprecated-but-still-implemented `roots`/`sampling` client features. Deprecated by that revision but
functional for at least a twelve-month deprecation window (through at least 2027-07), so a client
mid-migration still uses them. The SDK still implements all three (logging, roots, sampling) despite
the deprecation.

They are surfaced on the context every tool receives — this is a public server, and the useful thing
is that a downstream tool author can reach the calling client's roots and model at all. The one
in-tree consumer of `sample` is `suggest_tags` (below). Both are `undefined` when the client did not
advertise the capability; an absent optional feature is a normal state, not an error. `roots` is
advisory only — vaults come from server config, and a client naming a root does not grant access to
it, which is exactly what makes consuming it safe.

### `suggest_tags`: the sampling consumer

`suggest_tags` (metadata domain, `read:notes`) is read-only: it returns tag candidates and writes
nothing, so applying one is an ordinary `add_tag` call with its scope, folder ACL, CAS and
memoryDefense. It was chosen over a summarizer or a reflect-synthesis path because tags are a small,
closed output (a strictly parseable JSON list, each entry checkable against the tag grammar) whose
context is a single note plus the vault's own tag vocabulary. Free-text summaries would put
unvalidated model prose into the tool result, and reflect's synthesis already has an operator-chosen
gateway path that sampling must not silently replace (see `sampleViaClient`).

- **What leaves the server.** One `sampling/createMessage` request to the caller's own client: a
  fixed system prompt, and one JSON document holding the note body (first 6000 characters), its
  title and path, and up to 100 existing tags. The note is a JSON string value, so text in it cannot
  close a delimiter; the system prompt states that everything in the document is untrusted data.
  `maxTokens` is 256. The note goes through the read ACL and scope check like `read_note`, and the
  vocabulary is counted only from notes the caller can read, so nothing the caller cannot read
  reaches the prompt. Human approval of the request is the client's job under the sampling spec.
- **What comes back is untrusted.** Text blocks only, at most 2000 characters, one JSON object with
  exactly a `tags` array of at most 20 valid tags of at most 64 characters each. Anything else
  rejects the whole reply (`sampling.status: rejected_response`); nothing of a rejected reply is
  echoed. The model name is echoed only if it looks like one.
- **Provenance.** `source` is `client-sampled` or `heuristic`; `sampling.status` is one of `sampled`,
  `unsupported` (client did not advertise sampling), `declined_or_failed`, `rejected_response`.
- **Fallback.** No sampling, a declined request or a rejected reply all return a deterministic
  heuristic: existing vault tags whose words all occur in the note, most specific first. It never
  invents a tag and never calls the gateway, because moving inference to a provider the operator did
  not choose is the thing `sampleViaClient` refuses to do. The tag `client-sampling` marks the tool
  for `toolVisibility`.
- **Transports.** `ctx.sample` is attached only when the client advertised `sampling`. Over stdio
  (a legacy `initialize` carries the capabilities) and an in-memory connection that is proven by
  `suggest-tags-sampling-e2e.test.ts`. Over stateless Streamable HTTP, legacy requests never populate
  client capabilities, so they get the heuristic; a modern request declaring `sampling` gets
  `ctx.sample`, but whether a real client can answer a server-initiated request there is the
  separate, unverified-in-this-repo claim the compat matrix records for roots. A failed round trip
  lands in the `declined_or_failed` fallback, never in an error.

## `episode_type` becomes a structural value, not a hardcoded literal (THE-839)

Before this type existed, `episodes.ts` hardcoded `'tool_call'` for every captured operation. A
count against live data found **192 of 630 live rows (30.5%) were MCP protocol methods labelled as
tool calls** — the column carried no information at all. A consumer asking "was this real work?"
had nothing structural to ask; the only available proxy, the shape of the tool's NAME, is not a
contract (SEP-986 permits `/` in tool names for hierarchy — `user-profile/update` is a documented
valid example — so a name-shape test would misclassify a spec-conforming tool, silently).

`EpisodeKind` fixes this by having the registry state the kind at the dispatch site, where it is
structurally known: `dispatch()` (tools/call) produces `tool_call`; `dispatchResource()`
(resources/* and prompts/*, THE-415) produces `protocol`. `tool_call`'s spelling is unchanged
deliberately — it was already the right value for a real tool call; the defect was protocol methods
borrowing it, not the value itself, and renaming would have churned 438 live rows and ten test
fixtures for no gain.

`verdict` (a registered tool tagged with `VERDICT_TOOL_TAG`, one whose whole job is to record a
judgement about other episodes) has no producer in this codebase yet. It is defined ahead of need so
THE-726 does not have to touch the producer a second time, and so a verdict verb cannot become its
own evidence.

See CHANGELOG.md (`#802, THE-839`) for the shipped-fix summary; this note carries the measured
figure that motivated it.

## `idempotentHint` is unconditional, not derived from `acceptsIdempotencyKey` (THE-743)

`ToolDefinition.idempotent` maps to the MCP spec's `ToolAnnotations.idempotentHint` — "calling the
tool repeatedly with the same arguments will have no additional effect on its environment," default
`false`, meaningful only when `readOnlyHint == false`. It is advisory metadata: dispatch authorizes
on `requiredScopes`/`destructive` and must never start enforcing on this field.

It is deliberately **not derived** from `acceptsIdempotencyKey`. The two are different claims, and
conflating them would advertise something false: accepting a key means a retry is safe *when the
caller supplies one*, and the key is optional — a repeat without it still has an effect.
`idempotentHint` is unconditional, about the arguments alone.

No tool declares this today, and that is a finding rather than an omission. Every mutating call on
this server leaves a durable record by construction: `forget_log` is an append-only hash-chained
audit (one INSERT per call), and destructive note writes capture a snapshot for `restore_note`
(THE-648, on by default under `trusted-local`). A second identical call therefore appends a second
audit row or a second snapshot version — an additional effect on the environment, which is exactly
what the hint denies. So `false` is the honest value for all 60 mutating tools at the time this
field was added, and it is also the spec default. The value of declaring the field is that the next
tool to be genuinely idempotent has somewhere to say so, and a gate that checks it.

## `domain`, `vaultArg`, `acceptsIdempotencyKey` close three silent-drift classes (THE-513)

All three fields exist to turn a runtime sniff or a hand-maintained side catalog into a
compiler-checked declaration on the tool definition itself:

- **`domain`** replaces a hand-kept facade domain map that had fallen 38 tools behind by the time
  THE-577 backfilled it. `ToolSpec` (m1/define.ts) requires it, so a production tool cannot ship
  without one — the old failure mode (silently landing in an "other" bucket) is now a type error at
  the definition site. Optional on the sink `ToolDefinition` type only because dispatch/throttle/HITL
  unit-test fixtures build bare literals unrelated to the facade.
- **`vaultArg`** names the input field carrying a tool's target vault id (default `"vault"`, the
  name every tool used before this field existed). Four call sites — vault binding, per-vault ACL
  swap, vault-kind gate, central pathAcl — read this instead of hardcoding `"vault"`. Before this
  field, a tool naming its vault argument anything else silently escaped all four checks (they saw
  `undefined` and skipped). Every mutating tool with a vault-shaped schema field must declare it,
  enforced by `vault-arg-coverage.test.ts`.
- **`acceptsIdempotencyKey`** declares that a tool's input schema exposes a whole-operation
  idempotency key (`idempotency_key` / `bulk_idempotency_key`, or nested `options.idempotency_key`
  — never a per-item `items[].idempotency_key`) recognized by `extractIdempotencyKey`. Before this
  field, that function sniffed the input shape at runtime for every one of ~150 tools and nothing
  declared which ones actually accept a key, so a capability that should be idempotent and isn't (or
  vice versa) went unnoticed. `idempotency-declaration-coverage.test.ts` cross-checks both
  directions: declared-but-schema-silent, and schema-exposes-a-key-but-undeclared.

## `conditionallyDestructive` exists so the wire annotation stops lying (THE-824)

A tool that calls `requireConfirmation` demands its elicit token *conditionally* (crossing a folder
boundary, an overwrite, a bulk-cost floor, ...), decided at runtime by the handler. `destructive`
(which drives dispatch's `isMutatingCall`/HITL gates via `policy-gates.ts`) must stay unset/false
for such a tool — setting it would make dispatch demand a token on EVERY call, not just the ones the
handler's own check flags, a real behavior change this field must never cause.

The field exists purely so the advertised annotation is honest: the MCP spec's own default for
`destructiveHint` is `true` ("cautious"), so a mutating tool that CAN demand confirmation but
declares neither `destructive` nor this flag was advertising `destructive: false` — a false
statement, not a conservative one. `mcp/facade.ts`'s `isAdvertisedDestructive` and
`mcp/server.ts`'s `toolAnnotations` OR this in alongside `destructive` for the wire annotation only;
every authorization/HITL/read-only gate in `mcp/registry/policy-gates.ts` reads *only* the real
`destructive` field and must keep doing so.

## `pathAcl`: centralizing folder-ACL enforcement (THE-414)

`pathAcl` returns the vault-relative paths a tool touches, tagged by op, so `runDispatch` enforces
the folder ACL centrally (immediately before the handler) instead of trusting each handler to call
`enforcePathAcl` itself. Handler-side calls stay as defense-in-depth. Every path-touching tool must
declare this (or sit in `acl-extraction-coverage.test.ts`'s documented exemption set); a mutating
tool with neither fails that guarantee test. Extractors must mirror the handler's own
`enforcePathAcl` calls exactly (same ops, same paths, same conditionals) so central enforcement
never denies a call the handler would have allowed.

## `resolvePolicy`: per-call authorization, not a static union (THE-727)

A tool that dispatches on an `action` argument cannot honestly declare one static scope set:
unioning makes a harmless read demand delete privileges; intersecting leaves a destructive action
under-governed. Neither is acceptable — this is why read+write consolidation for such tools was
blocked until `resolvePolicy` existed.

`resolvePolicy` resolves authorization from the call rather than the definition, generalizing the
signature `pathAcl` already proved out (a function of the input, enforced centrally in
`runDispatch`) rather than inventing a new one. Absent, the static `requiredScopes`/`destructive`/
`scopeClass` are used verbatim — purely additive, every existing tool untouched.

`OperationPolicy.requiredScopes` must be a SUBSET of the tool's static `requiredScopes`, which stays
the declared maximum the tool advertises. This is enforced at runtime, not just documented: a
resolver returning a scope the tool never declared is an under-declaration, and the advertised
surface would be lying about what the tool can do. Narrowing is the point; widening is a defect.

## `resolveTarget`: a target chosen by live external state, bound before the gates that key on arguments

The `*_active_file` tools have no `path` argument: the note they act on is whichever one the live
Obsidian session has open, which can change between two calls with identical arguments. Everything
dispatch keys on the arguments would be blind to that: the HITL `args_hash`, the idempotency claim,
the `replay_drift` fingerprint (built from `pathAcl`) and the folder ACL itself. Resolving the path
inside the handler would leave the central ACL stage and the confirmation looking at a call that
names no note, and a confirmation raised for note A would still redeem after focus moved to note B.

`resolveTarget(input, ctx)` is an optional async hook that returns the fields the caller did not
supply. Dispatch runs it after the auth, scope, vault-binding, per-vault ACL swap, read-only and
vault-kind gates (a caller those refuse never probes the live session) and before `precheck`,
idempotency and HITL. It then:

- merges the fields into the validated input, so `precheck`, `pathAcl`, `confirmationTargets` and the
  handler all see them (a returned key that the input schema already owns is refused as `internal`);
- recomputes the args hash over the raw arguments plus the resolved fields, and records that same
  object as the audit/episode arguments, so the confirmation, the idempotency claim and the trail
  name the note that was actually hit;
- enforces the folder ACL on the resolved paths at once, ahead of HITL, and rethrows a denial without
  `details.path`: the caller did not name the path, so echoing it would disclose the active note.

Absent, nothing changes for a tool. `defineTool`'s `ToolSpec` takes the merged shape as a third type
parameter so `pathAcl` and `handler` are typed against `input & resolved`.
