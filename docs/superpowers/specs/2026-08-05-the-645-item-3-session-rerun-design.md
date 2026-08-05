# Session Re-run (THE-645 item 3) — Design

**Date:** 2026-08-05
**Ticket:** THE-645 item 3 — *"sessions cannot be replayed"*. Items 1 and 2 shipped (#563, #718).
**Depends on:** THE-736 (#721, merged) — the trace carries arguments for the first time.
**Status:** approved design → implementation plan next.

## Problem

THE-645 item 3 asks for a way to *"re-run a recorded sequence against current vault state for
debugging or regression testing."*

Until #721 that was impossible: every dispatch appended `args_hash` (a hash) and `result_size` (a
number) and nothing else, so a runner would know `patch_note` had been called and have nothing to
send. THE-736 closed that — `TraceRecord.args` now carries the raw arguments when
`sessions.traceContent` is on (`workspace/sessions.ts:353-373`).

Three properties of that capture shape the whole design, and none of them are negotiable here
because each was decided in THE-736 rather than by this ticket:

1. **Arguments only. Results are not captured**, and deliberately so — results are strictly larger
   and more sensitive. What is recorded per call is `status`, `error_code`, `result_size` and
   `duration_ms`.
2. **Capture is dark by default.** `sessions.traceContent` defaults `false`
   (`shared/src/config/runtime.schema.ts:175-180`), gated on the THE-238 red-team. On the current
   production deployment **every** trace record therefore has no `args` field at all.
3. **Captured arguments never leave through `get_session_traces`.** That tool is
   `read:workspace`-scoped, does not filter by principal, and strips `args`/`args_scan` on the way
   out (`tools/m5/session-tools.ts:261`). A re-run must read the trace file **server-side**.

## What "re-run" means here, and what it deliberately is not

The prevailing meaning of *replay* in agent tooling is **reconstruction**: record every step result,
then walk the control flow again substituting stored results, so nothing executes and no side
effect repeats. That is the Temporal / event-sourcing model, and it is what replay-from-trace eval
modes in agent frameworks do.

**obsidian-tc cannot do that, and the reason is a decision already taken rather than a limitation of
this design.** Reconstruction needs recorded results; THE-736 captured arguments and explicitly not
results. So the design space has exactly one member: **re-execution** — re-issue the recorded inputs
against live code and current state, and compare what comes back.

That is also what the ticket actually asks for. Reconstruction would answer "did the orchestration
behave deterministically"; re-execution answers "did the server's behaviour move", which is the
question a debugging or regression use has.

**The command is therefore named `rerun`, not `replay`.** A reader who knows the industry term will
expect stubs and determinism from `replay`, and will not get them.

## Decisions

| decision | value |
|---|---|
| purpose | debugging first, but the per-call output is structured and comparable from day one so a later regression harness needs no redesign |
| surface | CLI command; the runner is a library function so a tool wrapper stays cheap |
| mutating calls | observe mode by default, `--sandbox` opt-in for full fidelity |
| degraded records | hard refusals — no `--allow-degraded` escape hatch |

### Why CLI and not an MCP tool

Captured arguments never reach a client by design, so an MCP tool would be a client triggering a
re-run over data that client may not see. Adding a tool also moves eight gates (CLAUDE.md, *Adding a
tool moves eight things*) — count constants, facade domain map, `boot.tools_registered`, two docs
gates, docgen marker regions, plus `pathAcl` and `vaultArg` since a re-run mutates and takes a
vault. That is a large tax for a surface only an operator uses, and a CLI is what a future CI
regression job wants anyway.

## Architecture

`rerunSession()` lives in `packages/server/src/workspace/`, beside `sessions.ts`, which already owns
`readTrace` and `resolveTracePath`. `packages/server/src/cli/commands/rerun.ts` is a thin wrapper
following the existing `run_*` pattern and owns argument parsing only.

Flow:

1. Look up the session row by id → `trace_path` + `trace_store`.
2. Resolve through the existing `resolveTracePath` (`sessions.ts:80`, *"the ONE place a stored
   `trace_path` becomes an absolute path"*), so pre-THE-737 rows with `trace_store = 'vault'` still
   resolve.
3. `readTrace(abs)` → records; keep `type === "tool_invocation"`, ordered by `ts`.
4. Assign each record a verdict (below). Only `runnable` records are dispatched.
5. Re-issue each runnable record's `args` through the same `runDispatch` a live call takes.

Command signature:

```
obsidian-tc rerun <session-id> [--vault <vault-id>] [--sandbox] [--json]
```

`--vault` is optional; the session row already carries `vault_id`, and the flag exists only to make
an operator's intent explicit and to fail loudly on a mismatch rather than re-running against a vault
they did not mean. `--json` emits the per-record array below instead of the human summary, which is
the form a later regression harness consumes.

`rawInput` reaching `recordOutcome` is the **pre-Zod client payload** (`dispatch.ts:95` → `:131`),
not the parsed one. So a re-issued call traverses the identical validate → auth → scope/ACL → HITL →
execute pipeline. A re-run that passes is evidence about the real gates, not about a shortcut.

## Observe mode is an ACL, not a classifier

Dispatch already refuses mutating calls against a read-only ACL — `mcp/registry/policy-gates.ts:132-135`:

```ts
/** A mutating call is refused outright against a read-only ACL (acl.readOnly). */
if (mutating && ctx.acl?.readOnly)
  throw new ObsidianTcError("forbidden", "vault is read-only (acl.readOnly)");
```

with `isMutating` at `:56` being the same `destructive === true || requiredScopes.some(isMutatingScope)`
predicate the facade (`mcp/facade.ts:181`) and visibility (`mcp/visibility.ts:53`) layers use. A
second, independent layer sits at `vault/acl-path.ts:44`, which denies any non-`read` path op under
`acl.readOnly`.

**So observe mode is `ctx.acl.readOnly = true`, and the runner classifies nothing.** A runner-side
"is this tool mutating" list would be a second copy of a rule that already exists, and the two can
disagree — which is how a re-run eventually executes a write it believed was a read. One derivation,
not two; the same principle THE-645 item 2 applied when `visibilityOf` was made to delegate to
`explainVisibility`.

Mutating calls come back as `forbidden`, which the runner records as a skip. The verdict is the
existing gate's ruling, not a prediction of it.

### The trap: `aclResolver` silently defeats this

`CallerContext.aclResolver`'s own docstring (`mcp/registry/types.ts:288-290`):

> THE-295 per-vault ACL resolver. When the parsed input names a vault, dispatch **swaps `ctx.acl`**
> to that vault's ACL (root ACL = inherited default) so the readOnly gate and every handler-side
> `enforcePathAcl` run under the right vault's rules.

A runner that sets `acl.readOnly = true` **and** wires the normal `aclResolver` has its read-only ACL
overwritten mid-dispatch by the vault's real one. Observe mode then silently becomes read-write, and
the report still says `skipped_mutating: 0` — which reads as "this session had no writes" rather
than "the guard was bypassed."

**In observe mode the runner must either omit `aclResolver` or wire one that returns a read-only ACL
for every vault.** This is the single most dangerous line in the implementation, and it is why test 4
below is load-bearing rather than ceremonial.

## Refusal taxonomy

Every record resolves to exactly one verdict before anything is dispatched.

| verdict | condition | why it cannot proceed |
|---|---|---|
| `runnable` | `args` present **and** `args_scan === "clean"` | the only faithful case |
| `no_capture` | `args` field absent | capture was off for this record. Distinct from empty args — dispatching `{}` is a valid-looking call that is wrong |
| `redacted` | `args_scan` matches `redacted:<n>` | `[REDACTED]` is substituted *into the argument text*; re-issuing writes that literal into a note |
| `truncated` | `args_scan === "truncated"` | JSON cut at the `maxTraceArgsBytes` cap (default 4096, `dispatch-observability.ts:131`) — unparseable, and repairing it would be invention |
| `skipped_mutating` | dispatch returned `forbidden` under the read-only ACL | the gate's verdict, recorded — not a pre-filter |
| `unparseable` | `JSON.parse(args)` threw | a torn line that survived `readTrace`'s per-line skip |

`redacted` and `truncated` are **hard refusals with no override flag.** An `--allow-degraded` escape
would be reached for exactly when someone is under time pressure, which is when re-issuing a
mutating call with `[REDACTED]` in its body does the most damage.

`no_capture` is the universal case on the current deployment. Its message must name the config key
(`sessions.traceContent`) and say capture was off *when the session was recorded* — otherwise "0 of
47 calls runnable" reads as a broken runner.

## Output and exit codes

Per record:

```
{ seq, ts, tool, caller, verdict,
  recorded: { status, result_size, duration_ms, error_code? },
  replayed: { status, result_size, duration_ms, error_code? } | null,
  divergence: "none" | "status" | "error_code" }
```

**The comparison is deliberately narrow.** Divergence means `status` or `error_code` moved.
`result_size` is reported as a delta but never fails on its own: a note legitimately edited since
recording changes byte counts, so treating size as an assertion produces failures that mean nothing
and train the reader to ignore the report. Stating plainly that the oracle is `status`-only is more
useful than dressing `result_size` up as one.

Exit codes:

| code | meaning |
|---|---|
| `0` | ran, ≥1 runnable, no divergence |
| `1` | ran, ≥1 runnable, divergence found — the regression signal |
| `2` | **nothing was runnable** |

Precedence, evaluated in this order: if `runnable == 0` the code is `2` regardless of anything else;
otherwise `1` if any record diverged; otherwise `0`. A run with both refusals and divergences exits
`1` — refusals of *some* records are the expected steady state, and only a total refusal is the
vacuity signal `2` exists to carry.

`2` existing as its own code is the point. The happy path and the total-refusal path both terminate
without errors, and on today's deployment the total-refusal path is the only reachable one. Without
a distinct code, "everything was refused" and "everything passed" are the same observable outcome —
the failure-encoded-as-a-valid-result shape. The summary leads with `runnable: N` for the same
reason.

## Sandbox mode

`--sandbox` copies the vault **plus `cache.db` and `experiential.db`** to a temp directory, runs with
a normal read-write ACL, and discards afterwards.

Copying the databases is not optional. Without them the index is empty and every `search` diverges
for a reason unrelated to the change being investigated. **Copy, never symlink** — a symlinked DB is
the live one.

`examples/scratch-vault/` is *not* the sandbox target. It holds three notes in total — `README.md`,
`Welcome.md` and `00-example/Example Note.md` — and exists for contributor onboarding; a session
recorded against a real vault diverges on its first `read_note` against it. THE-645's note that
scratch-vault "makes that option cheaper" is true of its existence and not of its usefulness here.

## Testing

1. **Each verdict for its own condition** — six cases.
2. **Vacuity guard** — an all-`no_capture` trace exits `2`, not `0`.
3. **Observe mode asserts the effect, not the report** — record a session containing a `patch_note`,
   re-run it, then assert *the note on disk is unchanged*. Asserting `verdict === "skipped_mutating"`
   only proves the runner printed the right word; the report and the behaviour are independent.
4. **Mutation** — remove the read-only guard (or wire the normal `aclResolver`) and confirm test 3
   goes red. A safety property whose test has never been watched failing is an assertion about
   intent. This is the test that catches the `aclResolver` trap above.
5. **Degraded records reach no dispatch at all** — assert via a dispatch spy, so "it didn't write"
   cannot pass because the write happened to fail for an unrelated reason.

## Non-goals

- **Reconstruction / stubbed replay.** Impossible without captured results; see above.
- **Enabling `sessions.traceContent`.** That flag's flip is an operator decision still gated on the
  THE-238 red-team. This design consumes the capture; it does not turn it on.
- **Capturing results.** A separate capture-posture decision, larger exposure, nobody has needed it.
- **An MCP tool surface.** Deferred, cheap to add later because the runner is a library function.
- **`result_size` as a pass/fail oracle.** Reported, never asserted.

## Follow-up filed separately

`ToolAnnotations.idempotentHint` is not emitted anywhere in the tree (0 hits). `mcp/server.ts:214-217`
sets `readOnlyHint`, `destructiveHint` and `openWorldHint` but omits the fourth. It is advisory only —
the MCP spec is explicit that annotations are untrusted hints and not authorization constructs, and
obsidian-tc correctly enforces on `requiredScopes`/`destructive` — but it is the annotation most
relevant to whether a recorded write is safe to re-issue, so it is worth reporting. Unrelated to this
ticket; its own issue.
