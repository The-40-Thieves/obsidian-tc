// Which install would put the local embedder where obsidian-tc resolves it from, for THIS
// obsidian-tc's own layout. Pure: the one process boundary (`npm root --global`) is asked for only
// when the layout could be a global install. It lives in providers/ so the "not installed" and
// version-skew hints (local-embedder-registry.ts, doctor, boot) and setup's install offer
// (cli/setup/embedder-install.ts) all print the same command.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { version as OWN_VERSION } from "../../package.json";
import { isUnderNodeModules } from "./local-package-resolution";

export const LOCAL_EMBEDDER_PACKAGE = "@the-40-thieves/obsidian-tc-embedder-local";

/** Directories that name a package manager's own store or managed tree. An obsidian-tc under one of
 *  these is not in a project npm would install into, whatever sits above it. */
const MANAGED_STORE_SEGMENTS: ReadonlySet<string> = new Set([".pnpm", ".volta", ".bun", ".yarn"]);

export type EmbedderPackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Where obsidian-tc is installed, as far as the planner can see. An absent field is no evidence. */
export interface EmbedderInstallSite {
  /** obsidian-tc's own package directory. */
  pkgDir?: string;
  /** The invoking package manager's user agent (`npm_config_user_agent`). */
  userAgent?: string;
  /** `npm root --global` as npm reports it. The only evidence that a global install is npm's. */
  globalRoot?: string;
  exists?: (path: string) => boolean;
}

export interface EmbedderInstallPlan {
  manager: EmbedderPackageManager;
  /** Where the install runs: the project that owns obsidian-tc's node_modules. Undefined for a
   *  global install, which runs from the user's home directory (never the invoking cwd). */
  cwd?: string;
  global: boolean;
  /** Arguments for `manager`. Fixed strings plus the version constant: never user input. */
  argv: string[];
}

/** The package name at this obsidian-tc's own version: the embedder is released in lockstep, so
 *  the pin always matches the server that will load it. */
export function embedderSpec(version: string = OWN_VERSION): string {
  return `${LOCAL_EMBEDDER_PACKAGE}@${version}`;
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
export function planEmbedderInstall(
  input: EmbedderInstallSite & { version?: string },
): EmbedderInstallPlan | undefined {
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

/** The command plus the directory a project install must run in. A global install needs none. */
export function embedderInstallHint(plan: EmbedderInstallPlan): string {
  const command = embedderInstallCommand(plan);
  return plan.cwd === undefined ? command : `${command} in ${plan.cwd}`;
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

/** This process's install layout. npm's global root is asked for only when obsidian-tc sits in a
 *  node_modules directory, so a source checkout never spawns npm. */
export function currentInstallSite(): EmbedderInstallSite {
  const pkgDir = ownPackageDir();
  const inNodeModules = pkgDir !== undefined && /[\\/]node_modules[\\/]obsidian-tc$/.test(pkgDir);
  return {
    pkgDir,
    userAgent: process.env.npm_config_user_agent,
    globalRoot: inNodeModules ? npmGlobalRoot() : undefined,
  };
}
