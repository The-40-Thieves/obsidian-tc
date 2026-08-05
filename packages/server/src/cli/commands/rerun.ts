import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { openDatabase } from "../../db/open";
import { buildServerRuntime } from "../../runtime/server-runtime";
import { rerunSession } from "../../workspace/rerun";
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
  // buildServerRuntime, but never start(): a re-run needs the FULLY wired registry (every tool
  // family, not just m7 the way prefetch does) and none of the transports. close() unwinds
  // whatever the build brought up.
  const runtime = await buildServerRuntime(cfg, configPath);
  // Opened here rather than reached for through the runtime, mirroring prefetch.ts:16-17.
  // `ServerRuntime` exposes `registry`, `start` and `close` only (server-runtime.ts:72-76) — do
  // not add a field to it for this.
  const db = await openDatabase(join(cfg.cacheDir, "cache.db"));
  try {
    const result = await rerunSession({
      db,
      registry: runtime.registry,
      sessionId: cmd.sessionId,
      cacheDir: cfg.cacheDir,
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
    await runtime.close("rerun complete");
  }
}
