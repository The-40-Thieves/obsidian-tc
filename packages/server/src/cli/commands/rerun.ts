import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { openDatabase } from "../../db/open";
import { buildServerRuntime } from "../../runtime/server-runtime";
import { rerunSession, stageSandbox } from "../../workspace/rerun";
import { exitCodeFor } from "../../workspace/rerun-verdict";
import { getSession } from "../../workspace/sessions";
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

/** The configured path for `vaultId`. Exits 2 with the prefetch.ts-style message when the id names
 *  no configured vault — a broken config (the session's own vault_id is not one of `cfg.vaults`),
 *  not an operator typo (see `stageForSandbox` for that case). */
function configuredVaultPath(cfg: ServerConfig, vaultId: string): string {
  const v = cfg.vaults.find((x) => x.id === vaultId);
  if (!v) {
    process.stderr.write(`rerun: unknown vault ${vaultId}\n`);
    process.exit(2);
  }
  return v.path;
}

/**
 * Resolve and stage the vault a `--sandbox` re-run must actually touch.
 *
 * Fix round 1, finding 1 (CRITICAL, reproduced by review): the first cut defaulted to
 * `cfg.vaults[0]` (or `--vault`) and staged THAT vault, but `rerunSession` dispatches every call
 * with `vaultId: row.vault_id` — the SESSION's actual vault — and only checks `--vault` as a
 * guard when it was explicitly given. In a multi-vault config, a session recorded against a vault
 * OTHER than the first one (or than `--vault`, if given and wrong) staged the wrong copy while
 * the real, correct vault stayed unstaged — so the mutating call landed there for real. This
 * repo's own CLAUDE.md documents the production deployment as two vaults, so that was not
 * hypothetical.
 *
 * The session row already knows the ONE vault this run can touch, so read it FIRST — from the
 * REAL cache.db, before that path is replaced by a staged copy — and stage exactly that vault.
 * `--vault`, when given, stays a GUARD (mirroring `rerunSession`'s own `expectVaultId` check):
 * checked here too so an explicit mismatch fails loud BEFORE any staging I/O runs, not merely
 * after wasted work.
 */
async function stageForSandbox(
  cfg: ServerConfig,
  sessionId: string,
  expectVaultId: string | undefined,
): Promise<{ vaultId: string; root: string; cacheDir: string; dispose(): void }> {
  const probeDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  let vaultId: string;
  try {
    const row = getSession(probeDb, sessionId);
    // Same message rerunSession itself throws for this case (workspace/rerun.ts) — checked here
    // too because a session that doesn't exist has no vault to stage.
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    if (expectVaultId !== undefined && expectVaultId !== row.vault_id)
      throw new Error(
        `session ${sessionId} belongs to vault ${row.vault_id}, not ${expectVaultId}`,
      );
    vaultId = row.vault_id;
  } finally {
    probeDb.close?.();
  }
  const staged = stageSandbox(configuredVaultPath(cfg, vaultId), cfg.cacheDir);
  return { vaultId, ...staged };
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
  // would leave the safety hole this task exists to close.
  //
  // Fix round 1, finding 2: wrapped in its own try/finally from THIS point on, not just around
  // `buildServerRuntime`'s call — if construction throws AFTER staging already succeeded, the
  // staged temp directory must still be disposed rather than leaked permanently.
  const staged = cmd.sandbox ? await stageForSandbox(cfg, cmd.sessionId, cmd.vault) : undefined;
  try {
    const runtimeCfg: ServerConfig = staged
      ? {
          ...cfg,
          cacheDir: staged.cacheDir,
          vaults: cfg.vaults.map((v) =>
            v.id === staged.vaultId ? { ...v, path: staged.root } : v,
          ),
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
      // `ServerRuntime` exposes `registry`, `start` and `close` only (server-runtime.ts:72-76) —
      // do not add a field to it for this. Nested inside `runtime`'s own try/finally so a throw
      // from openDatabase itself still closes the already-built runtime instead of leaking it —
      // the ordering above rules out simply opening the db FIRST. Opened from
      // `runtimeCfg.cacheDir`, which is the STAGED cache dir under --sandbox: the session row
      // being re-run was already read (by `stageForSandbox`) before staging ran, so the staged
      // copy already carries it, and any DB-side effect of a re-issued mutating call must land in
      // the disposable copy too, not the real cache.db.
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
      await runtime.close("rerun complete");
    }
  } finally {
    // Fix round 1, finding 3: the ORIGINAL brief said dispose BEFORE runtime.close — that is
    // backwards on Windows. `dispose()` rmSync's the staged directory, including the staged
    // cache.db, while `runtime` may still hold an open handle on it; removing a file needs both
    // the write bit AND the handle closed on Windows (this repo's own documented history —
    // reference_windows_rm_needs_writable_and_closed), and `ci-server.yml`'s matrix runs
    // windows-latest unconditionally. Linux tolerates the wrong order only because the inode
    // survives until the fd closes, which is exactly the kind of platform-specific pass that
    // hides a real ordering bug. Correct order: close the runtime FIRST (releasing any handle on
    // the staged files), THEN dispose the now-unheld staged copy — this `finally` runs after the
    // inner try/finally above has already awaited `runtime.close`, so ordering falls out of the
    // nesting rather than needing an explicit await-then-await here.
    staged?.dispose();
  }
}
