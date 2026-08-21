# Workspace Rerun

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## File header — naming and mutation-safety design

**"Rerun", not "replay".** The prevailing meaning of "replay" in agent tooling is to walk the
control flow again substituting stored results, so nothing executes. That is impossible here, and
not by oversight: THE-736 captured arguments and deliberately not results. The only available shape
is to re-issue the inputs and compare what comes back, which is also what the ticket asks for.
Hence `rerun`, not `replay`.

**Mutation safety is not implemented in this file.** Observe mode hands dispatch a read-only ACL
and the existing `enforceReadOnlyGate` (`mcp/registry/policy-gates.ts`) refuses every mutating
call, using the same `isMutating` predicate the facade and visibility layers use. A runner-side "is
this tool mutating" list would be a second copy of that rule, and the two could disagree — which is
how a rerun eventually executes a write it believed was a read.

That gate covers the `write`/`delete`/`bulk`/`execute` families and not `admin`, because
`MUTATING_FAMILIES` (`shared/src/scopes.ts`) omits it deliberately, since it is the whole server's
definition of a vault mutation. An `admin:` call is refused here instead by not granting the scope
at all (see `RERUN_SCOPES`); widening `MUTATING_FAMILIES` to close it would change behaviour far
beyond this command.

**Deviation from the brief, measured.** The brief's draft granted only `["read:notes",
"read:workspace"]` and left `ctx.acl` unset. Running it (not just reading it) against
`makeTestVault` showed the "mutating skip" was coming from `assertScopesGranted` (missing
`write:notes`), not from `enforceReadOnlyGate` — `dispatch.ts:191` runs the scope gate before
`applyVaultAcl`/`enforceReadOnlyGate` (`:197`/`:200`). Proof: flipping the fixture's ACL to writable
(Step 5) did not change the outcome — `patch_note` was still refused, for the same scope reason,
with a writable vault. That is a false safety signal: the test would report the guarantee held
while never exercising the ACL gate at all.

So this runner grants a family-level scope set (read/write/delete/bulk/execute, deliberately not
`admin` — see `RERUN_SCOPES`) and instead supplies `ctx.acl` itself, read-only unless `sandbox`.
This does not reintroduce the per-tool classifier the design doc warns against (`isMutatingCall`'s
`destructive || requiredScopes.some(isMutatingScope)` predicate is still the only thing deciding
which calls are mutating); it only supplies the ACL value, exactly as `withReadOnlyAcl` will for the
CLI's own registry (Task 4) once that registry's `aclResolver` is wired. `makeTestVault`'s registry
has no `aclResolver` (`m1-helpers.ts:75`), so nothing overwrites this — that omission is deliberate
in the fixture, not an oversight this runner should route around.

**Consequence for the mutation test, also measured.** Observe mode is now unconditional —
read-only regardless of the target vault's own configured ACL, matching the design doc's stated
goal that Task 4's `withReadOnlyAcl` must force every vault read-only, not merely honor one that
already happens to be. So flipping the test fixture's `acl: {readOnly}` (the brief's literal
Step 5) has no effect here — verified, not assumed: it still reports 6/6 green. The lever that
actually gates the write is this file's `readOnly: true` literal in `rerunSession`, so that is what
`task-3-report.md`'s mutation cycle flips instead, and watches go red with the note actually
overwritten on disk before restoring it.

## `RERUN_SCOPES`

The previous grant was `["*"]`, justified by "the original call already cleared scope/auth once
when it was recorded." That is false: `recordOutcome` (`mcp/registry/dispatch-observability.ts`)
traces failed dispatches too, arguments included — so a record whose `recorded.status` is `error`
with `error_code: "forbidden"` was in the trace precisely because its caller was denied, and
`["*"]` re-issued it with privileges the original caller never held.

Omitting `admin` also closes `add_vault`, which declares no `vaultArg` and so slips past the
vault-binding guard: under `["*"]` it registered an operator-supplied real path into the live
`VaultRegistry` and indexed it, from the mode that advertises it refuses every mutating call.

## `vaultRootFor` (`RerunOptions`)

Required, and that is the fix rather than a style choice. It used to be optional with a `?? ""`
default, which only `--sandbox` ever supplied: a legacy `trace_store = 'vault'` row (the
`DEFAULT 'vault'` backfill of migration `20260805_003` — i.e. every row predating THE-737) then
resolved its trace against `resolve("")` = `process.cwd()`, found nothing, and reported
`no_capture` for the whole session while blaming `sessions.traceContent`. A required resolver makes
that silent misattribution unrepresentable.

## `rerunSession` — caller attribution (THE-740)

Every re-issued call goes through the real dispatch — which is the point, since a rerun that passes
is evidence about the actual gates — and `recordOutcome` therefore writes an `event_log` row for
each one, into the real `cache.db` in observe mode.

Before the `rerun:` prefix, rows were attributed to the raw `row.caller` and were
byte-indistinguishable from live traffic by a principal who did not make the calls: audit history
gained synthetic entries, per-caller volume double-counted a replayed session, and a rerun of a
session containing a denial re-recorded that denial against the original caller.

The prefix keeps the original principal legible (`rerun:alice` still says alice) while making the
rows excludable from any analysis over `event_log`, needs no migration, and makes the rows
filterable with a `LIKE`. A null caller becomes `rerun:` rather than staying null, so a synthetic
row is never indistinguishable from an unattributed real one. This repo already treats audit
integrity as load-bearing (the forget log is hash-chained; THE-605 reasons explicitly about which
commands may write audit rows), and synthesising indistinguishable rows was never part of that
reasoning.

## `rerunSession` — vault binding

The session's vault is the only vault this run may touch, and `vaultBound: true` is what makes that
structural rather than documented. `enforceVaultBinding` (`mcp/registry/input-binding.ts`) returns
immediately unless `vaultBound === true`; without it, a handler resolved its target from
`input.vault` via `VaultRegistry.resolve`, so a record whose captured args named a different vault
was executed against that vault — under `--sandbox` that is a real, unstaged vault being mutated
while the command exits 0 ("ran, nothing moved") and the staged copy sits untouched. Set in both
modes: a mismatched record is refused outright rather than silently retargeted.

## `rerunSession` — `ctx.acl`

Read-only unless `--sandbox`. `aclResolver` (`mcp/registry/types.ts:257/:290`) is fixed at
`ToolRegistry` construction and, when wired, `applyVaultAcl` (`dispatch.ts:197`,
`input-binding.ts:88`) replaces this on every call naming a vault — so in the CLI's own registry
(Task 4, `withReadOnlyAcl`) this value is redundant, not load-bearing. It is load-bearing here and
in `makeTestVault`'s registry, which wires no `aclResolver` (`m1-helpers.ts:75`) and so never
overwrites it.

## `rerunSession` — the read-only skip (`skipped_mutating`)

Dispatch refuses a mutating call under a read-only ACL with `forbidden`. That is the gate's ruling,
recorded, not a prediction this runner made. The match is on the gate, not the code: `forbidden` is
also what the scope gate, the vault-binding guard, the vault-kind gate, and the path ACL throw.
Folding all of them into `skipped_mutating` reported a genuine regression — a call recorded `ok`
that now comes back `forbidden` because an ACL rule, a vault kind, or a scope changed — as an
expected skip: it counted toward neither `diverged` nor the exit code, which is the one thing this
command exists to surface. Only the read-only gate's own message (`READ_ONLY_DENIAL_MESSAGE`,
imported so it cannot drift) is treated as a skip; every other `forbidden` falls through and is
compared like any other outcome.

## `rerunSession` — refusals caused by this runner, not by the vault (THE-738)

`plugin_unreachable` is the sandbox stripping `restApiUrl`/`restApiKey` so bridge tools cannot reach
the live Obsidian app — correct, and the only safe answer, since a filesystem copy cannot bound a
network write. But the strip is wholesale, so `openBridge` throws it for every m4 tool including the
read-only ones (`list_tasks`, `git_status`, `git_diff`, `eval_dataview_field`, `ocr_attachment`,
`search_omnisearch`, ...). Each was recorded `ok`, now returns an error, and so would be reported as
diverged without this check.

The scope case is the same shape in observe mode: an `admin:` call is refused because `RERUN_SCOPES`
deliberately omits that family. This is exactly the class the design doc names — "every search
diverges for a reason unrelated to the change being investigated" — arriving through a different
door. Both are folded into the `refused_by_policy` verdict rather than counted as divergence.

## `stageDatabase` (THE-739)

`cpSync` was the original implementation, and it was wrong quietly. Every adapter sets `PRAGMA
journal_mode = WAL`, so a live database's recent writes sit in a `-wal` sidecar that a file copy
does not take. In production, `serve` holds a connection, so nothing checkpoints it. The staged
copy therefore lagged the real one by whatever was uncheckpointed, and could tear under a
concurrent writer.

The failure read as something else entirely: `rerun <id> --sandbox` on a session that just ended
found the row in the real `cache.db`, staged a copy, and then threw `unknown session` against the
staged copy — because the row was still in the WAL. That looked like a corrupt session id, not a
staging defect.

`VACUUM INTO` is SQLite's own consistent-snapshot primitive: one statement, checkpoints implicitly,
and writes a single self-contained file with no sidecars to keep in sync. Preferred over copying the
`-wal`/`-shm` alongside (still racy under a concurrent writer) and over the backup API (more code
for the same guarantee). Falls back to `cpSync` when the source will not open as a database — a
truncated or non-SQLite file staged for a test fixture must not abort the whole run, and copying it
preserves the previous behaviour exactly for that case.

## `safeDispose`

`dispose()` runs in `cli/commands/rerun.ts`'s outermost `finally`, so a throw here would escape into
`main()`'s `.catch()`, which writes `fatal: ...` and exits 1 — turning "I could not delete a scratch
dir" into "your vault state changed." This command's exit code is its entire output (0 = nothing
moved, 1 = divergence found, 2 = nothing was runnable), so a cleanup failure must never corrupt it.
A leaked temp dir is a nuisance; a corrupted exit code is a lie.

`maxRetries`/`retryDelay` are `fs.rmSync`'s own answer to the Windows `EBUSY`/`EPERM`/`ENOTEMPTY`
that removing a directory can raise immediately after a file inside it (here: the staged `cache.db`)
was closed — the OS can take a beat to actually release the handle even after the runtime has
awaited `close()`. 5 retries at 100ms apart is enough slack to absorb that without stalling a normal
run noticeably. `force: true` alone (the previous behaviour) only suppresses `ENOENT` and does
nothing for `EBUSY`/`EPERM`.

## `stageSandbox`

Fix round 1, finding 2: a mid-copy failure (e.g. the vault disappearing underneath us, a full disk)
must not leave the staged temp dir behind — nothing downstream would ever call `dispose()` for a
staging call that never returned. Every throwing path from `stageSandbox` cleans up before
rethrowing, and the original error `e` — the reason staging failed — is what propagates, since
`safeDispose` never throws (see above), not whatever `rmSync` ran into while cleaning up after it.

THE-737: a session minted today writes `trace_store='cache'` — its JSONL lives under
`<cacheDir>/traces/`, not under the vault. Skipping the traces copy would make `--sandbox` find
`no_capture` for every record on the only generation of session anything writes now (nothing
constructs `trace_store='vault'` any more; see `sessions.ts`'s own comment on the column), which
defeats the command as thoroughly as staging into the real vault would — just as a silent false
negative instead of an unsafe write.
