// THE-645 item 3 — re-issue a recorded session's captured arguments against current vault state.
//
// RE-EXECUTION, not reconstruction. The prevailing meaning of "replay" in agent tooling is to walk
// the control flow again substituting STORED RESULTS, so nothing executes. That is impossible here
// and not by oversight: THE-736 captured arguments and deliberately not results. So the only
// available shape is to re-issue the inputs and compare what comes back — which is also what the
// ticket asks for. Hence `rerun`, not `replay`.
//
// MUTATION SAFETY IS NOT IMPLEMENTED HERE. Observe mode hands dispatch a read-only ACL and the
// existing `enforceReadOnlyGate` (mcp/registry/policy-gates.ts) refuses every mutating call, using
// the same `isMutating` predicate the facade and visibility layers use. A runner-side "is this tool
// mutating" list would be a SECOND copy of that rule, and the two can disagree — which is how a
// re-run eventually executes a write it believed was a read.
//
// That gate covers the `write`/`delete`/`bulk`/`execute` families and NOT `admin`, because
// `MUTATING_FAMILIES` (shared/src/scopes.ts) omits it — deliberately, since it is the whole
// server's definition of a vault mutation. So an `admin:` call is refused HERE by not granting the
// scope at all (see RERUN_SCOPES); widening MUTATING_FAMILIES to close it would change behaviour
// far beyond this command.
//
// DEVIATION FROM THE BRIEF, MEASURED: the brief's draft granted only `["read:notes",
// "read:workspace"]` and left `ctx.acl` unset. Running it (not just reading it) against
// `makeTestVault` showed the "mutating skip" was coming from `assertScopesGranted` (missing
// `write:notes`), NOT from `enforceReadOnlyGate` — dispatch.ts:191 runs the scope gate BEFORE
// `applyVaultAcl`/`enforceReadOnlyGate` (:197/:200). Proof: flipping the fixture's ACL to writable
// (Step 5) did NOT change the outcome — patch_note was still refused, for the same scope reason,
// with a WRITABLE vault. That is a false safety signal: the test would report the guarantee held
// while never exercising the ACL gate at all.
//
// So this runner grants a FAMILY-LEVEL scope set (read/write/delete/bulk/execute, deliberately NOT
// admin — see RERUN_SCOPES) and instead supplies `ctx.acl` itself, read-only
// unless `sandbox`. This does NOT reintroduce the per-tool classifier the design doc warns against
// (`isMutatingCall`'s `destructive || requiredScopes.some(isMutatingScope)` predicate is still the
// ONLY thing deciding which calls are mutating); it only supplies the ACL VALUE, exactly as
// `withReadOnlyAcl` will for the CLI's own registry (Task 4) once that registry's `aclResolver` is
// wired. `makeTestVault`'s registry has no `aclResolver` (m1-helpers.ts:75), so nothing overwrites
// this — that omission is deliberate in the fixture, not an oversight this runner should route
// around.
//
// CONSEQUENCE FOR THE MUTATION TEST, also measured: observe mode is now unconditional — read-only
// regardless of the TARGET VAULT's own configured ACL, matching the design doc's stated goal that
// Task 4's `withReadOnlyAcl` must force every vault read-only, not merely honor one that already
// happens to be. So flipping the test fixture's `acl: {readOnly}` (the brief's literal Step 5) has
// NO effect here — verified, not assumed: it still reports 6/6 green. The lever that actually
// gates the write is THIS file's `readOnly: true` literal a few lines below, so that is what
// task-3-report.md's mutation cycle flips instead, and watches go red with the note actually
// overwritten on disk before restoring it.
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderAcl } from "../acl";
import type { Database } from "../db/types";
import type { ToolRegistry } from "../mcp/registry";
import { READ_ONLY_DENIAL_MESSAGE } from "../mcp/registry/policy-gates";
import {
  classifyRecord,
  type RerunRecord,
  type RerunSummary,
  summarizeRerun,
} from "./rerun-verdict";
import { CACHE_TRACE_SUBDIR, getSession, readTrace, resolveTraceAbs } from "./sessions";

/**
 * The scopes a re-issued call is authenticated with.
 *
 * FAMILY WILDCARDS, and `admin` is absent on purpose. `grantsScope` (shared/src/scopes.ts) matches
 * `read:*` against any `read:<resource>`, so this covers every non-admin tool without enumerating
 * resources — while `admin:*` calls fail at `assertScopesGranted` in BOTH modes.
 *
 * The previous `["*"]` was justified by "the ORIGINAL call already cleared scope/auth once when it
 * was recorded". THAT IS FALSE: `recordOutcome` (mcp/registry/dispatch-observability.ts) traces
 * FAILED dispatches too, arguments included — so a record whose `recorded.status` is `error` with
 * `error_code: "forbidden"` was in the trace precisely BECAUSE its caller was denied, and `["*"]`
 * re-issued it with privileges the original caller never held. Omitting `admin` also closes
 * `add_vault`, which declares no `vaultArg` and so slips past the vault-binding guard below: under
 * `["*"]` it registered an operator-supplied REAL path into the live VaultRegistry and indexed it,
 * from the mode that advertises it refuses every mutating call.
 */
export const RERUN_SCOPES: readonly string[] = [
  "read:*",
  "write:*",
  "delete:*",
  "bulk:*",
  "execute:*",
];

export interface RerunOptions {
  db: Database;
  registry: ToolRegistry;
  sessionId: string;
  cacheDir: string;
  /**
   * Absolute filesystem root of the session's OWN vault, resolved from `row.vault_id` — so it is a
   * function, called after the row is read rather than a value the caller must pre-compute.
   *
   * REQUIRED, and that is the fix rather than a style choice. It used to be optional with a
   * `?? ""` default, which only `--sandbox` ever supplied: a legacy `trace_store = 'vault'` row
   * (the `DEFAULT 'vault'` backfill of migration 20260805_003 — i.e. every row predating THE-737)
   * then resolved its trace against `resolve("")` = process.cwd(), found nothing, and reported
   * `no_capture` for the whole session while blaming `sessions.traceContent`. A required resolver
   * makes that silent misattribution unrepresentable.
   */
  vaultRootFor: (vaultId: string) => string;
  /** When true, this runner leaves `ctx.acl` unset (the copied sandbox vault's normal read-write
   *  access governs, via whatever `aclResolver` the caller's registry carries) and a `forbidden`
   *  result is reported as a genuine divergence rather than folded into `skipped_mutating`. When
   *  false (observe mode, the default), this runner supplies a read-only `ctx.acl` itself — see
   *  the file header for why that is load-bearing against `makeTestVault`'s registry, which wires
   *  no `aclResolver`. */
  sandbox?: boolean;
  /** `--vault`. Checked against the session row and thrown on mismatch — the flag exists to fail
   *  loudly rather than let an operator re-run against a vault they did not mean. */
  expectVaultId?: string;
}

export interface RerunResult {
  records: RerunRecord[];
  summary: RerunSummary;
}

/** A dispatch result, narrowed to what a re-run compares. `message` is read only to tell the
 *  read-only gate's `forbidden` apart from every other one — see the classification below. */
interface DispatchLike {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

export async function rerunSession(opts: RerunOptions): Promise<RerunResult> {
  const row = getSession(opts.db, opts.sessionId);
  // An unknown id must throw. Returning an empty successful run would report "0 calls, all fine"
  // for a session that does not exist — a failure encoded as a valid result.
  if (!row) throw new Error(`unknown session: ${opts.sessionId}`);
  // `--vault` is a guard, not a selector: the row already knows its vault. A mismatch means the
  // operator believes they are re-running something they are not.
  if (opts.expectVaultId !== undefined && opts.expectVaultId !== row.vault_id)
    throw new Error(
      `session ${opts.sessionId} belongs to vault ${row.vault_id}, not ${opts.expectVaultId}`,
    );

  const abs = resolveTraceAbs({
    store: row.trace_store,
    tracePath: row.trace_path,
    cacheDir: opts.cacheDir,
    vaultRoot: opts.vaultRootFor(row.vault_id),
  });

  const invocations = readTrace(abs)
    .filter((r) => r.type === "tool_invocation" && typeof r.tool === "string")
    .sort((a, b) => a.ts - b.ts);

  const records: RerunRecord[] = [];
  for (const [seq, rec] of invocations.entries()) {
    const classified = classifyRecord(rec);
    const recorded = {
      status: rec.status as string | undefined,
      result_size: rec.result_size,
      duration_ms: rec.duration_ms,
      ...(rec.error_code ? { error_code: rec.error_code as string } : {}),
    };
    const common = {
      seq,
      ts: rec.ts,
      tool: rec.tool as string,
      caller: (rec.caller as string | null) ?? null,
      recorded,
    };

    if (classified.verdict !== "runnable" || classified.args === null) {
      records.push({
        ...common,
        verdict: classified.verdict,
        reason: classified.reason,
        replayed: null,
        divergence: "none",
      });
      continue;
    }

    const started = Date.now();
    const res = (await opts.registry.dispatch(common.tool, classified.args, {
      caller: row.caller,
      authenticated: true,
      // Family wildcards minus `admin` — see RERUN_SCOPES for why "the original call already
      // cleared scope/auth" was not true and what `["*"]` let through.
      grantedScopes: new Set(RERUN_SCOPES),
      vaultId: row.vault_id,
      // THE SESSION'S VAULT IS THE ONLY VAULT THIS RUN MAY TOUCH, and this is what makes that
      // structural rather than documented. `enforceVaultBinding` (mcp/registry/input-binding.ts)
      // returns immediately unless `vaultBound === true`; without it, a handler resolved its target
      // from `input.vault` via `VaultRegistry.resolve`, so a record whose captured args named a
      // DIFFERENT vault was executed against that vault — under `--sandbox` that is a real,
      // unstaged vault being mutated while the command exits 0 ("ran, nothing moved") and the
      // staged copy sits untouched. Set in BOTH modes: a mismatched record is refused outright
      // rather than silently retargeted.
      vaultBound: true,
      db: opts.db,
      // Read-only unless `--sandbox`. `aclResolver` (mcp/registry/types.ts:257/:290) is fixed at
      // ToolRegistry construction and, when wired, `applyVaultAcl` (dispatch.ts:197,
      // input-binding.ts:88) REPLACES this on every call naming a vault — so in the CLI's own
      // registry (Task 4, `withReadOnlyAcl`) this value is redundant, not load-bearing. It IS
      // load-bearing here and in `makeTestVault`'s registry, which wires no `aclResolver`
      // (m1-helpers.ts:75) and so never overwrites it.
      acl: opts.sandbox
        ? undefined
        : new FolderAcl({ readOnly: true, defaultScopes: [], rules: [] }),
    } as never)) as DispatchLike;

    const code = res.error?.code;
    // Dispatch refuses a mutating call under a read-only ACL with `forbidden`. That is the gate's
    // ruling, recorded — not a prediction this runner made.
    //
    // MATCHED ON THE GATE, NOT ON THE CODE. `forbidden` is also what the scope gate, the
    // vault-binding guard, the vault-kind gate and the path ACL throw. Folding all of them into
    // `skipped_mutating` reported a genuine regression — a call recorded `ok` that now comes back
    // `forbidden` because an ACL rule, a vault kind or a scope changed — as an EXPECTED skip: it
    // counted toward neither `diverged` nor the exit code, which is the one thing this command
    // exists to surface. Only the read-only gate's own message (imported, so it cannot drift) is a
    // skip; every other `forbidden` falls through and is compared like any other outcome.
    const readOnlySkip = res.error?.message === READ_ONLY_DENIAL_MESSAGE;
    if (!opts.sandbox && !res.ok && code === "forbidden" && readOnlySkip) {
      records.push({
        ...common,
        verdict: "skipped_mutating",
        reason: "mutating call refused by the read-only ACL (observe mode)",
        replayed: null,
        divergence: "none",
      });
      continue;
    }

    const replayed = {
      status: res.ok ? "ok" : "error",
      result_size: JSON.stringify(res.data ?? null).length,
      duration_ms: Date.now() - started,
      ...(code ? { error_code: code } : {}),
    };
    // Deliberately narrow. `result_size` is REPORTED but never asserted: a note legitimately
    // edited since recording changes byte counts, so failing on size produces failures that mean
    // nothing and train the reader to ignore the report.
    const divergence =
      replayed.status !== (recorded.status ?? "ok")
        ? "status"
        : (recorded.error_code ?? "") !== (code ?? "")
          ? "error_code"
          : "none";

    records.push({
      ...common,
      verdict: "runnable",
      reason: "",
      replayed,
      divergence,
    });
  }

  return { records, summary: summarizeRerun(records) };
}

/** Databases copied alongside the vault. Without them the sandbox index is EMPTY and every search
 *  diverges for a reason unrelated to the change being investigated. */
const SANDBOX_DBS = ["cache.db", "experiential.db"] as const;

/** Best-effort removal of a staged sandbox directory. NEVER THROWS: `dispose()` runs in
 *  `cli/commands/rerun.ts`'s outermost `finally`, so a throw here would escape into `main()`'s
 *  `.catch()`, which writes `fatal: ...` and exits 1 — turning "I could not delete a scratch dir"
 *  into "your vault state changed". THIS COMMAND'S EXIT CODE IS ITS ENTIRE OUTPUT (0 = nothing
 *  moved, 1 = divergence found, 2 = nothing was runnable), so a cleanup failure must never corrupt
 *  it. A leaked temp dir is a nuisance; a corrupted exit code is a lie. On a failure that survives
 *  the retries below, this warns to stderr (naming the path, so the operator can clean it up) and
 *  carries on instead of throwing.
 *
 *  `maxRetries`/`retryDelay` are `fs.rmSync`'s own answer to the Windows EBUSY/EPERM/ENOTEMPTY that
 *  removing a directory can raise immediately after a file inside it (here: the staged cache.db)
 *  was closed — the OS can take a beat to actually release the handle even after the runtime has
 *  awaited `close()`. 5 retries at 100ms apart is enough slack to absorb that without stalling a
 *  normal run noticeably. `force: true` alone (the previous behaviour) only suppresses ENOENT and
 *  does nothing for EBUSY/EPERM. */
function safeDispose(base: string): void {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (e) {
    process.stderr.write(
      `rerun: warning: failed to remove staged sandbox directory ${base}: ${(e as Error).message}\n`,
    );
  }
}

/**
 * Stage a disposable copy of a vault and its databases.
 *
 * COPY, never symlink — a symlinked database is the live one, and the whole guarantee of sandbox
 * mode is that everything it touches is throwaway.
 */
export function stageSandbox(
  vaultRoot: string,
  cacheDir: string,
): { root: string; cacheDir: string; dispose(): void } {
  const base = mkdtempSync(join(tmpdir(), "obtc-rerun-"));
  // Fix round 1, finding 2: a mid-copy failure (e.g. the vault disappearing underneath us, a full
  // disk) must not leave `base` behind — nothing downstream would ever call `dispose()` for a
  // staging call that never returned. Every throwing path from here on cleans up before
  // rethrowing.
  try {
    const root = join(base, "vault");
    const cache = join(base, "cache");
    cpSync(vaultRoot, root, { recursive: true, dereference: true });
    for (const name of SANDBOX_DBS) {
      const src = join(cacheDir, name);
      if (existsSync(src)) cpSync(src, join(cache, name), { dereference: true });
    }
    // THE-737: a session minted today writes trace_store='cache' — its JSONL lives under
    // <cacheDir>/traces/, not under the vault. Skipping this copy would make --sandbox find
    // `no_capture` for every record on the ONLY generation of session anything writes now
    // (nothing constructs trace_store='vault' any more; see sessions.ts's own comment on the
    // column), which defeats the command as thoroughly as staging into the real vault would —
    // just as a silent false negative instead of an unsafe write.
    const tracesSrc = join(cacheDir, CACHE_TRACE_SUBDIR);
    if (existsSync(tracesSrc))
      cpSync(tracesSrc, join(cache, CACHE_TRACE_SUBDIR), { recursive: true, dereference: true });
    return {
      root,
      cacheDir: cache,
      dispose: () => safeDispose(base),
    };
  } catch (e) {
    // safeDispose never throws (see above), so the ORIGINAL error `e` — the reason staging
    // failed — is what propagates, not whatever rmSync ran into while cleaning up after it.
    safeDispose(base);
    throw e;
  }
}
