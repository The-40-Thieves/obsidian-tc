// THE-645 item 3 — re-issue a recorded session's captured arguments against current vault state.
// This is re-execution, not replay: THE-736 captured arguments only, so there is nothing to
// substitute during a walk of the control flow. Hence `rerun`, not `replay`.
//
// Mutation safety is NOT implemented here — observe mode relies on `enforceReadOnlyGate`
// (mcp/registry/policy-gates.ts) and the shared `isMutating` predicate, not a second copy of that
// rule. That gate covers write/delete/bulk/execute; `admin` is refused instead by never granting
// the scope (see RERUN_SCOPES). See docs/design/workspace-rerun.md for the file-header history,
// including the measured deviation from the original brief and its consequence for the mutation
// test.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FolderAcl } from "../acl";
import { openDatabase } from "../db/open";
import type { Database } from "../db/types";
import { READ_ONLY_DENIAL_MESSAGE, type ToolRegistry } from "../mcp/registry";

import {
  classifyRecord,
  type RerunRecord,
  type RerunSummary,
  summarizeRerun,
} from "./rerun-verdict";
import { CACHE_TRACE_SUBDIR, getSession, readTrace, resolveTraceAbs } from "./sessions";

/**
 * THE-740 — the principal a re-issued call is attributed to in `event_log`.
 *
 * `rerun:` prefix rather than a new column, so synthetic rows stay distinguishable from live
 * traffic without a migration. See docs/design/workspace-rerun.md for why this is load-bearing.
 */
export const RERUN_CALLER_PREFIX = "rerun:";

export function rerunCaller(caller: string | null): string {
  return `${RERUN_CALLER_PREFIX}${caller ?? ""}`;
}

/**
 * The scopes a re-issued call is authenticated with.
 *
 * Family wildcards, and `admin` is absent on purpose. `grantsScope` (shared/src/scopes.ts) matches
 * `read:*` against any `read:<resource>`, so this covers every non-admin tool without enumerating
 * resources, while `admin:*` calls fail at `assertScopesGranted` in both modes. Do not widen this
 * to `["*"]` — see docs/design/workspace-rerun.md for why that under-grants the audit trail and
 * over-grants `add_vault`.
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
   * Required — an optional resolver silently mis-resolves legacy `trace_store = 'vault'` rows
   * (pre-THE-737) against the process cwd instead of the vault. See
   * docs/design/workspace-rerun.md for the failure this caused.
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
  /** `details.required` is the SCOPE GATE's own signal — `assertScopesGranted` is the only thing
   *  that attaches it (`err.forbidden(msg, { required })`). Matching on it rather than on the bare
   *  `forbidden` code is the same discipline `skipped_mutating` already follows: four different
   *  gates throw `forbidden`, and folding them together is what turned real regressions into
   *  expected skips. */
  error?: { code?: string; message?: string; details?: { required?: unknown } };
  /** THE-741: dispatch's idempotency gate stamps this on every replay path (ok, terminal-overflow,
   *  indeterminate) — the handler did NOT run. Read here so a cache hit reports
   *  `served_from_cache` instead of `runnable`, which would otherwise claim this re-run
   *  re-verified a call it never executed. */
  meta?: { idempotent_replay?: boolean };
}

/** True when a required scope falls outside what THIS RUNNER grants — i.e. the refusal is rerun's
 *  own policy, not the vault disagreeing. RERUN_SCOPES is family wildcards minus `admin`, so in
 *  practice this is the admin: family. Computed from the runner's own grant set rather than from a
 *  message, so it cannot drift when a gate's wording changes. */
function refusedByRerunScope(err: DispatchLike["error"]): boolean {
  const required = err?.details?.required;
  if (!Array.isArray(required)) return false;
  const families = new Set(RERUN_SCOPES.map((s) => s.split(":")[0]));
  return required.some((r) => typeof r === "string" && !families.has(r.split(":")[0] as string));
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
      // THE-740: every re-issued call goes through real dispatch, so `recordOutcome` writes an
      // `event_log` row for each one into the real cache.db in observe mode. `rerunCaller` prefixes
      // the original principal so these rows stay excludable/filterable rather than
      // byte-indistinguishable from live traffic. See docs/design/workspace-rerun.md.
      caller: rerunCaller(row.caller),
      authenticated: true,
      // Family wildcards minus `admin` — see RERUN_SCOPES.
      grantedScopes: new Set(RERUN_SCOPES),
      vaultId: row.vault_id,
      // The session's vault is the only vault this run may touch. `enforceVaultBinding`
      // (mcp/registry/input-binding.ts) returns immediately unless `vaultBound === true`; without
      // it, a record whose captured args named a different vault would execute against that vault
      // instead of being refused. Required in both modes. See docs/design/workspace-rerun.md.
      vaultBound: true,
      db: opts.db,
      // Read-only unless `--sandbox`. Redundant when a registry's `aclResolver` is wired (it
      // overwrites this per call — dispatch.ts:197), but load-bearing for `makeTestVault`'s
      // registry, which wires none (m1-helpers.ts:75). See docs/design/workspace-rerun.md.
      acl: opts.sandbox
        ? undefined
        : new FolderAcl({ readOnly: true, defaultScopes: [], rules: [] }),
    } as never)) as DispatchLike;

    const code = res.error?.code;
    // Dispatch refuses a mutating call under a read-only ACL with `forbidden`. That ruling is
    // recorded here, not predicted. Matched on the read-only gate's own message
    // (READ_ONLY_DENIAL_MESSAGE) rather than the bare `forbidden` code: the scope gate,
    // vault-binding guard, vault-kind gate, and path ACL all throw `forbidden` too, and folding
    // them together turns real regressions into expected skips. See docs/design/workspace-rerun.md.
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

    // THE-738: refusals this runner itself caused are not divergence. `plugin_unreachable` is the
    // sandbox correctly stripping the plugin bridge (a filesystem copy cannot bound a network
    // write), which also catches read-only m4 tools that never touched anything. The scope case is
    // an `admin:` call refused because RERUN_SCOPES omits that family. See
    // docs/design/workspace-rerun.md.
    if (!res.ok && (code === "plugin_unreachable" || refusedByRerunScope(res.error))) {
      records.push({
        ...common,
        verdict: "refused_by_policy",
        reason:
          code === "plugin_unreachable"
            ? "the sandbox stripped the plugin bridge, so this tool could not reach the Obsidian app — rerun's own refusal, not a vault change"
            : "this runner does not grant the scope this tool requires (RERUN_SCOPES omits admin) — rerun's own refusal, not a vault change",
        replayed: null,
        divergence: "none",
      });
      continue;
    }

    // THE-741: dispatch served this call from the idempotency cache instead of re-running the
    // handler — checked BEFORE the divergence comparison below, since that comparison assumes the
    // handler actually executed. Without this, a cached replay's `ok`/`error`/`error_code` (an
    // exact copy of the ORIGINAL call's outcome) always matches `recorded`, so `divergence` comes
    // back "none" and the record reports `runnable` — "ran, re-verified, nothing moved" — for a
    // call that ran nothing.
    if (res.meta?.idempotent_replay) {
      records.push({
        ...common,
        verdict: "served_from_cache",
        reason:
          "dispatch served this call from the idempotency cache — the handler did not run, so this is not a re-verification",
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

/**
 * THE-739 — stage one database as a consistent snapshot via `VACUUM INTO`, not `cpSync`.
 *
 * A plain file copy misses the `-wal` sidecar every adapter's `PRAGMA journal_mode = WAL` writes
 * to, so a copied database can lag or tear under a concurrent writer. `VACUUM INTO` checkpoints
 * implicitly and writes one self-contained file. Falls back to `cpSync` when the source will not
 * open as a database (e.g. a non-SQLite test fixture), preserving prior behaviour for that case.
 * See docs/design/workspace-rerun.md for the failure this fixes.
 */
async function stageDatabase(src: string, dest: string, busyTimeoutMs: number): Promise<void> {
  // `cpSync` creates missing parent directories; VACUUM INTO does NOT — it fails on a missing
  // path and would silently fall through to the copy below, reinstating the exact WAL-lag bug this
  // function exists to fix. Caught by the staging test, which is the point of asserting a row
  // rather than asserting that a file appeared.
  mkdirSync(dirname(dest), { recursive: true });
  try {
    // THE-935 fix round 1: required, not optional — `src` is the LIVE cache.db/experiential.db
    // (staged for a --sandbox rerun while a real server may still hold it open), so this open must
    // not silently fall back to DEFAULT_BUSY_TIMEOUT_MS when an operator has configured a
    // different value.
    const db = await openDatabase(src, busyTimeoutMs);
    try {
      // The destination must not exist; VACUUM INTO refuses to overwrite.
      db.exec(`VACUUM INTO ${quoteSqlString(dest)}`);
    } finally {
      db.close?.();
    }
  } catch {
    cpSync(src, dest, { dereference: true });
  }
}

/** Single-quote a path for SQL. VACUUM INTO takes a string literal, not a bind parameter. */
function quoteSqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Best-effort removal of a staged sandbox directory. Never throws: `dispose()` runs in
 *  `cli/commands/rerun.ts`'s outermost `finally`, and this command's exit code (0/1/2) is its
 *  entire output, so a cleanup failure must never corrupt it — warn to stderr and carry on instead.
 *  `maxRetries`/`retryDelay` absorb the Windows EBUSY/EPERM/ENOTEMPTY a directory removal can raise
 *  right after a file inside it (the staged cache.db) was closed. See
 *  docs/design/workspace-rerun.md. */
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
export async function stageSandbox(
  vaultRoot: string,
  cacheDir: string,
  // THE-935 fix round 1: required — see stageDatabase above.
  busyTimeoutMs: number,
): Promise<{ root: string; cacheDir: string; dispose(): void }> {
  const base = mkdtempSync(join(tmpdir(), "obtc-rerun-"));
  // A mid-copy failure must not leave `base` behind — nothing downstream calls `dispose()` for a
  // staging call that never returned. Every throwing path from here on cleans up before
  // rethrowing. See docs/design/workspace-rerun.md.
  try {
    const root = join(base, "vault");
    const cache = join(base, "cache");
    cpSync(vaultRoot, root, { recursive: true, dereference: true });
    for (const name of SANDBOX_DBS) {
      const src = join(cacheDir, name);
      if (existsSync(src)) await stageDatabase(src, join(cache, name), busyTimeoutMs);
    }
    // THE-737: a session minted today writes trace_store='cache' — its JSONL lives under
    // <cacheDir>/traces/, not under the vault. Skipping this copy makes --sandbox find
    // `no_capture` for every record on the only generation of session this server writes now. See
    // docs/design/workspace-rerun.md.
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
