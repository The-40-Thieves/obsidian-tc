import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { GitSyncConfig } from "./env";
import { createGitRunner, type GitExecutor, type GitRunner } from "./git";
import { DEFAULT_GIT_SYNC_TIMINGS, type GitSyncTimings, runGitSyncLoop } from "./loop";
import { StatusStore } from "./status";
import { GitSync, type SyncLogger } from "./sync";

export interface GitSyncOptions extends Partial<GitSyncTimings> {
  executor?: GitExecutor;
  logger?: SyncLogger;
  createCloneStagingDirectory?: (prefix: string) => Promise<string>;
  /** Aborts every git command the boot runs; an aborted boot rejects and leaves no staging directory. */
  signal?: AbortSignal;
}

async function containsFile(path: string): Promise<boolean> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (!entry.isDirectory()) return true;
    if (await containsFile(child)) return true;
  }
  return false;
}

function comparableUrl(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

function cloneArgs(config: GitSyncConfig, destination: string): string[] {
  const args = ["clone", "--no-checkout", "--no-recurse-submodules"];
  if (config.branch) args.push("--branch", config.branch, "--single-branch");
  args.push("--", config.url, destination);
  return args;
}

function hasFilesystemCode(error: unknown, codes: readonly string[]): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && codes.includes(code);
}

async function restoreEmptyDirectories(root: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) await mkdir(join(root, path), { recursive: true });
}

async function removeEmptyDirectories(root: string, paths: readonly string[]): Promise<void> {
  const removed: string[] = [];
  try {
    for (const path of [...paths].reverse()) {
      await rmdir(join(root, path));
      removed.push(path);
    }
  } catch (error) {
    await restoreEmptyDirectories(root, removed.reverse());
    throw error;
  }
}

async function cloneDirectlyIntoEmptyTree(
  config: GitSyncConfig,
  runner: GitRunner,
  physicalVault: string,
  emptyDirectories: readonly string[],
): Promise<void> {
  let trackedPaths: string[] = [];
  await removeEmptyDirectories(physicalVault, emptyDirectories);
  try {
    await runner.run(cloneArgs(config, physicalVault), physicalVault);
    trackedPaths = (await runner.run(["ls-files", "-z"], physicalVault))
      .split("\0")
      .filter(Boolean);
    await runner.run(["reset", "--hard", "HEAD"], physicalVault);
    await restoreEmptyDirectories(physicalVault, emptyDirectories);
  } catch (error) {
    for (const path of trackedPaths.sort((left, right) => right.length - left.length)) {
      await rm(join(physicalVault, path), { recursive: true, force: true });
    }
    const createdDirectories = new Set<string>();
    for (const path of trackedPaths) {
      let parent = dirname(path);
      while (parent !== ".") {
        createdDirectories.add(parent);
        parent = dirname(parent);
      }
    }
    for (const path of [...createdDirectories].sort((left, right) => right.length - left.length)) {
      try {
        await rmdir(join(physicalVault, path));
      } catch (cleanupError) {
        if (!hasFilesystemCode(cleanupError, ["ENOENT", "ENOTEMPTY"])) throw cleanupError;
      }
    }
    await rm(join(physicalVault, ".git"), { recursive: true, force: true });
    await restoreEmptyDirectories(physicalVault, emptyDirectories);
    throw error;
  }
}

async function cloneIntoEmptyTree(
  config: GitSyncConfig,
  runner: GitRunner,
  createStagingDirectory: (prefix: string) => Promise<string>,
): Promise<void> {
  const physicalVault = await realpath(config.vaultDir);
  const emptyDirectories = await listEmptyDirectories(physicalVault);
  const parent = dirname(physicalVault);
  let mounted = false;
  try {
    mounted = (await stat(physicalVault)).dev !== (await stat(parent)).dev;
  } catch (error) {
    if (!hasFilesystemCode(error, ["EACCES", "EPERM"])) throw error;
    mounted = true;
  }
  if (mounted) {
    await cloneDirectlyIntoEmptyTree(config, runner, physicalVault, emptyDirectories);
    return;
  }
  let temporary: string;
  try {
    temporary = await createStagingDirectory(
      join(parent, `.${basename(physicalVault)}.git-sync-clone-`),
    );
  } catch (error) {
    if (!hasFilesystemCode(error, ["EXDEV", "EBUSY", "EACCES", "EPERM", "EROFS"])) throw error;
    await cloneDirectlyIntoEmptyTree(config, runner, physicalVault, emptyDirectories);
    return;
  }
  try {
    await runner.run(cloneArgs(config, temporary), parent);
    await runner.run(["reset", "--hard", "HEAD"], temporary);
    for (const path of emptyDirectories) await mkdir(join(temporary, path), { recursive: true });
    await removeEmptyDirectories(physicalVault, emptyDirectories);
    try {
      await rename(temporary, physicalVault);
      return;
    } catch (error) {
      if (hasFilesystemCode(error, ["EXDEV", "EBUSY", "EACCES", "EPERM"])) {
        await restoreEmptyDirectories(physicalVault, emptyDirectories);
        await cloneDirectlyIntoEmptyTree(config, runner, physicalVault, emptyDirectories);
        return;
      }
      // Windows cannot replace an existing empty directory atomically. Its fallback still installs
      // .git last and rolls back every created entry if an ordinary filesystem operation fails.
    }
    const installed: string[] = [];
    try {
      await installCloneTree(temporary, physicalVault, installed);
      await rename(join(temporary, ".git"), join(physicalVault, ".git"));
    } catch (error) {
      const retryDirectly = hasFilesystemCode(error, ["EXDEV", "EBUSY", "EACCES", "EPERM"]);
      for (const path of installed.reverse()) await rm(path, { recursive: true, force: true });
      await restoreEmptyDirectories(physicalVault, emptyDirectories);
      if (retryDirectly) {
        await cloneDirectlyIntoEmptyTree(config, runner, physicalVault, emptyDirectories);
        return;
      }
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function listEmptyDirectories(root: string, current = root): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (!entry.isDirectory()) throw new Error(`git-sync refuses non-empty directory ${root}`);
    const child = join(current, entry.name);
    paths.push(child.slice(root.length + 1));
    paths.push(...(await listEmptyDirectories(root, child)));
  }
  return paths;
}

async function installCloneTree(
  source: string,
  destination: string,
  installed: string[],
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory() && existsSync(to) && (await lstat(to)).isDirectory()) {
      await installCloneTree(from, to, installed);
      continue;
    }
    if (existsSync(to)) throw new Error(`git-sync clone collided with ${to}`);
    await rename(from, to);
    installed.push(to);
  }
}

async function ensureVaultDirectory(path: string): Promise<void> {
  try {
    const link = await lstat(path);
    const info = link.isSymbolicLink() ? await stat(path) : link;
    if (!info.isDirectory()) throw new Error(`git-sync refuses non-directory vault path ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (existsSync(dirname(path))) {
      try {
        if ((await lstat(path)).isSymbolicLink()) {
          throw new Error(`git-sync refuses non-directory vault path ${path}`);
        }
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
      }
    }
    await mkdir(path, { recursive: true });
  }
}

function exactRepositoryArgs(config: GitSyncConfig, args: string[]): string[] {
  return [`--git-dir=${join(config.vaultDir, ".git")}`, `--work-tree=${config.vaultDir}`, ...args];
}

async function selectBranch(
  config: GitSyncConfig,
  runner: GitRunner,
  newlyCloned: boolean,
): Promise<string> {
  let current = (await runner.run(["branch", "--show-current"])).trim();
  if (!config.branch || current === config.branch) {
    if (!current) throw new Error(`git-sync refuses detached repository in ${config.vaultDir}`);
    return current;
  }
  if (newlyCloned) throw new Error(`git-sync did not clone requested branch in ${config.vaultDir}`);
  await runner.run([
    "fetch",
    "--no-recurse-submodules",
    "--",
    config.url,
    `+refs/heads/${config.branch}:refs/remotes/origin/${config.branch}`,
  ]);
  const local = await runner.tryRun(["show-ref", "--verify", "--", `refs/heads/${config.branch}`]);
  if (local.ok) await runner.run(["checkout", config.branch]);
  else await runner.run(["checkout", "--track", "-b", config.branch, `origin/${config.branch}`]);
  current = (await runner.run(["branch", "--show-current"])).trim();
  return current;
}

export async function bootGitSync(
  config: GitSyncConfig,
  options: GitSyncOptions = {},
): Promise<GitSync & { run(signal: AbortSignal): Promise<void> }> {
  const logger = options.logger ?? ((line: string) => process.stderr.write(`${line}\n`));
  await ensureVaultDirectory(config.vaultDir);
  const gitPath = join(config.vaultDir, ".git");
  if (!existsSync(gitPath) && (await containsFile(config.vaultDir))) {
    throw new Error(`git-sync refuses non-empty directory ${config.vaultDir}`);
  }
  if (existsSync(gitPath) && !(await lstat(gitPath)).isDirectory()) {
    throw new Error(`git-sync refuses invalid repository in ${config.vaultDir}`);
  }
  if (
    existsSync(gitPath) &&
    (!existsSync(join(gitPath, "HEAD")) || !existsSync(join(gitPath, "config")))
  ) {
    throw new Error(`git-sync refuses invalid repository in ${config.vaultDir}`);
  }

  const runner = await createGitRunner(config, options.executor, options.signal);
  const status = new StatusStore(config.stateDir);
  await status.initialize();
  let newlyCloned = false;
  if (existsSync(gitPath)) {
    const valid = await runner.tryRun(
      exactRepositoryArgs(config, ["rev-parse", "--is-inside-work-tree"]),
    );
    if (!valid.ok || valid.stdout.trim() !== "true") {
      throw new Error(`git-sync refuses invalid repository in ${config.vaultDir}`);
    }
    const originResult = await runner.tryRun(
      exactRepositoryArgs(config, ["remote", "get-url", "--", "origin"]),
    );
    if (!originResult.ok) {
      throw new Error(`git-sync refuses invalid repository in ${config.vaultDir}`);
    }
    const origin = originResult.stdout.trim();
    if (comparableUrl(origin) !== comparableUrl(config.url)) {
      throw new Error(`git-sync refuses repository with a different origin in ${config.vaultDir}`);
    }
    logger(`[git-sync] boot existing=${config.vaultDir}`);
  } else {
    await cloneIntoEmptyTree(config, runner, options.createCloneStagingDirectory ?? mkdtemp);
    newlyCloned = true;
    logger(`[git-sync] boot cloned=${config.vaultDir}`);
  }

  if (!newlyCloned && config.branch) {
    const current = (await runner.run(["branch", "--show-current"])).trim();
    // A detached HEAD (current is "") is not the requested branch either: checking it out would
    // overwrite a dirty tree just the same.
    if (current !== config.branch) {
      const dirty = await runner.run([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
      ]);
      if (dirty) {
        const message = current
          ? `git-sync refuses to switch dirty branch ${current} to ${config.branch}`
          : `git-sync refuses to switch dirty detached HEAD to ${config.branch}`;
        await status.update({ lastError: message });
        logger(`[git-sync] error ${message}`);
        throw new Error(message);
      }
    }
  }
  const branch = await selectBranch(config, runner, newlyCloned);
  const head = (await runner.run(["rev-parse", "HEAD"])).trim();
  await status.update({ head, lastError: null });
  const timings: GitSyncTimings = { ...DEFAULT_GIT_SYNC_TIMINGS, ...options };
  // Only boot's own git commands abort with the signal. The sync loop keeps a runner without it, so a
  // SIGTERM lets an in-flight pull or push finish (the loop stops at its next tick instead).
  const loopRunner = options.signal ? await createGitRunner(config, options.executor) : runner;
  const sync = new GitSync(config, loopRunner, status, branch, logger);
  if (!newlyCloned) await sync.syncOnce();
  return Object.assign(sync, {
    run(signal: AbortSignal) {
      return runGitSyncLoop(sync, signal, timings);
    },
  });
}
