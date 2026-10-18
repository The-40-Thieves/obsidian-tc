import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type GitUrlKind = "ssh" | "https" | "file" | "local";
export type GitPushMode = "batched" | "off";

export interface GitSyncConfig {
  url: string;
  urlKind: GitUrlKind;
  branch?: string;
  sshKey?: string;
  knownHosts?: string;
  token?: string;
  authorName: string;
  authorEmail: string;
  pullIntervalMs: number;
  push: GitPushMode;
  webhookSecret?: string;
  vaultDir: string;
  cacheDir: string;
  stateDir: string;
  sshKeyPath: string;
  knownHostsPath: string;
  askpassPath: string;
}

const DEFAULT_AUTHOR = "obsidian-tc <obsidian-tc@localhost>";

function parseNetworkUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("OBSIDIAN_TC_VAULT_GIT_URL is not a valid URL");
  }
}

function required(env: NodeJS.ProcessEnv, variable: string): string {
  const value = env[variable];
  if (!value) throw new Error(`${variable} is required for git-sync`);
  return value;
}

function refuseControls(value: string, variable: string): void {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      throw new Error(`${variable} must not contain control characters`);
    }
  }
}

function physicalPath(value: string): string {
  const missing: string[] = [];
  let cursor = value;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return value;
    missing.unshift(cursor.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validBranch(value: string): boolean {
  if (
    value.startsWith("-") ||
    value === "@" ||
    value === "HEAD" ||
    value.includes("..") ||
    value.includes("@{") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    /\s/.test(value) ||
    [..."~^:?*[\\"].some((character) => value.includes(character))
  ) {
    return false;
  }
  return value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

function urlKind(value: string): GitUrlKind {
  refuseControls(value, "OBSIDIAN_TC_VAULT_GIT_URL");
  if (value.startsWith("-")) {
    throw new Error("OBSIDIAN_TC_VAULT_GIT_URL must not begin with a hyphen");
  }
  if (value.startsWith("file://")) return "file";
  if (/^(?:\/|\.\.?\/|[A-Za-z]:[\\/])/.test(value)) return "local";
  if (/^[^/@\s:]+@[^/\s:]+:.+/.test(value)) {
    const host = value.slice(value.indexOf("@") + 1, value.indexOf(":"));
    if (host.startsWith("-")) {
      throw new Error("OBSIDIAN_TC_VAULT_GIT_URL contains an invalid SSH host");
    }
    return "ssh";
  }
  if (value.startsWith("ssh://")) {
    const parsed = parseNetworkUrl(value);
    if (parsed.password) {
      throw new Error("OBSIDIAN_TC_VAULT_GIT_URL must not contain credentials");
    }
    if (parsed.hostname.startsWith("-")) {
      throw new Error("OBSIDIAN_TC_VAULT_GIT_URL contains an invalid SSH host");
    }
    return "ssh";
  }
  if (value.startsWith("https://")) {
    const parsed = parseNetworkUrl(value);
    if (parsed.username || parsed.password) {
      throw new Error("OBSIDIAN_TC_VAULT_GIT_URL must not contain credentials");
    }
    return "https";
  }
  if (!value.includes(":") && !/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value)) return "local";
  throw new Error(
    "OBSIDIAN_TC_VAULT_GIT_URL must use SSH, SCP-style SSH, HTTPS, file://, or a local path",
  );
}

function parseAuthor(value: string): { name: string; email: string } {
  const match = /^\s*(.+?)\s+<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error("OBSIDIAN_TC_VAULT_GIT_AUTHOR must have the form Name <email>");
  }
  return { name: match[1], email: match[2] };
}

function parseInterval(value: string | undefined): number {
  const raw = value ?? "30";
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(seconds) || seconds < 10) {
    throw new Error(
      "OBSIDIAN_TC_VAULT_GIT_PULL_INTERVAL must be an integer of at least 10 seconds",
    );
  }
  return seconds * 1_000;
}

function parsePush(value: string | undefined): GitPushMode {
  const push = value ?? "batched";
  if (push !== "batched" && push !== "off") {
    throw new Error("OBSIDIAN_TC_VAULT_GIT_PUSH must be batched or off");
  }
  return push;
}

export function loadGitSyncConfig(env: NodeJS.ProcessEnv = process.env): GitSyncConfig {
  const url = required(env, "OBSIDIAN_TC_VAULT_GIT_URL");
  const kind = urlKind(url);
  const normalizedUrl = kind === "local" ? resolve(url) : url;
  const sshKey = env.OBSIDIAN_TC_VAULT_GIT_SSH_KEY;
  const token = env.OBSIDIAN_TC_VAULT_GIT_TOKEN;
  if (kind === "ssh" && !sshKey) {
    throw new Error("OBSIDIAN_TC_VAULT_GIT_SSH_KEY is required for an SSH URL");
  }
  if (kind === "https" && !token) {
    throw new Error("OBSIDIAN_TC_VAULT_GIT_TOKEN is required for an HTTPS URL");
  }
  const author = parseAuthor(env.OBSIDIAN_TC_VAULT_GIT_AUTHOR ?? DEFAULT_AUTHOR);
  const vaultDir = resolve(required(env, "OBSIDIAN_TC_VAULT_PATH"));
  const cacheDir = resolve(required(env, "OBSIDIAN_TC_CACHE_DIR"));
  refuseControls(vaultDir, "OBSIDIAN_TC_VAULT_PATH");
  refuseControls(cacheDir, "OBSIDIAN_TC_CACHE_DIR");
  const stateDir = join(cacheDir, "git-sync");
  const physicalVault = physicalPath(vaultDir);
  const physicalState = physicalPath(stateDir);
  if (containsPath(physicalVault, physicalState) || containsPath(physicalState, physicalVault)) {
    throw new Error(
      "OBSIDIAN_TC_CACHE_DIR and OBSIDIAN_TC_VAULT_PATH must not contain one another",
    );
  }
  const branch = env.OBSIDIAN_TC_VAULT_GIT_BRANCH;
  if (branch) refuseControls(branch, "OBSIDIAN_TC_VAULT_GIT_BRANCH");
  if (branch && !validBranch(branch)) {
    throw new Error("OBSIDIAN_TC_VAULT_GIT_BRANCH is not a valid branch name");
  }
  return {
    url: normalizedUrl,
    urlKind: kind,
    ...(branch ? { branch } : {}),
    ...(sshKey ? { sshKey } : {}),
    ...(env.OBSIDIAN_TC_VAULT_GIT_KNOWN_HOSTS
      ? { knownHosts: env.OBSIDIAN_TC_VAULT_GIT_KNOWN_HOSTS }
      : {}),
    ...(token ? { token } : {}),
    authorName: author.name,
    authorEmail: author.email,
    pullIntervalMs: parseInterval(env.OBSIDIAN_TC_VAULT_GIT_PULL_INTERVAL),
    push: parsePush(env.OBSIDIAN_TC_VAULT_GIT_PUSH),
    ...(env.OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET
      ? { webhookSecret: env.OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET }
      : {}),
    vaultDir,
    cacheDir,
    stateDir,
    sshKeyPath: join(stateDir, "id_key"),
    knownHostsPath: join(stateDir, "known_hosts"),
    askpassPath: join(stateDir, "askpass.sh"),
  };
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteSshOptionValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildSshCommand(
  config: GitSyncConfig,
  pinned = config.knownHosts !== undefined,
): string {
  return [
    "ssh",
    "-i",
    quoteShell(config.sshKeyPath),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    quoteShell(`UserKnownHostsFile=${quoteSshOptionValue(config.knownHostsPath)}`),
    "-o",
    `StrictHostKeyChecking=${pinned ? "yes" : "accept-new"}`,
  ].join(" ");
}
