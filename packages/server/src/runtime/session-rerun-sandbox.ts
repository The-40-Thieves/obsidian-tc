// Split out of server-runtime.ts (biome's 700-line noExcessiveLinesPerFile cap) — see that file's
// own "Adding a tool moves eight things" note in CLAUDE.md, item 8. `makeSandboxRerun` takes
// `buildRuntime` as a plain injected function value rather than importing `buildServerRuntime`
// from "./server-runtime": nothing here needs to import that module at all, which is what avoids
// the cycle (server-runtime.ts -> tool-wiring.ts -> m6/admin-tools.ts -> back to server-runtime.ts)
// a direct import would create. See server-runtime.ts's own call site for how it wires this in.

import { err, type ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { openConfiguredDatabase } from "../db/open";
import type { Database } from "../db/types";
import type { ToolRegistry } from "../mcp/registry";
import { canonicalizeVaultRoot } from "../vault/registry";
import {
  type RerunResult,
  rerunSession,
  sandboxRuntimeConfig,
  stageSandbox,
} from "../workspace/rerun";
import {
  sweepStaleSandboxDirs,
  trackPendingSandboxCleanup,
} from "../workspace/rerun-sandbox-cleanup";

/** The only surface `makeSandboxRerun` needs from a built runtime — narrower than the real
 *  `ServerRuntime` interface (server-runtime.ts) on purpose, so this file never has to import it. */
interface SandboxRuntime {
  registry: ToolRegistry;
  close(reason: string): Promise<void>;
}

/** Structurally compatible with `buildServerRuntime`'s own signature (it takes two more optional
 *  params, and returns the wider `ServerRuntime`) without naming that type. */
export type BuildServerRuntime = (
  config: ServerConfig,
  configPath: string | undefined,
) => Promise<SandboxRuntime>;

/** How many sandbox reruns one runtime runs at once. Each holds a full staged copy of a vault plus
 *  a second booted runtime (its db handles, its vault-lock keepalive) until its cleanup finishes —
 *  including a timed-out one whose staging/boot has not stopped yet — so this is the ceiling on
 *  disk and handles the tool can pin, not just on concurrent CPU work. */
export const MAX_CONCURRENT_SANDBOX_RERUNS = 2;

/** Cleanup still waiting on staging/boot/replay this long after the call returned gets a stderr
 *  warning — the one signal that a sandbox is holding its slot and its staged dir past its budget. */
const SLOW_CLEANUP_WARN_MS = 60_000;

export interface SandboxRerunParams {
  vaultId: string;
  sessionId: string;
  replayScopes: readonly string[];
  timeoutMs: number;
}

/**
 * `session_rerun` (m6/admin-tools.ts) — build a SECOND, disposable runtime scoped to a staged copy
 * of one session's own vault, run its re-issue there, then dispose it. This is the sandbox-only MCP
 * twin of `cli/commands/rerun.ts`'s `--sandbox` path, and reuses its exact staging shape
 * (`stageSandbox`, `sandboxRuntimeConfig`).
 *
 * `config`/`configPath` are the caller's own boot config, closed over once here rather than
 * threaded through every call — `buildRuntime` is the only thing that varies per call site
 * (production passes `buildServerRuntime`; tests can pass a stub).
 *
 * `params.timeoutMs` bounds the WHOLE pipeline — staging (`cpSync` of the whole vault, `VACUUM
 * INTO` of every staged db), the second `buildRuntime` (a full second boot: migrations, index
 * resources, the embedding provider), and `rerunSession` itself — as one race, not just the last
 * stage of it: staging and boot have real, unbounded wall-clock cost of their own.
 *
 * `params.timeoutMs` bounds the CALL: at the deadline the caller gets `operation_timeout`
 * whatever `work` is doing. It is not a cancellation of `work` — staging and the second boot are not
 * cancellable at all; `cancelled` (set the instant the timeout fires) only stops `rerunSession`'s
 * own loop, within one macrotask, once `work` gets there.
 *
 * Cleanup is a separate chain, started with `work` and run on every exit: wait for `work` to
 * settle, THEN `sandboxDb.close()` and `runtime.close()` (whichever `work` got as far as creating —
 * on a timeout that fired mid-staging, both are assigned only after this chain began, so they are
 * read after the wait, never before), THEN `staged.dispose()`. Windows opens every handle without
 * FILE_SHARE_DELETE, so the directory cannot be removed while `work` (or the runtime it built) still
 * holds a file in it — removing it early fails with EPERM, and a runtime never closed keeps its
 * vault-lock keepalive and db handles open for the life of the process. Success and error paths
 * await this chain before returning (`work` has already settled there, so it is quick); a timeout
 * returns without it and leaves it tracked (`trackPendingSandboxCleanup`), warning on stderr if it
 * is still waiting after `SLOW_CLEANUP_WARN_MS`. A still-running `work` cannot reach anything but its
 * own staged copy: `sandboxRuntimeConfig` excludes every sibling vault and every network transport
 * from `runtimeCfg` before `buildRuntime` ever runs.
 *
 * Each call holds one of `MAX_CONCURRENT_SANDBOX_RERUNS` slots until its cleanup finishes, not until
 * the caller gets its answer — so repeated timed-out calls against a boot that will not finish are
 * refused as `throttled` once the slots are gone, instead of piling up staged copies. A directory
 * `dispose()` still cannot remove falls back to a background retry, and every call first sweeps
 * whatever a past run left behind — see `workspace/rerun-sandbox-cleanup.ts`.
 */
export function makeSandboxRerun(
  config: ServerConfig,
  configPath: string | undefined,
  buildRuntime: BuildServerRuntime,
): (params: SandboxRerunParams) => Promise<RerunResult> {
  let active = 0;
  return async (params: SandboxRerunParams): Promise<RerunResult> => {
    if (active >= MAX_CONCURRENT_SANDBOX_RERUNS)
      throw err.throttled(
        `session_rerun: ${MAX_CONCURRENT_SANDBOX_RERUNS} sandbox reruns are already running (or still cleaning up); retry once one finishes`,
        { max_concurrent: MAX_CONCURRENT_SANDBOX_RERUNS },
      );
    let staged: { root: string; cacheDir: string; dispose(): void } | undefined;
    let sandboxRuntime: SandboxRuntime | undefined;
    let sandboxDb: Database | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Flipped true the instant the timeout below actually fires — read by `rerunSession`'s own
    // `cancelled` poll (workspace/rerun.ts), so a timed-out replay stops dispatching further
    // records within one macrotask instead of running the rest of the trace in the background.
    let cancelled = false;

    // Windows safety net (workspace/rerun-sandbox-cleanup.ts): sweep whatever a PAST run of this
    // tool — or `rerun --sandbox` — left behind before staging a new copy. Cheap on a box that has
    // never left one: a single `readdirSync(tmpdir())` plus a `statSync` per `obtc-rerun-*` match.
    sweepStaleSandboxDirs();

    active += 1;
    const work = (async (): Promise<RerunResult> => {
      const staticVault = config.vaults.find((v) => v.id === params.vaultId);
      if (!staticVault)
        throw err.vaultNotFound(`vault is no longer in config: ${params.vaultId}`, {
          vault: params.vaultId,
        });
      staged = await stageSandbox(
        params.vaultId,
        canonicalizeVaultRoot(staticVault.path),
        config.cacheDir,
        config.db.busyTimeoutMs,
      );
      const runtimeCfg = sandboxRuntimeConfig(config, params.vaultId, staged);
      sandboxRuntime = await buildRuntime(runtimeCfg, configPath);
      sandboxDb = await openConfiguredDatabase(runtimeCfg, "cache.db");
      const root = staged.root;
      return await rerunSession({
        db: sandboxDb,
        registry: sandboxRuntime.registry,
        sessionId: params.sessionId,
        cacheDir: runtimeCfg.cacheDir,
        vaultRootFor: () => root,
        expectVaultId: params.vaultId,
        sandbox: true,
        replayScopes: params.replayScopes,
        cancelled: () => cancelled,
      });
    })();

    const cleanup = (async (): Promise<void> => {
      await work.catch(() => {});
      try {
        sandboxDb?.close?.();
      } catch {
        // best-effort: the runtime close and the dispose below must still run
      }
      if (sandboxRuntime) await sandboxRuntime.close("session_rerun complete").catch(() => {});
      staged?.dispose(); // never throws: falls back to a background retry (safeDispose)
    })().finally(() => {
      active -= 1;
    });
    trackPendingSandboxCleanup(cleanup);

    let timedOut = false;
    try {
      return await new Promise<RerunResult>((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          cancelled = true;
          reject(
            err.operationTimeout(
              `session_rerun: exceeded the ${params.timeoutMs}ms sandbox timeout (staging + boot + replay)`,
              { timeout_ms: params.timeoutMs },
            ),
          );
        }, params.timeoutMs);
        work.then(
          (r) => {
            if (timer) clearTimeout(timer);
            resolve(r);
          },
          (e) => {
            if (timer) clearTimeout(timer);
            reject(e);
          },
        );
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        const warn = setTimeout(() => {
          process.stderr.write(
            `session_rerun: warning: sandbox cleanup still waiting on staging/boot/replay ` +
              `${SLOW_CLEANUP_WARN_MS}ms after the ${params.timeoutMs}ms timeout; its staged ` +
              "directory and concurrency slot stay held until that work stops\n",
          );
        }, SLOW_CLEANUP_WARN_MS);
        warn.unref();
        void cleanup.finally(() => clearTimeout(warn));
      } else {
        await cleanup;
      }
    }
  };
}
