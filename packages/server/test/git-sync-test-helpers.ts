import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir } from "./tmp";

export interface GitFixture {
  root: string;
  origin: string;
  url: string;
  laptop: string;
  vault: string;
  cache: string;
}

let isolatedGitState: { home: string; global: string } | undefined;

// Created on first use, never at import: a suite the platform skips (win32) never calls git(), so it
// makes no directory and the per-file teardown has nothing to leak.
function isolatedGit(): { home: string; global: string } {
  if (!isolatedGitState) {
    const home = makeTempDir("obtc-git-home-");
    const global = join(home, "global.gitconfig");
    writeFileSync(global, "");
    isolatedGitState = { home, global };
  }
  return isolatedGitState;
}

export function git(cwd: string, args: string[]): string {
  const { home, global: globalConfig } = isolatedGit();
  return execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_TERMINAL_PROMPT: "0",
      HOME: home,
      XDG_CONFIG_HOME: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: stallTimeout(30_000),
  }).trim();
}

export function gitSubcommand(args: string[]): string | undefined {
  let index = 0;
  while (args[index] === "-c") index += 2;
  while (args[index]?.startsWith("--git-dir=") || args[index]?.startsWith("--work-tree=")) {
    index += 1;
  }
  return args[index];
}

export function configureAuthor(cwd: string, author = "Laptop User <laptop@example.test>"): void {
  const match = /^(.*) <([^<>]+)>$/.exec(author);
  if (!match) throw new Error(`bad test author: ${author}`);
  git(cwd, ["config", "user.name", match[1] ?? ""]);
  git(cwd, ["config", "user.email", match[2] ?? ""]);
}

export function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message]);
}

export function makeGitFixture(seed = "seed\n"): GitFixture {
  const root = makeTempDir("obtc-git-sync-");
  const origin = join(root, "origin.git");
  const laptop = join(root, "laptop");
  const vault = join(root, "vault");
  const cache = join(root, "cache");
  mkdirSync(origin);
  git(origin, ["init", "--bare", "--initial-branch=main"]);
  git(root, ["clone", `file://${origin}`, laptop]);
  configureAuthor(laptop);
  writeFileSync(join(laptop, "a.md"), seed);
  commitAll(laptop, "seed");
  git(laptop, ["push", "-u", "origin", "main"]);
  return { root, origin, url: `file://${origin}`, laptop, vault, cache };
}

export function syncEnv(
  fixture: Pick<GitFixture, "url" | "vault" | "cache">,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    OBSIDIAN_TC_VAULT_GIT_URL: fixture.url,
    OBSIDIAN_TC_VAULT_GIT_BRANCH: "main",
    OBSIDIAN_TC_VAULT_GIT_AUTHOR: "Vault Bot <vault@example.test>",
    OBSIDIAN_TC_VAULT_GIT_PULL_INTERVAL: "60",
    OBSIDIAN_TC_VAULT_GIT_PUSH: "batched",
    OBSIDIAN_TC_VAULT_PATH: fixture.vault,
    OBSIDIAN_TC_CACHE_DIR: fixture.cache,
    ...extra,
  };
}

export function installRejectingHook(fixture: GitFixture, mode: "once" | "main-always"): string {
  const hook = join(fixture.origin, "hooks", "pre-receive");
  const marker = join(fixture.root, "hook-marker");
  const body =
    mode === "once"
      ? `#!/bin/sh\nif [ ! -e '${marker}' ]; then touch '${marker}'; exit 1; fi\nexit 0\n`
      : `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ]; then exit 1; fi\ndone\nexit 0\n`;
  writeFileSync(hook, body);
  chmodSync(hook, 0o755);
  return marker;
}

export async function waitFor(check: () => boolean, limitMs = 2_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
