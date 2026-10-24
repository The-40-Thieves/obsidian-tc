// The local embedder is an explicit install, not an optionalDependency of obsidian-tc (owner
// decision, 2026-10): `obsidian-tc setup` offers to run it. This module is the pure half — which
// package manager and which prefix an install would use — plus the one process boundary that runs
// it. Setup injects both (cli/commands/setup.ts), so tests never run a real install.
import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { version as OWN_VERSION } from "../../../package.json";
import {
  LOCAL_EMBEDDER_PACKAGE,
  localEmbedderInstallHint,
} from "../../providers/local-embedder-registry";
import { isUnderNodeModules } from "../../providers/local-package-resolution";
import type { Cmd } from "../shared";

export const EMBEDDER_PACKAGE = LOCAL_EMBEDDER_PACKAGE;

/** A hung registry fetch must not hang setup: the install is killed after this long. */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Directories that name a package manager's own store or managed tree. An obsidian-tc under one of
 *  these is not in a project npm would install into, whatever sits above it. */
const MANAGED_STORE_SEGMENTS: ReadonlySet<string> = new Set([".pnpm", ".volta", ".bun", ".yarn"]);

export type EmbedderPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface EmbedderInstallPlan {
  manager: EmbedderPackageManager;
  /** Where the install runs: the project that owns obsidian-tc's node_modules. Undefined for a
   *  global install, which runs from the user's home directory (never the invoking cwd). */
  cwd?: string;
  global: boolean;
  /** Arguments for `manager`. Fixed strings plus the version constant: never user input. */
  argv: string[];
}

export type EmbedderInstallResult = { ok: true } | { ok: false; error: string };

/** The package name at this obsidian-tc's own version: the embedder is released in lockstep, so
 *  the pin always matches the server that will load it. */
export function embedderSpec(version: string = OWN_VERSION): string {
  return `${EMBEDDER_PACKAGE}@${version}`;
}

const LOCKFILE_MANAGERS: ReadonlyArray<[string, EmbedderPackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

function managerFromUserAgent(userAgent: string | undefined): EmbedderPackageManager | undefined {
  const name = userAgent?.split("/")[0];
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : undefined;
}

/** Windows separators select node:path's win32 flavour, so a Windows layout is planned the same
 *  way on any host (the tests run on Linux). */
function pathApiFor(p: string): typeof posix {
  return p.includes("\\") ? (win32 as typeof posix) : posix;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
}

/**
 * Which install would put the embedder where obsidian-tc resolves it from. `pkgDir` is obsidian-tc's
 * own package directory. Three layouts are planned, and everything else returns undefined (the
 * caller prints the command and runs nothing):
 *  - a global install, only when npm itself reports `globalRoot` as its global root and obsidian-tc
 *    sits directly in it (positive evidence: a Volta image, a pnpm global tree or a guessed prefix
 *    never matches);
 *  - a project install: `<prefix>/node_modules/obsidian-tc` with a package.json at `<prefix>`, run in
 *    that project;
 *  - nothing else: a package-manager store, a dependency nested under another node_modules (its
 *    package.json is not the user's), a source checkout, a standalone binary.
 */
export function planEmbedderInstall(input: {
  version?: string;
  pkgDir?: string;
  userAgent?: string;
  /** `npm root --global` as npm reports it. The only evidence that a global install is npm's. */
  globalRoot?: string;
  exists?: (path: string) => boolean;
}): EmbedderInstallPlan | undefined {
  const { pkgDir, globalRoot } = input;
  if (pkgDir === undefined) return undefined;
  const segments = pkgDir.split(/[\\/]/);
  if (segments.at(-1) !== "obsidian-tc" || segments.at(-2) !== "node_modules") return undefined;
  if (segments.some((s) => MANAGED_STORE_SEGMENTS.has(s))) return undefined;

  const path = pathApiFor(pkgDir);
  const invoking = managerFromUserAgent(input.userAgent);
  const parent = path.dirname(pkgDir);
  if (globalRoot !== undefined && samePath(parent, globalRoot)) {
    if (invoking !== undefined && invoking !== "npm") return undefined;
    return {
      manager: "npm",
      global: true,
      argv: ["install", "--global", embedderSpec(input.version)],
    };
  }

  const prefix = path.dirname(parent);
  // A prefix under node_modules is a dependency's own package: installing there rewrites its
  // package.json, not the user's.
  if (isUnderNodeModules(prefix)) return undefined;
  const exists = input.exists ?? existsSync;
  if (!exists(path.join(prefix, "package.json"))) return undefined;
  const spec = embedderSpec(input.version);
  const manager =
    invoking ?? LOCKFILE_MANAGERS.find(([file]) => exists(path.join(prefix, file)))?.[1] ?? "npm";
  return { manager, cwd: prefix, global: false, argv: localArgv(manager, spec) };
}

function localArgv(manager: EmbedderPackageManager, spec: string): string[] {
  switch (manager) {
    case "npm":
      return ["install", "--save-exact", spec];
    case "pnpm":
      return ["add", "--save-exact", spec];
    case "yarn":
    case "bun":
      return ["add", "--exact", spec];
  }
}

/** The command a user would type, for printing. Matches what the plan runs. */
export function embedderInstallCommand(plan: EmbedderInstallPlan): string {
  return [plan.manager, ...plan.argv].join(" ");
}

/** How one manager's argv is spawned. npm runs its own JS entry (`npm_execpath`) through
 *  process.execPath with no shell, which is how Windows is handled too (the same approach as
 *  packages/native/scripts/lib/napi-invocation.mjs). Without that entry, Windows gets ONE pre-joined
 *  command string and no args array: `shell: true` with an args array is DEP0190 on every Windows
 *  install. Every string here is a fixed value from this module, never user input. */
export function invocationFor(
  manager: EmbedderPackageManager,
  argv: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    execPath?: string;
  } = {},
): { command: string; args: string[]; shell: boolean } {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const npmCli = env.npm_execpath;
  if (manager === "npm" && npmCli?.endsWith("npm-cli.js")) {
    return { command: execPath, args: [npmCli, ...argv], shell: false };
  }
  if (platform === "win32") {
    return { command: [manager, ...argv].join(" "), args: [], shell: true };
  }
  return { command: manager, args: argv, shell: false };
}

/** The `spawnSync` surface the runner uses, injectable so tests never spawn. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => { status: number | null; signal: NodeJS.Signals | null; error?: Error };

/** `npm root --global` as npm reports it, or undefined when npm cannot say. */
export function npmGlobalRoot(): string | undefined {
  const inv = invocationFor("npm", ["root", "--global"]);
  const r = spawnSync(inv.command, inv.args, {
    cwd: homedir(),
    encoding: "utf8",
    shell: inv.shell,
    timeout: 60_000,
  });
  const root = r.status === 0 ? String(r.stdout).trim() : "";
  return root === "" ? undefined : root;
}

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

/** obsidian-tc's own package directory, found from this module's compiled or source location. */
export function ownPackageDir(moduleUrl: string = import.meta.url): string | undefined {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
      if (name === "obsidian-tc") return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Injection points for the embedder install offer. Every field defaults to the real behaviour;
 *  tests pass their own so no run ever shells out to a real package manager. */
export interface SetupEmbedderInstallDeps {
  /** Default: stdin is a TTY and neither --yes nor --dry-run was given. */
  interactive?: boolean;
  ask?: (question: string) => Promise<boolean>;
  /** Default: planEmbedderInstall over this obsidian-tc's own location, the invoking manager and
   *  npm's own global root. */
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
  const plan =
    deps.plan ??
    (() =>
      planEmbedderInstall({
        pkgDir,
        userAgent: process.env.npm_config_user_agent,
        globalRoot: npmGlobalRoot(),
      }));
  const run = deps.run ?? ((p: EmbedderInstallPlan) => runEmbedderInstall(p));
  const verify = deps.verify ?? (() => verifyEmbedderInstalled(pkgDir));
  return async () => {
    const resolved = plan();
    if (!interactive || resolved === undefined) {
      const command = resolved ? embedderInstallCommand(resolved) : localEmbedderInstallHint();
      process.stdout.write(
        `obsidian-tc setup: ${EMBEDDER_PACKAGE} is not installed. Install it with: ${command}\n`,
      );
      return false;
    }
    const command = embedderInstallCommand(resolved);
    const where = resolved.global ? "from your home directory" : `in ${resolved.cwd}`;
    if (!(await ask(`Install ${embedderSpec()} now by running \`${command}\` ${where}? [Y/n] `))) {
      process.stdout.write(`obsidian-tc setup: not installed. Install it later with: ${command}\n`);
      return false;
    }
    const result = run(resolved);
    if (!result.ok) {
      process.stderr.write(
        `obsidian-tc setup: installing ${embedderSpec()} failed (${result.error}). Run it by hand: ${command}\n`,
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
