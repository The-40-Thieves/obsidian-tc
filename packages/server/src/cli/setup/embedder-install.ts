// The local embedder is an explicit install, not an optionalDependency of obsidian-tc (owner
// decision, 2026-10): `obsidian-tc setup` offers to run it. The planner (which package manager and
// which prefix an install would use) lives in providers/embedder-install-plan.ts, shared with the
// doctor and boot hints. This module is the one process boundary that runs a plan, plus the prompt
// policy around it. Setup injects both (cli/commands/setup.ts), so tests never run a real install.
import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import * as readline from "node:readline/promises";
import {
  currentInstallSite,
  type EmbedderInstallPlan,
  embedderInstallCommand,
  embedderInstallHint,
  embedderSpec,
  invocationFor,
  LOCAL_EMBEDDER_PACKAGE,
  ownPackageDir,
  planEmbedderInstall,
} from "../../providers/embedder-install-plan";
import { localEmbedderInstallHint } from "../../providers/local-embedder-registry";
import type { Cmd } from "../shared";

export const EMBEDDER_PACKAGE = LOCAL_EMBEDDER_PACKAGE;

/** A hung registry fetch must not hang setup: the install is killed after this long. */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export type EmbedderInstallResult = { ok: true } | { ok: false; error: string };

/** The `spawnSync` surface the runner uses, injectable so tests never spawn. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => { status: number | null; signal: NodeJS.Signals | null; error?: Error };

/** Runs a plan. A local plan runs in its project; a global one from the home directory. Signals and
 *  timeouts are reported as such, never as a bare "status null". */
export function runEmbedderInstall(
  plan: EmbedderInstallPlan,
  deps: { spawn?: SpawnFn; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): EmbedderInstallResult {
  const inv = invocationFor(plan.manager, plan.argv, { env: deps.env, platform: deps.platform });
  const spawn: SpawnFn = deps.spawn ?? ((c, a, o) => spawnSync(c, a, o));
  const r = spawn(inv.command, inv.args, {
    cwd: plan.cwd ?? homedir(),
    stdio: "inherit",
    timeout: INSTALL_TIMEOUT_MS,
    shell: inv.shell,
  });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.signal) return { ok: false, error: `${plan.manager} was killed by ${r.signal}` };
  if (r.status !== 0) return { ok: false, error: `${plan.manager} exited with status ${r.status}` };
  return { ok: true };
}

/**
 * Whether a FRESH Node process can load the embedder from obsidian-tc's own location. Bun caches a
 * failed dynamic import for the life of the process, so the in-process probe cannot see an install
 * made a moment ago; a child process can. Run from the package directory, so resolution walks up
 * to the same node_modules a local or global install writes into.
 */
export function verifyEmbedderInstalled(pkgDir: string | undefined): boolean {
  if (pkgDir === undefined) return false;
  const script = `import(${JSON.stringify(EMBEDDER_PACKAGE)}).then(() => process.exit(0), () => process.exit(1))`;
  const r = spawnSync(process.execPath, ["-e", script], {
    cwd: pkgDir,
    stdio: "ignore",
    timeout: 60_000,
  });
  return r.status === 0;
}

/** Injection points for the embedder install offer. Every field defaults to the real behaviour;
 *  tests pass their own so no run ever shells out to a real package manager. */
export interface SetupEmbedderInstallDeps {
  /** Default: stdin is a TTY and neither --yes nor --dry-run was given. */
  interactive?: boolean;
  ask?: (question: string) => Promise<boolean>;
  /** Default: planEmbedderInstall over this obsidian-tc's own install layout (currentInstallSite). */
  plan?: () => EmbedderInstallPlan | undefined;
  run?: (plan: EmbedderInstallPlan) => EmbedderInstallResult;
  /** Default: verifyEmbedderInstalled in a child process. */
  verify?: () => boolean;
}

/** Only an explicit yes, or Enter on its own, installs. Everything else (including "nope") is no. */
export function isYesAnswer(answer: string): boolean {
  return /^(y|yes)?$/i.test(answer.trim());
}

/** The yes/no prompt for the install. Enter means yes: the question is `[Y/n]`. Ctrl-D (the input
 *  closing mid-question) is a no. */
async function confirmEmbedderInstall(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return isYesAnswer(await rl.question(question));
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

/** The prompt policy around the install plan. An install runs only when setup can actually ask;
 *  every other path prints the exact command and runs nothing. Returns true only when the install
 *  ran AND a fresh process can load the package; anything else keeps setup's local-anyway fallback. */
export function embedderInstallOffer(
  cmd: Cmd<"setup">,
  deps: SetupEmbedderInstallDeps,
): () => Promise<boolean> {
  const interactive = deps.interactive ?? (process.stdin.isTTY === true && !cmd.yes && !cmd.dryRun);
  const ask = deps.ask ?? confirmEmbedderInstall;
  const pkgDir = ownPackageDir();
  const plan = deps.plan ?? (() => planEmbedderInstall(currentInstallSite()));
  const run = deps.run ?? ((p: EmbedderInstallPlan) => runEmbedderInstall(p));
  const verify = deps.verify ?? (() => verifyEmbedderInstalled(pkgDir));
  return async () => {
    const resolved = plan();
    if (!interactive || resolved === undefined) {
      const command = resolved ? embedderInstallHint(resolved) : localEmbedderInstallHint();
      process.stdout.write(
        `obsidian-tc setup: ${EMBEDDER_PACKAGE} is not installed. Install it with: ${command}\n`,
      );
      return false;
    }
    const command = embedderInstallCommand(resolved);
    const hint = embedderInstallHint(resolved);
    // A global plan runs from the home directory, so its prompt names no directory.
    const where = resolved.cwd === undefined ? "" : ` in ${resolved.cwd}`;
    if (!(await ask(`Install ${embedderSpec()} now by running \`${command}\`${where}? [Y/n] `))) {
      process.stdout.write(`obsidian-tc setup: not installed. Install it later with: ${hint}\n`);
      return false;
    }
    const result = run(resolved);
    if (!result.ok) {
      process.stderr.write(
        `obsidian-tc setup: installing ${embedderSpec()} failed (${result.error}). Run it by hand: ${hint}\n`,
      );
      return false;
    }
    if (!verify()) {
      process.stderr.write(
        `obsidian-tc setup: ${embedderSpec()} was installed, but this Node cannot load it yet. Re-run obsidian-tc setup in a new process.\n`,
      );
      return false;
    }
    return true;
  };
}
