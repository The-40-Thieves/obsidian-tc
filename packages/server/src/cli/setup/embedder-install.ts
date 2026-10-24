// The local embedder is an explicit install, not an optionalDependency of obsidian-tc (owner
// decision, 2026-10): `obsidian-tc setup` offers to run it. This module is the pure half — which
// package manager and which prefix an install would use — plus the one process boundary that runs
// it. Setup injects both (cli/commands/setup.ts), so tests never run a real install.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { version as OWN_VERSION } from "../../../package.json";
import { LOCAL_EMBEDDER_PACKAGE } from "../../providers/local-embedder-registry";
import type { Cmd } from "../shared";

export const EMBEDDER_PACKAGE = LOCAL_EMBEDDER_PACKAGE;

export type EmbedderPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface EmbedderInstallPlan {
  manager: EmbedderPackageManager;
  /** Where the install runs: the project that owns obsidian-tc's node_modules. Undefined for a
   *  global install, which needs no cwd. */
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

/**
 * Which install would put the embedder where obsidian-tc resolves it from. `pkgDir` is obsidian-tc's
 * own package directory; a plain `<prefix>/node_modules/obsidian-tc` layout is the only one trusted.
 * A project prefix (package.json above node_modules) installs locally in that project; a prefix
 * without one is npm's global root and installs globally. Anything else (a pnpm store path, a
 * source checkout, a standalone binary) returns undefined, and the caller prints the command.
 */
export function planEmbedderInstall(input: {
  version?: string;
  pkgDir?: string;
  userAgent?: string;
  exists?: (path: string) => boolean;
}): EmbedderInstallPlan | undefined {
  const { pkgDir } = input;
  const exists = input.exists ?? existsSync;
  const spec = embedderSpec(input.version);
  if (pkgDir === undefined || !pkgDir.endsWith(join("node_modules", "obsidian-tc"))) {
    return undefined;
  }
  const prefix = dirname(dirname(pkgDir));
  const invoking = managerFromUserAgent(input.userAgent);
  if (exists(join(prefix, "package.json"))) {
    const manager =
      invoking ?? LOCKFILE_MANAGERS.find(([file]) => exists(join(prefix, file)))?.[1] ?? "npm";
    return { manager, cwd: prefix, global: false, argv: localArgv(manager, spec) };
  }
  // No package.json above node_modules: npm's global root (`<prefix>/lib/node_modules` or
  // `%APPDATA%\npm\node_modules`). Only npm's global layout is recognised.
  if (invoking !== undefined && invoking !== "npm") return undefined;
  return { manager: "npm", global: true, argv: ["install", "--global", spec] };
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

/** The manual command printed when no plan can be determined: npm's local form. */
export function manualEmbedderInstallCommand(): string {
  return `npm install --save-exact ${embedderSpec()}`;
}

/** Runs a plan with an argument array. Windows needs a shell to find the `.cmd` shim; every argument
 *  is a fixed string from this module, so the shell never sees input from a user or a file. */
export function runEmbedderInstall(plan: EmbedderInstallPlan): EmbedderInstallResult {
  const r = spawnSync(plan.manager, plan.argv, {
    ...(plan.cwd !== undefined ? { cwd: plan.cwd } : {}),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: `${plan.manager} exited with status ${r.status}` };
  return { ok: true };
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
  /** Default: planEmbedderInstall over this obsidian-tc's own location and the invoking manager. */
  plan?: () => EmbedderInstallPlan | undefined;
  run?: (plan: EmbedderInstallPlan) => EmbedderInstallResult;
}

/** The yes/no prompt for the install. Enter means yes: the question is `[Y/n]`. */
async function confirmEmbedderInstall(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return !/^n(o)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** The prompt policy around the install plan. An install runs only when setup can actually ask;
 *  every other path prints the exact command and runs nothing. A failed or declined install returns
 *  false, and detect() then keeps setup's existing local-anyway fallback. */
export function embedderInstallOffer(
  cmd: Cmd<"setup">,
  deps: SetupEmbedderInstallDeps,
): () => Promise<boolean> {
  const interactive = deps.interactive ?? (process.stdin.isTTY === true && !cmd.yes && !cmd.dryRun);
  const ask = deps.ask ?? confirmEmbedderInstall;
  const plan =
    deps.plan ??
    (() =>
      planEmbedderInstall({
        pkgDir: ownPackageDir(),
        userAgent: process.env.npm_config_user_agent,
      }));
  const run = deps.run ?? runEmbedderInstall;
  return async () => {
    const resolved = plan();
    const command = resolved ? embedderInstallCommand(resolved) : manualEmbedderInstallCommand();
    if (!interactive || resolved === undefined) {
      process.stdout.write(
        `obsidian-tc setup: ${EMBEDDER_PACKAGE} is not installed. Install it with: ${command}\n`,
      );
      return false;
    }
    if (!(await ask(`Install ${embedderSpec()} now? [Y/n] `))) {
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
    return true;
  };
}
