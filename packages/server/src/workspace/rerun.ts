// THE-645 item 3 — re-issue a recorded session's captured arguments against current vault state.
//
// RE-EXECUTION, not reconstruction. The prevailing meaning of "replay" in agent tooling is to walk
// the control flow again substituting STORED RESULTS, so nothing executes. That is impossible here
// and not by oversight: THE-736 captured arguments and deliberately not results. So the only
// available shape is to re-issue the inputs and compare what comes back — which is also what the
// ticket asks for. Hence `rerun`, not `replay`.
//
// MUTATION SAFETY IS NOT IMPLEMENTED HERE. Observe mode hands dispatch a read-only ACL and the
// existing gate at mcp/registry/policy-gates.ts:132-135 refuses every mutating call, using the same
// `isMutating` predicate the facade and visibility layers use. A runner-side "is this tool
// mutating" list would be a SECOND copy of that rule, and the two can disagree — which is how a
// re-run eventually executes a write it believed was a read.
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
// So this runner grants every scope (`["*"]`, matching how a re-issued call is authenticated — the
// original caller already passed scope/auth once) and instead supplies `ctx.acl` itself, read-only
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
import { classifyRecord, type RerunRecord, type RerunSummary, summarize } from "./rerun-verdict";
import { CACHE_TRACE_SUBDIR, getSession, readTrace, resolveTraceAbs } from "./sessions";

export interface RerunOptions {
  db: Database;
  registry: ToolRegistry;
  sessionId: string;
  cacheDir: string;
  /** Present only for `--sandbox`; observe mode never needs a vault root. */
  vaultRoot?: string;
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

/** A dispatch result, narrowed to what a re-run compares. */
interface DispatchLike {
  ok: boolean;
  data?: unknown;
  error?: { code?: string };
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
    vaultRoot: opts.vaultRoot ?? "",
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
      // Broad on purpose: the ORIGINAL call already cleared scope/auth once when it was recorded,
      // and the mutating/non-mutating line this runner must respect is the ACL gate below, not a
      // second scope allowlist here — a narrow set would block (or pass) calls for reasons that
      // have nothing to do with observe mode. See the file-header note for the measured failure
      // this replaced.
      grantedScopes: new Set(["*"]),
      vaultId: row.vault_id,
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
    if (!opts.sandbox && !res.ok && code === "forbidden") {
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

  return { records, summary: summarize(records) };
}

/** Databases copied alongside the vault. Without them the sandbox index is EMPTY and every search
 *  diverges for a reason unrelated to the change being investigated. */
const SANDBOX_DBS = ["cache.db", "experiential.db"] as const;

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
      dispose: () => rmSync(base, { recursive: true, force: true }),
    };
  } catch (e) {
    rmSync(base, { recursive: true, force: true });
    throw e;
  }
}
