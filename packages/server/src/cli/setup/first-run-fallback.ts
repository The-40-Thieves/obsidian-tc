// PR B of GH #995's two-part follow-up (PR A: #1001, `obsidian-tc setup`). `serve` used to just
// error — "no vault or config given" — the moment it was launched with nothing to boot from: no
// `--config`/positional, no OBSIDIAN_TC_CONFIG, and no default config on disk yet. That is exactly
// the shape most first-time operators hit: an MCP client (Claude Desktop, Cursor, Claude Code)
// launches `obsidian-tc` with NO arguments at all, because its own config only names the command.
//
// This module runs PR A's own detection/decision pass (`detect`/`decideSetup`/`buildSetupConfig`/
// `writeSetupConfig` — cli/commands/setup.ts, cli/setup/{decide,write}.ts) exactly once, non-
// interactively, and writes a config ONLY when the result is unambiguous and safe: exactly one
// vault found in the Obsidian registry, no refusal (decide.ts's own comment on `refusal`), and no
// existing config (checked by the caller, `shouldAttemptFirstRunFallback`, before any of this
// runs at all). Anything else — 0 or >=2 vaults, a refusal — writes NOTHING: the same "detect
// once, write the decision explicitly, never guess" principle PR A's own header states, applied to
// the one case where there is no operator watching a prompt to confirm it.
//
// Race safety: several MCP clients can launch `obsidian-tc serve` with no config at the exact same
// moment (Claude Desktop + Claude Code + Cursor all pointed at the same fresh install). PR A's own
// no-`--force` write path is already end-to-end exclusive (cli/setup/write.ts's
// finalizeExclusiveCreate: a hard link from an already-fsynced temp file, EEXIST if the target now
// exists). The LOSER of that race does not retry or error here — it re-reads the WINNER's file
// through the real loader and boots with that, so two concurrent first-runs converge on ONE file
// and both processes still boot.
import { existsSync } from "node:fs";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { finalizeConfig, readConfigFile } from "../../config/load";
import { CliError } from "../cli-error";
import { detect } from "../commands/setup";
import { defaultSetupConfigPath, isUnusableInput } from "../resolve-config";
import { writeSetupConfig } from "./write";

/** Finding 1 (fix round, cross-vendor review): the loser of the race sees `target` exist the
 *  MOMENT the winner's `openSync(target, "wx")` claims the name (write.ts's own comment on that
 *  fallback) — before a single byte has landed, on the volumes where `linkSync` isn't available.
 *  Reading immediately either throws (empty file, `JSON.parse` on `""`) or worse, silently boots a
 *  truncated config. Retry the read for a short, bounded window, treating "does not parse yet" as
 *  "the winner hasn't finished" rather than a real failure — `readConfigFile` itself already
 *  strips the BOM and `JSON.parse`s, so a SyntaxError here is exactly "content still landing", and
 *  every other error (ENOENT racing the caller's own `existsSync`, permissions) is equally worth
 *  one more look inside the same short window. Once the file parses, hand the raw object back
 *  un-finalized — the caller runs it through the SAME `finalizeConfig` call the winner does
 *  (finding 3), so overlays/derivations never diverge between the two outcomes. */
const RACE_READ_RETRY_DEADLINE_MS = 2000;
const RACE_READ_RETRY_INTERVAL_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRacedConfigFile(path: string): Promise<Record<string, unknown>> {
  // Finding 4 (fix round, cross-vendor review): `Date.now()` reads the wall clock, which an NTP
  // step-back can move backwards (or jump forward) mid-loop — `performance.now()` is monotonic,
  // so the 2s budget this retries against can never run short or long because the SYSTEM clock
  // moved, only because real time actually elapsed.
  const deadline = performance.now() + RACE_READ_RETRY_DEADLINE_MS;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      return readConfigFile(path);
    } catch (e) {
      lastError = e;
      await sleep(RACE_READ_RETRY_INTERVAL_MS);
    }
  }
  // Finding 4: one LAST read after the deadline, before giving up — without this, a winner's write
  // that lands during the final `sleep` above (the loop condition is checked BEFORE that sleep
  // returns) fails this process even though the file is valid by the time control returns here.
  try {
    return readConfigFile(path);
  } catch (e) {
    lastError = e;
  }
  // The deadline elapsed and the file STILL doesn't parse — this is no longer "the winner hasn't
  // finished writing yet", it's a genuinely stuck/corrupt file. Surface the real read error rather
  // than swallowing it into a confusing downstream failure.
  throw lastError instanceof Error
    ? lastError
    : new CliError(`could not read a valid config from ${path} after racing another process`);
}

/** PR B's own opt-out (this repo's established `OBSIDIAN_TC_*` env-var pattern, e.g.
 *  OBSIDIAN_TC_CONFIG/OBSIDIAN_TC_GATEWAY_URL) — an operator (or a script that means to see the
 *  bare "no vault or config given" error, e.g. to catch it) sets this to skip the fallback
 *  entirely and get PR A's pre-existing behavior back unchanged. */
export const NO_AUTO_SETUP_ENV_VAR = "OBSIDIAN_TC_NO_AUTO_SETUP";

/**
 * Whether `serve` should even attempt the fallback — pure, checked BEFORE any of PR A's own I/O
 * (registry probe, Ollama probe, hardware probe, ...) runs at all. Every condition below must
 * hold:
 *  - no `--config`/positional path was given to `serve` at all (`input === undefined`)
 *  - OBSIDIAN_TC_CONFIG is not set (the same env var `resolveServeConfigWithProvenance` itself
 *    falls back to first — this function is checked strictly BEFORE that resolution, so it must
 *    apply the identical rule or the fallback and the real resolver could disagree)
 *  - OBSIDIAN_TC_NO_AUTO_SETUP is not set (see its own doc comment above)
 *  - the conventional target (`defaultSetupConfigPath()`) does not already exist — an existing
 *    config, however it got there, is `serve`'s to load, never this fallback's to touch
 */
export function shouldAttemptFirstRunFallback(deps: {
  input: string | undefined;
  env: Record<string, string | undefined>;
}): boolean {
  // Finding 6 (fix round, cross-vendor review): an unsubstituted MCPB `${user_config.X}`
  // placeholder or an empty string is a DEFINED `input`, but names nothing usable — the same "no
  // real input was given" shape `resolve-config.ts`'s own `normalizeConfigPathInput` already
  // treats as absent for the REST of config resolution. A gate that only checked `!== undefined`
  // read either shape as "input WAS given" and never even attempted the fallback for the exact
  // first-run shape (a Claude Desktop MCPB launch with a blank field) this feature is for.
  if (deps.input !== undefined && !isUnusableInput(deps.input)) return false;
  if ((deps.env.OBSIDIAN_TC_CONFIG?.length ?? 0) > 0) return false;
  if (deps.env[NO_AUTO_SETUP_ENV_VAR] === "1") return false;
  return !existsSync(defaultSetupConfigPath());
}

export type FirstRunFallbackResult =
  | { outcome: "written"; path: string; config: ServerConfig }
  | { outcome: "raced"; path: string; config: ServerConfig }
  | { outcome: "declined"; reason: string };

/**
 * Run PR A's own detection once and write a config only when it is unambiguous and safe. Never
 * called unless `shouldAttemptFirstRunFallback` already returned true — this function does not
 * re-check those four gating conditions, only the vaults/refusal shape of what `detect` finds.
 */
export async function attemptFirstRunFallback(): Promise<FirstRunFallbackResult> {
  const decision = await detect({ kind: "setup", yes: false, dryRun: false, force: false });

  if (decision.vaults.length === 0) {
    return {
      outcome: "declined",
      reason: "no Obsidian vault registry entry was found on this machine, and no vault was given",
    };
  }
  if (decision.vaults.length > 1) {
    return {
      outcome: "declined",
      reason: `${decision.vaults.length} vaults were found (${decision.vaults
        .map((v) => v.id)
        .join(", ")}) — ambiguous which one to serve, so none was auto-configured`,
    };
  }
  // Finding 4 (fix round, cross-vendor review): `decision.vaults` already dropped any registry
  // entry `isExistingDirectory` couldn't stat (an unplugged USB/NFS mount, a transient `stat`
  // failure — setup.ts's own "finding 7" comment). For the INTERACTIVE `setup` command that's
  // right: the operator sees the printed warning and can re-run once the volume is back. Here
  // there is no operator watching — silently auto-writing whichever ONE vault happened to survive
  // filtering, from a registry that actually named two, would configure the WRONG vault (or the
  // right one by accident) with nothing to flag it later. Decline instead; the registry is
  // unambiguous once every entry is reachable again.
  if (decision.registryVaultCount > 1 && decision.vaults.length === 1) {
    return {
      outcome: "declined",
      reason:
        `the Obsidian vault registry lists ${decision.registryVaultCount} vaults, but only ` +
        `${decision.vaults.map((v) => v.id).join(", ")} could be found on disk right now — ` +
        "ambiguous which one this machine should serve, so none was auto-configured",
    };
  }
  if (decision.refusal) {
    return { outcome: "declined", reason: decision.refusal };
  }

  try {
    const result = writeSetupConfig(decision.targetPath, decision, {
      force: false,
      provenance: { setupOrigin: "first-run-fallback" },
    });
    // Finding 3 (fix round, cross-vendor review): the winner used to boot straight off
    // `writeSetupConfig`'s own `ServerConfigSchema.parse(raw)` — no `applyEnvOverlays` (JWT
    // secret, plur endpoint/token), no relative-`cacheDir` home anchor, no
    // `markEmbeddingsProviderExplicit`. The RACED branch below already ran the real loader's
    // `finalizeConfig`; routing the winner through the exact same function on its own `result.raw`
    // means neither outcome can diverge from what a plain restart (`loadConfig`) would produce.
    return {
      outcome: "written",
      path: result.path,
      config: finalizeConfig(structuredClone(result.raw)),
    };
  } catch (e) {
    // Race: another process (a second MCP client starting at the same moment) already won the
    // exclusive create between `shouldAttemptFirstRunFallback`'s own `!existsSync` check and this
    // write. `writeSetupConfig`'s no-`--force` path is exclusive by construction, but on the
    // `linkSync`-unavailable fallback the target's NAME never becomes visible until the winner's
    // OWN `renameSync` — a LOSER can land here via `write.ts`'s marker-held refusal while `target`
    // still does not exist at all (finding 1, cross-vendor review: the old `existsSync(target)`
    // gate here read that as "not a race, a real failure" and rethrew immediately, instead of
    // waiting). Any `CliError` out of `writeSetupConfig`'s no-`--force` path means SOME other
    // claimant — real conflict or in-flight winner — was there first; `readRacedConfigFile`
    // retries the read for a bounded window regardless of whether `target` exists THIS moment,
    // and only a file that still doesn't parse past that window is treated as a real failure.
    if (e instanceof CliError) {
      const raw = await readRacedConfigFile(decision.targetPath);
      return { outcome: "raced", path: decision.targetPath, config: finalizeConfig(raw) };
    }
    throw e;
  }
}

/** The stderr line `serve` prints when the fallback wrote (or raced onto) a config — same
 *  pure-formatter shape as runtime/capture-first-run-notice.ts's `formatCaptureFirstRunNotice` and
 *  runtime/boot-notices.ts's other notices, so the text is unit-testable without booting a real
 *  server. Emitted directly by `run_serve` (cli.ts), not through runtime/boot-notices.ts's
 *  `emitBootNotices`: that function runs AFTER `buildServerRuntime`, once a real db/runtime
 *  exists, but this fires WHILE resolving the config that runtime is built from — before there is
 *  a runtime to hang the notice off of. */
export function formatFirstRunSetupNotice(
  result: Extract<FirstRunFallbackResult, { outcome: "written" | "raced" }>,
): string {
  const verb =
    result.outcome === "written"
      ? "wrote"
      : "found (written by another obsidian-tc process starting at the same time)";
  return (
    `obsidian-tc: no config found — auto-${verb} one at ${result.path} ` +
    `(vault: ${result.config.vaults.map((v) => `${v.id}: ${v.path}`).join(", ")}). ` +
    "Run `obsidian-tc setup` to review or change it.\n"
  );
}

/** The stderr hint appended to the "no vault or config given" error when the fallback DECLINED to
 *  write (0/>=2 vaults, or a refusal) — so the operator is told WHY nothing was auto-configured,
 *  not just that it wasn't. */
export function formatFirstRunFallbackDeclinedHint(reason: string): string {
  return `obsidian-tc: auto-setup did not run: ${reason}. Run \`obsidian-tc setup\` to configure one explicitly, or pass a vault path.\n`;
}
