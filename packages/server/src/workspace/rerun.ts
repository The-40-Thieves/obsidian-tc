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
import { grantsScope, type ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { FolderAcl } from "../acl";
import { tableExists } from "../db/introspect";
import { openDatabase } from "../db/open";
import type { Database } from "../db/types";
import { READ_ONLY_DENIAL_MESSAGE, type ToolRegistry } from "../mcp/registry";

import {
  RERUN_TMP_PREFIX,
  scheduleDeferredCleanup,
  startSandboxHeartbeat,
} from "./rerun-sandbox-cleanup";
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

/**
 * Narrow RERUN_SCOPES to what `granted` actually covers, family-wildcard for family-wildcard.
 *
 * RERUN_SCOPES alone is the CEILING every runner is bound by; it is not, on its own, safe to hand
 * to every caller of `rerunSession`. The CLI runner is fine passing it unconditionally — an
 * operator invoking it locally already holds full local scope (`grantedScopes: new
 * Set(["*"])`, see runtime/server-runtime.ts's stdio context). A caller of the sandbox-only MCP
 * tool is a much weaker bar (`admin:rerun` plus HITL, nothing about what THAT caller may mutate),
 * so a mutating record must never be replayed as successful just because RERUN_SCOPES says so —
 * only because the CALLER'S OWN grant covers it too.
 *
 * `grantsScope` (not a raw set intersection) so a caller holding the global `"*"` still unlocks
 * every family, and a caller holding an EXACT family wildcard (`"write:*"`) unlocks that one. The
 * intersection is deliberately family-wildcard, not per-resource: a caller holding only
 * `"write:notes"` does not unlock `"write:*"` here, because a replayed session can re-issue any
 * resource within that family, which is authority `write:notes` alone does not carry.
 */
export function intersectReplayScopes(granted: Iterable<string>): string[] {
  const set = granted instanceof Set ? granted : new Set(granted);
  return RERUN_SCOPES.filter((s) => grantsScope(set, s));
}

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
  /**
   * The scopes granted to each re-issued call. Required, not defaulted to RERUN_SCOPES — a
   * default would be the exact silent-widening bug this field exists to rule out for a caller
   * that forgets to narrow it. The CLI passes RERUN_SCOPES verbatim; session_rerun's MCP tool
   * passes `intersectReplayScopes(ctx.grantedScopes)`. See intersectReplayScopes above.
   */
  replayScopes: readonly string[];
  /**
   * Polled once per record, right after the per-record `setImmediate` yield above — a caller
   * racing this whole call against a timeout (session_rerun's MCP tool; see
   * session-rerun-sandbox.ts) flips this true the instant its own timer fires, so the loop stops
   * within one macrotask instead of running every remaining record to completion. The CLI passes
   * none: `rerun --sandbox`/observe mode has no timeout to race, so there is nothing to poll.
   *
   * This exists because a lost race alone is not enough to actually stop the loop — the timeout
   * only rejects the OUTER promise a caller is awaiting; nothing about that changes what an
   * already-in-flight `rerunSession` call keeps doing. Without a way to ask it to stop, a
   * "timed out" replay of a long session kept dispatching every remaining record in the
   * background, each one a real handle into the sandbox's staged files, for however long the
   * whole trace took to finish — directly the reason a staged directory could still be locked long
   * after the caller had already been told the run timed out. See
   * `makeSandboxRerun`'s own `finally` for the (much shorter, now near-instant) bounded wait this
   * still keeps as a safety margin.
   */
  cancelled?: () => boolean;
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

/** True when a required scope falls outside what THIS RUN's `replayScopes` grants — i.e. the
 *  refusal is rerun's own policy, not the vault disagreeing. For the CLI (replayScopes ===
 *  RERUN_SCOPES) that is family wildcards minus `admin`, so in practice the admin: family. For
 *  session_rerun's MCP tool, `replayScopes` may be narrower still (see intersectReplayScopes), so
 *  a family the CALLER never unlocked refuses here too. Computed from the run's own grant set
 *  rather than from a message, so it cannot drift when a gate's wording changes. */
function refusedByRerunScope(err: DispatchLike["error"], replayScopes: readonly string[]): boolean {
  const required = err?.details?.required;
  if (!Array.isArray(required)) return false;
  const families = new Set(replayScopes.map((s) => s.split(":")[0]));
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
    // Every store this loop touches (better-sqlite3/bun:sqlite, node:fs) is fully SYNCHRONOUS, so
    // `await opts.registry.dispatch(...)` below settles through nothing but already-resolved
    // microtasks — it never yields to a macrotask. A caller racing this whole call against a
    // timeout (session_rerun's MCP tool; see session-rerun-sandbox.ts) schedules that timeout via
    // `setTimeout`, a MACROTASK — and Node does not run a due macrotask until the current
    // microtask queue drains. A long enough session's records would otherwise chain microtask to
    // microtask without a single gap, starving that timer indefinitely REGARDLESS of how much real
    // wall-clock time has elapsed, which is exactly the runaway-replay case
    // DEFAULT_SESSION_RERUN_TIMEOUT_MS's own doc comment (admin-tools.ts) promises this loop cannot
    // cause. `setImmediate` forces one macrotask-queue round-trip per record, giving an
    // already-elapsed timeout its turn between them.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // See `cancelled`'s own doc comment (RerunOptions) — stop dispatching further records the
    // instant a caller's own timeout has fired, rather than running the rest of the trace in the
    // background. `records`/`summarizeRerun` below still see whatever was already collected; a
    // cancelled run's RETURN VALUE is never read by session_rerun's MCP tool (the timeout already
    // rejected the caller), so a partial summary here is fine — the only thing that matters is that
    // this function itself stops promptly.
    if (opts.cancelled?.()) break;
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

    // A call that acted on another vault than the session's: this run is bound to the session's own
    // vault (`vaultBound` below), so re-issuing it would be refused as `forbidden` and read as a
    // divergence. It is rerun's own refusal, not the vault disagreeing.
    if (typeof rec.effect_vault === "string") {
      records.push({
        ...common,
        verdict: "refused_by_policy",
        reason: `this call acted on vault ${rec.effect_vault}, not the session's own vault; a re-run is bound to the session's vault`,
        replayed: null,
        divergence: "none",
      });
      continue;
    }

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
      // Family wildcards minus `admin`, narrowed to what THIS RUN grants — see RerunOptions.replayScopes.
      grantedScopes: new Set(opts.replayScopes),
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
    // a call refused because `opts.replayScopes` (RERUN_SCOPES, or a caller-narrowed subset of it
    // — see intersectReplayScopes) does not cover the family it requires. See
    // docs/design/workspace-rerun.md.
    if (
      !res.ok &&
      (code === "plugin_unreachable" || refusedByRerunScope(res.error, opts.replayScopes))
    ) {
      records.push({
        ...common,
        verdict: "refused_by_policy",
        reason:
          code === "plugin_unreachable"
            ? "the sandbox stripped the plugin bridge, so this tool could not reach the Obsidian app — rerun's own refusal, not a vault change"
            : "this run does not grant the scope this tool requires — rerun's own refusal, not a vault change",
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

/** Drop `vaultId`'s row from a just-staged `cache.db`'s `vault_identity` table, when the table
 *  exists (a copy of a cache.db from before the 20260928_001 migration has none — nothing to
 *  drop). See `stageSandbox`'s own doc comment for why this row is stale the instant it is copied,
 *  and safe to remove: `resolveAndApplyVaultIdentity` (runtime/stores.ts) reinserts it, correctly
 *  pointed at the staged root, the moment the sandbox's own runtime boots. */
async function dropStaleVaultIdentity(
  stagedCacheDbPath: string,
  vaultId: string,
  busyTimeoutMs: number,
): Promise<void> {
  const db = await openDatabase(stagedCacheDbPath, busyTimeoutMs);
  try {
    if (tableExists(db, "vault_identity")) {
      db.prepare("DELETE FROM vault_identity WHERE vault_id = ?").run(vaultId);
    }
  } finally {
    db.close?.();
  }
}

/** Best-effort removal of a staged sandbox directory. Never throws: `dispose()` runs in
 *  `cli/commands/rerun.ts`'s outermost `finally`, and this command's exit code (0/1/2) is its
 *  entire output, so a cleanup failure must never corrupt it — warn to stderr and carry on instead.
 *  `maxRetries`/`retryDelay` absorb the Windows EBUSY/EPERM/ENOTEMPTY a directory removal can raise
 *  right after a file inside it (the staged cache.db) was closed. See
 *  docs/design/workspace-rerun.md.
 *
 *  A handle that outlives even those retries (a still-settling background operation — see
 *  session-rerun-sandbox.ts's own wait before calling this) hands off to
 *  `rerun-sandbox-cleanup.ts`'s `scheduleDeferredCleanup`: an unref'd background retry, so this
 *  synchronous call still returns immediately either way and the directory is not simply
 *  abandoned. */
function safeDispose(base: string): void {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (e) {
    process.stderr.write(
      `rerun: warning: failed to remove staged sandbox directory ${base}: ${(e as Error).message} ` +
        "— retrying in the background\n",
    );
    scheduleDeferredCleanup(base);
  }
}

/**
 * Stage a disposable copy of a vault and its databases.
 *
 * COPY, never symlink — a symlinked database is the live one, and the whole guarantee of sandbox
 * mode is that everything it touches is throwaway.
 *
 * `vaultId` — the config id the staged copy will be booted under (session_rerun's own vault, or
 * `--vault`'s). Stable vault identity (20260928_001_vault_identity.sql) records, per id, the ONE
 * canonical root path a live boot has already seen it at; `cache.db` is copied byte-for-byte
 * (`stageDatabase`'s `VACUUM INTO`), so the staged copy inherits that SAME row even though the
 * sandbox always boots this id against a DIFFERENT path (the staged copy, never the real root).
 * Left as-is, the second `buildServerRuntime` this stages for reads "known id, different path" and
 * refuses to boot at all (`vault/identity.ts`'s isolate rule) — every `--sandbox`/`session_rerun`
 * run against an already-booted cache.db would fail this way. The staged copy is disposable and
 * reread from `deps.vaults` on its own next boot regardless, so dropping just this one id's row
 * before that boot is safe: it comes back immediately, now correctly pointed at the staged root.
 */
export async function stageSandbox(
  vaultId: string,
  vaultRoot: string,
  cacheDir: string,
  // THE-935 fix round 1: required — see stageDatabase above.
  busyTimeoutMs: number,
): Promise<{ root: string; cacheDir: string; dispose(): void }> {
  const base = mkdtempSync(join(tmpdir(), RERUN_TMP_PREFIX));
  let stopHeartbeat = (): void => {};
  // A mid-copy failure must not leave `base` behind — nothing downstream calls `dispose()` for a
  // staging call that never returned. Every throwing path from here on cleans up before
  // rethrowing. See docs/design/workspace-rerun.md.
  try {
    stopHeartbeat = startSandboxHeartbeat(base);
    const root = join(base, "vault");
    const cache = join(base, "cache");
    cpSync(vaultRoot, root, { recursive: true, dereference: true });
    for (const name of SANDBOX_DBS) {
      const src = join(cacheDir, name);
      if (existsSync(src)) await stageDatabase(src, join(cache, name), busyTimeoutMs);
    }
    const stagedCacheDb = join(cache, "cache.db");
    if (existsSync(stagedCacheDb))
      await dropStaleVaultIdentity(stagedCacheDb, vaultId, busyTimeoutMs);
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
      dispose: () => {
        stopHeartbeat();
        safeDispose(base);
      },
    };
  } catch (e) {
    // safeDispose never throws (see above), so the ORIGINAL error `e` — the reason staging
    // failed — is what propagates, not whatever rmSync ran into while cleaning up after it.
    stopHeartbeat();
    safeDispose(base);
    throw e;
  }
}

/**
 * Strip the plugin-bridge transport from a vault.
 *
 * A sandbox staging copy bounds FILESYSTEM writes and nothing else. `wireBridges`
 * (runtime/bridge-wiring.ts) builds a Local REST API client per vault from `restApiUrl`/
 * `restApiKey`, and a bridge tool then POSTs to the LIVE Obsidian app, which is operating on the
 * REAL vault: `git_stage` checks `enforcePathAcl` against the STAGED root and then stages files in
 * the real repo; `remotely_save` triggers a real sync. None of `write:git`, `write:tasks`,
 * `write:excalidraw`, `write:remotely-save` is in `HITL_FLOOR_FAMILIES`, so nothing else stops
 * them. A filesystem copy cannot bound a network-mediated write — so the sandbox removes the
 * transport instead, and every bridge tool degrades loudly (`plugin_unreachable` from
 * `openBridge`'s `if (!client)`) rather than silently reaching the live app.
 *
 * Shared by `cli/commands/rerun.ts`'s `--sandbox` path and `session_rerun`'s (m6/admin-tools.ts)
 * per-call sandbox runtime — one definition, so the two never drift on what "stripped" means.
 */
export function withoutBridgeTransport(
  v: ServerConfig["vaults"][number],
): ServerConfig["vaults"][number] {
  const { restApiUrl: _url, restApiKey: _key, ...rest } = v;
  return rest;
}

/**
 * Build the config a sandbox's second `buildServerRuntime` boots against — the staged cache dir,
 * ONLY the session's own vault (bridge-stripped, remapped to the staged root), and every
 * transport/watch/telemetry surface that could otherwise reach past the staged copy forced off.
 *
 * `stageSandbox`'s own doc comment is the "disposable copy" guarantee this exists to keep true.
 * That guarantee held for FILESYSTEM writes but not for what construction alone brings up: with
 * every OTHER configured vault left at its live path, `wireIndexCoordinator` registers a second
 * watcher on each one (leader on the staged `cacheDir`, so its writes reindex live changes into a
 * throwaway copy), `wireTransports` binds a live HTTP listener when `transports.http.enabled` is
 * true — a second MCP server, exposing every live vault path this config knows about, up for as
 * long as the sandbox runtime stays open — and `initOtel`/Prometheus export to the live collector.
 * None of that is reachable through `start()`, which neither caller below ever calls, but all of
 * it runs during construction regardless.
 *
 * Dropping every vault but the one being replayed removes the sibling-vault leak at the root
 * rather than papering over its symptoms: neither caller ever dispatches against any vault but
 * this one (`rerunSession`'s own `vaultBound: true` already refuses a record naming a different
 * one), so no sibling vault needs to be reachable from the sandbox runtime at all. A single-vault
 * config is an already-supported shape — it's the default `npx obsidian-tc /path/to/vault` mode —
 * not a novel one this introduces.
 *
 * Shared by `cli/commands/rerun.ts`'s `--sandbox` path and `session_rerun`'s
 * (runtime/session-rerun-sandbox.ts) per-call sandbox runtime — one definition, so the two cannot
 * drift on what "isolated" means, same reasoning `withoutBridgeTransport` above documents for the
 * bridge-transport slice alone.
 */
export function sandboxRuntimeConfig(
  cfg: ServerConfig,
  vaultId: string,
  staged: { root: string; cacheDir: string },
): ServerConfig {
  const vault = cfg.vaults.find((v) => v.id === vaultId);
  if (!vault) throw new Error(`sandboxRuntimeConfig: vault is no longer in config: ${vaultId}`);
  return {
    ...cfg,
    cacheDir: staged.cacheDir,
    vaults: [{ ...withoutBridgeTransport(vault), path: staged.root }],
    watch: { ...cfg.watch, enabled: false },
    transports: {
      stdio: false,
      http: { ...cfg.transports.http, enabled: false },
    },
    observability: {
      ...cfg.observability,
      prometheus: { ...cfg.observability.prometheus, enabled: false },
      otel: { ...cfg.observability.otel, endpoint: undefined },
    },
  };
}
