import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildSshCommand, type GitSyncConfig } from "./env";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

export interface GitInvocation {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type GitExecutor = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding & { env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export class GitCommandError extends Error {
  readonly stderr: string;
  readonly exitCode?: number;

  constructor(message: string, stderr: string, exitCode?: number) {
    super(message);
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export interface GitRunner {
  run(args: string[], cwd?: string): Promise<string>;
  tryRun(
    args: string[],
    cwd?: string,
  ): Promise<{ ok: boolean; stdout: string; error?: GitCommandError }>;
  redact(value: unknown): string;
}

function fixedEnvironment(config: GitSyncConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(config.stateDir, "global.gitconfig"),
    HOME: config.stateDir,
    LANG: "C",
    LC_ALL: "C",
    GIT_AUTHOR_NAME: config.authorName,
    GIT_AUTHOR_EMAIL: config.authorEmail,
    GIT_COMMITTER_NAME: config.authorName,
    GIT_COMMITTER_EMAIL: config.authorEmail,
  };
  if (config.urlKind === "ssh") env.GIT_SSH_COMMAND = buildSshCommand(config);
  if (config.urlKind === "https") {
    env.GIT_ASKPASS = config.askpassPath;
    env.GIT_ASKPASS_REQUIRE = "force";
    env.OBSIDIAN_TC_GIT_TOKEN = config.token;
  }
  return env;
}

async function prepareCredentialFiles(config: GitSyncConfig): Promise<void> {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await chmod(config.stateDir, 0o700);
  await atomicWrite(join(config.stateDir, "global.gitconfig"), "", 0o600);
  if (config.urlKind === "ssh") {
    const key = config.sshKey ?? "";
    await atomicWrite(config.sshKeyPath, key.endsWith("\n") ? key : `${key}\n`, 0o600);
    await atomicWrite(config.knownHostsPath, config.knownHosts ?? "", 0o600);
  }
  if (config.urlKind === "https") {
    const script =
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" x-access-token ;;\n' +
      '  *) printf "%s\\n" "$OBSIDIAN_TC_GIT_TOKEN" ;;\nesac\n';
    await atomicWrite(config.askpassPath, script, 0o700);
  }
}

export async function atomicWrite(path: string, contents: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

function errorParts(error: unknown): {
  message: string;
  stderr: string;
  stdout: string;
  code?: number;
} {
  if (!(error instanceof Error)) {
    return { message: String(error), stderr: String(error), stdout: "" };
  }
  const value = error as Error & {
    stderr?: string | Buffer;
    stdout?: string | Buffer;
    code?: number | string;
  };
  const stderr = value.stderr === undefined ? "" : String(value.stderr);
  const stdout = value.stdout === undefined ? "" : String(value.stdout);
  const code = typeof value.code === "number" ? value.code : undefined;
  return { message: error.message, stderr, stdout, ...(code !== undefined ? { code } : {}) };
}

export async function createGitRunner(
  config: GitSyncConfig,
  executor: GitExecutor = execFileAsync as GitExecutor,
  signal?: AbortSignal,
): Promise<GitRunner> {
  await prepareCredentialFiles(config);
  const env = fixedEnvironment(config);
  const transport =
    config.urlKind === "ssh" ? "ssh" : config.urlKind === "https" ? "https" : "file";
  const fixedArgs = [
    "-c",
    "protocol.allow=never",
    "-c",
    `protocol.${transport}.allow=always`,
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "submodule.recurse=false",
  ];
  const secrets = [config.token, config.sshKey]
    .filter((value): value is string => Boolean(value))
    .flatMap((secret) => [
      secret,
      secret.trim(),
      ...secret.split(/\r?\n/).map((line) => line.trim()),
    ])
    .filter(Boolean)
    .filter((secret, index, values) => values.indexOf(secret) === index)
    .sort((left, right) => right.length - left.length);
  const redact = (value: unknown): string => {
    let text = value instanceof Error ? value.message : String(value);
    for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
    return text;
  };
  const run = async (args: string[], cwd = config.vaultDir): Promise<string> => {
    try {
      const result = await executor("git", [...fixedArgs, ...args], {
        cwd,
        env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        signal,
      });
      return String(result.stdout);
    } catch (error) {
      const parts = errorParts(error);
      const detail =
        redact(parts.stderr).trim() || redact(parts.stdout).trim() || redact(parts.message).trim();
      throw new GitCommandError(
        `git ${args[0] ?? "command"} failed: ${detail}`,
        detail,
        parts.code,
      );
    }
  };
  return {
    run,
    async tryRun(args, cwd) {
      try {
        return { ok: true, stdout: await run(args, cwd) };
      } catch (error) {
        return { ok: false, stdout: "", error: error as GitCommandError };
      }
    },
    redact,
  };
}
