import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { openDatabase } from "../../db/open";
import { buildServerRuntime } from "../../runtime/server-runtime";
import { rerunSession, stageSandbox } from "../../workspace/rerun";
import { exitCodeFor } from "../../workspace/rerun-verdict";
import { type Cmd, resolveOrUsageExit } from "../shared";

/**
 * Observe mode's ENTIRE safety guarantee.
 *
 * `aclResolver` is a RegistryOptions field fixed at ToolRegistry construction
 * (mcp/registry/types.ts:257, field at :290), and dispatch.ts:197 -> input-binding.ts:88 REPLACES
 * ctx.acl with its answer on every call that names a vault. So a per-call `ctx.acl` override (the
 * one rerun.ts's own runner sets, see workspace/rerun.ts's file header) is overwritten before the
 * readOnly gate reads it, and the only place the decision survives is the config the resolver is
 * built from — see runtime/governance.ts:95-109's `aclResolver: (vaultId) => aclByVault.get(vaultId)
 * ?? acl`.
 *
 * Forcing the root alone is NOT enough: a vault carrying its own `acl` block overrides the root
 * (`aclByVault.get(vaultId) ?? acl`, per-vault wins), so exactly those vaults would stay writable
 * while the run reported a clean observe-mode pass.
 */
export function withReadOnlyAcl(cfg: ServerConfig): ServerConfig {
  return {
    ...cfg,
    acl: { ...cfg.acl, readOnly: true },
    vaults: cfg.vaults.map((v) => (v.acl ? { ...v, acl: { ...v.acl, readOnly: true } } : v)),
  };
}

/** The configured root for `vaultId`, or the first vault when none was named. Mirrors
 *  prefetch.ts's own unknown-vault handling: an unknown id exits 2 rather than silently falling
 *  back to a vault the operator did not name. */
function vaultRootFor(cfg: ServerConfig, vaultId: string | undefined): string {
  const v = vaultId === undefined ? cfg.vaults[0] : cfg.vaults.find((x) => x.id === vaultId);
  if (!v) {
    process.stderr.write(`rerun: unknown vault ${vaultId}\n`);
    process.exit(2);
  }
  return v.path;
}

export async function run_rerun(cmd: Cmd<"rerun">): Promise<void> {
  // Observe mode (the default) forces read-only BEFORE the runtime exists. --sandbox keeps the
  // real config, because everything it touches is a disposable copy.
  const cfg = cmd.sandbox
    ? resolveOrUsageExit(cmd.input)
    : withReadOnlyAcl(resolveOrUsageExit(cmd.input));
  // Mirrors run_serve's (cli.ts) configPath resolution: cfg may already reflect
  // OBSIDIAN_TC_CONFIG via resolveServeConfig's own fallback, so buildServerRuntime's configDir
  // (relative modulePath trust root) needs the same fallback, not just cmd.input.
  const configPath = cmd.input ?? process.env.OBSIDIAN_TC_CONFIG;

  // --sandbox: stage a disposable copy BEFORE the runtime exists, and build the runtime AGAINST
  // the staged config — not merely thread staged paths into rerunSession's own options.
  // rerunSession's `vaultRoot`/`cacheDir` resolve only the TRACE file (sessions.ts's
  // resolveTraceAbs); the ToolRegistry that actually performs a re-issued patch_note/write_note
  // is built ONCE, at buildServerRuntime construction time, from THIS config's `vaults[].path`
  // (runtime/governance.ts's VaultRegistry) and `cacheDir` (runtime/stores.ts's wireStores). A
  // registry built from the real config still resolves every dispatch against the real vault and
  // real cache.db no matter what rerunSession's own options say — passing staged paths only there
  // would leave the safety hole this task exists to close. Resolved and staged BEFORE
  // buildServerRuntime is called, so an unknown --vault (vaultRootFor exits 2) or a staging
  // failure never leaves a runtime half-built to unwind.
  const stageRoot = cmd.sandbox ? vaultRootFor(cfg, cmd.vault) : undefined;
  const targetVaultId = cmd.vault ?? cfg.vaults[0]?.id;
  const staged = stageRoot !== undefined ? stageSandbox(stageRoot, cfg.cacheDir) : undefined;
  const runtimeCfg: ServerConfig = staged
    ? {
        ...cfg,
        cacheDir: staged.cacheDir,
        vaults: cfg.vaults.map((v) => (v.id === targetVaultId ? { ...v, path: staged.root } : v)),
      }
    : cfg;

  // buildServerRuntime, but never start(): a re-run needs the FULLY wired registry (every tool
  // family, not just m7 the way prefetch does) and none of the transports. close() unwinds
  // whatever the build brought up. Must run BEFORE openDatabase below: buildServerRuntime's own
  // wireStores mkdir's runtimeCfg.cacheDir, which openDatabase relies on already existing on a
  // cold run.
  const runtime = await buildServerRuntime(runtimeCfg, configPath);
  try {
    // Opened here rather than reached for through the runtime, mirroring prefetch.ts:16-17.
    // `ServerRuntime` exposes `registry`, `start` and `close` only (server-runtime.ts:72-76) — do
    // not add a field to it for this. Nested inside `runtime`'s own try/finally (fix round 1,
    // finding 3) so a throw from openDatabase itself still closes the already-built runtime,
    // instead of leaking it — the ordering above rules out simply opening the db FIRST. Opened
    // from `runtimeCfg.cacheDir`, which is the STAGED cache dir under --sandbox: the session row
    // being re-run was already recorded before staging ran (stageSandbox copies cache.db as of
    // that moment), and any DB-side effect of a re-issued mutating call must land in the
    // disposable copy too, not the real cache.db.
    const db = await openDatabase(join(runtimeCfg.cacheDir, "cache.db"));
    try {
      const result = await rerunSession({
        db,
        registry: runtime.registry,
        sessionId: cmd.sessionId,
        cacheDir: runtimeCfg.cacheDir,
        ...(staged ? { vaultRoot: staged.root } : {}),
        ...(cmd.vault !== undefined ? { expectVaultId: cmd.vault } : {}),
        ...(cmd.sandbox ? { sandbox: true } : {}),
      });

      if (cmd.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        for (const r of result.records) {
          const line =
            r.verdict === "runnable"
              ? `${r.seq}\t${r.tool}\t${r.divergence === "none" ? "same" : `DIVERGED (${r.divergence})`}\trecorded=${r.recorded.status} replayed=${r.replayed?.status} size ${r.recorded.result_size}->${r.replayed?.result_size}`
              : `${r.seq}\t${r.tool}\t${r.verdict.toUpperCase()}\t${r.reason}`;
          process.stdout.write(`${line}\n`);
        }
        const s = result.summary;
        // runnable LEADS the summary, so "nothing ran" cannot be skimmed past.
        process.stdout.write(
          `\nrunnable ${s.runnable}/${s.total} · diverged ${s.diverged} · ` +
            `no_capture ${s.byVerdict.no_capture} · redacted ${s.byVerdict.redacted} · ` +
            `truncated ${s.byVerdict.truncated} · skipped_mutating ${s.byVerdict.skipped_mutating} · ` +
            `unparseable ${s.byVerdict.unparseable}\n`,
        );
        if (s.runnable === 0)
          process.stderr.write(
            "rerun: nothing was runnable. If every record reads `no_capture`, `sessions.traceContent` was off when this session was recorded — the trace holds no arguments to re-issue.\n",
          );
      }
      process.exitCode = exitCodeFor(result.summary);
    } finally {
      db.close?.();
    }
  } finally {
    // Dispose the staged copy BEFORE closing the runtime — the runtime is what still holds the
    // staged cache.db open, but the copy itself is throwaway either way, and disposing it late
    // would leave a temp directory behind on a runtime.close() failure.
    staged?.dispose();
    await runtime.close("rerun complete");
  }
}
