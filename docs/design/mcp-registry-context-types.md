# MCP registry: caller context and tool-definition types

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## SEP-2577 client features: roots and sampling (THE-583)

`CallerContext.roots` and `CallerContext.sample` surface the 2026-07-28 MCP revision's
deprecated-but-still-implemented `roots`/`sampling` client features. Deprecated by that revision but
functional for at least a twelve-month deprecation window (through at least 2027-07), so a client
mid-migration still uses them. The SDK still implements all three (logging, roots, sampling) despite
the deprecation.

They are surfaced on the context every tool receives, rather than consumed by any tool this server
happens to ship — this is a public server, and the useful thing is that a downstream tool author can
reach the calling client's roots and model at all. Both are `undefined` when the client did not
advertise the capability; an absent optional feature is a normal state, not an error. `roots` is
advisory only — vaults come from server config, and a client naming a root does not grant access to
it, which is exactly what makes consuming it safe.

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
