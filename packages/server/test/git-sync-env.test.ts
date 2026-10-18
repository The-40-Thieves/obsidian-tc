import { mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args";
import { USAGE } from "../src/cli/usage";
import { buildSshCommand, type GitSyncConfig, loadGitSyncConfig } from "../src/git-sync/env";
import { makeTempDir } from "./tmp";

const base = {
  OBSIDIAN_TC_VAULT_GIT_URL: "file:///tmp/origin.git",
  OBSIDIAN_TC_VAULT_PATH: "/tmp/vault",
  OBSIDIAN_TC_CACHE_DIR: "/tmp/cache",
};

describe.skipIf(process.platform === "win32")("git-sync environment", () => {
  it.each([
    ["OBSIDIAN_TC_VAULT_GIT_URL", { OBSIDIAN_TC_VAULT_GIT_URL: undefined }, "missing"],
    [
      "OBSIDIAN_TC_VAULT_GIT_URL",
      { OBSIDIAN_TC_VAULT_GIT_URL: "http://bad-SECRET/x" },
      "bad-SECRET",
    ],
    [
      "OBSIDIAN_TC_VAULT_GIT_PULL_INTERVAL",
      { OBSIDIAN_TC_VAULT_GIT_PULL_INTERVAL: "9-SECRET" },
      "9-SECRET",
    ],
    [
      "OBSIDIAN_TC_VAULT_GIT_PULL_INTERVAL",
      { OBSIDIAN_TC_VAULT_GIT_PULL_INTERVAL: "10.5-SECRET" },
      "10.5-SECRET",
    ],
    ["OBSIDIAN_TC_VAULT_GIT_PUSH", { OBSIDIAN_TC_VAULT_GIT_PUSH: "now-SECRET" }, "now-SECRET"],
    ["OBSIDIAN_TC_VAULT_GIT_AUTHOR", { OBSIDIAN_TC_VAULT_GIT_AUTHOR: "bad-SECRET" }, "bad-SECRET"],
    [
      "OBSIDIAN_TC_VAULT_GIT_SSH_KEY",
      { OBSIDIAN_TC_VAULT_GIT_URL: "git@example.test:o/r.git" },
      "git@example.test:o/r.git",
    ],
    [
      "OBSIDIAN_TC_VAULT_GIT_TOKEN",
      { OBSIDIAN_TC_VAULT_GIT_URL: "https://example.test/o/r.git" },
      "https://example.test/o/r.git",
    ],
    [
      "OBSIDIAN_TC_VAULT_GIT_URL",
      {
        OBSIDIAN_TC_VAULT_GIT_URL: "ssh://user:ssh-SECRET@example.test/o/r.git",
        OBSIDIAN_TC_VAULT_GIT_SSH_KEY: "key",
      },
      "ssh-SECRET",
    ],
    [
      "OBSIDIAN_TC_VAULT_GIT_URL",
      { OBSIDIAN_TC_VAULT_GIT_URL: "https://bad host/url-SECRET" },
      "url-SECRET",
    ],
    ["OBSIDIAN_TC_VAULT_PATH", { OBSIDIAN_TC_VAULT_PATH: undefined }, "missing-vault"],
    ["OBSIDIAN_TC_CACHE_DIR", { OBSIDIAN_TC_CACHE_DIR: undefined }, "missing-cache"],
    [
      "OBSIDIAN_TC_VAULT_GIT_PULL_INTERVAL",
      { OBSIDIAN_TC_VAULT_GIT_PULL_INTERVAL: "999999999999999999999-SECRET" },
      "999999999999999999999-SECRET",
    ],
  ])("names %s without exposing its bad value", (variable, overlay, secret) => {
    expect(() => loadGitSyncConfig({ ...base, ...overlay })).toThrowError(
      expect.objectContaining({ message: expect.stringContaining(variable) }),
    );
    try {
      loadGitSyncConfig({ ...base, ...overlay });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("accepts local and file URLs without credentials and applies defaults", () => {
    expect(loadGitSyncConfig(base)).toMatchObject({
      url: "file:///tmp/origin.git",
      authorName: "obsidian-tc",
      authorEmail: "obsidian-tc@localhost",
      pullIntervalMs: 30_000,
      push: "batched",
    });
    expect(
      loadGitSyncConfig({ ...base, OBSIDIAN_TC_VAULT_GIT_URL: "/tmp/origin.git" }).urlKind,
    ).toBe("local");
    expect(loadGitSyncConfig({ ...base, OBSIDIAN_TC_VAULT_GIT_URL: "./origin.git" }).url).toBe(
      resolve("./origin.git"),
    );
  });

  it("refuses to place git-sync state inside the vault", () => {
    const env = {
      ...base,
      OBSIDIAN_TC_VAULT_PATH: "/tmp/vault-SECRET",
      OBSIDIAN_TC_CACHE_DIR: "/tmp/vault-SECRET/cache",
    };
    expect(() => loadGitSyncConfig(env)).toThrow(/OBSIDIAN_TC_(?:VAULT_PATH|CACHE_DIR)/);
    try {
      loadGitSyncConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain("vault-SECRET");
    }
  });

  it.each([
    "--upload-pack=evil@host:repo.git",
    "-oProxyCommand=evil@host:repo.git",
    "ext::sh -c touch% /tmp/pwned",
  ])("refuses the unsafe repository URL %s", (url) => {
    expect(() => loadGitSyncConfig({ ...base, OBSIDIAN_TC_VAULT_GIT_URL: url })).toThrow(
      /OBSIDIAN_TC_VAULT_GIT_URL/,
    );
  });

  it.each(["--foo", "a..b", "bad\nbranch"])('refuses the unsafe branch "%s"', (branch) => {
    expect(() => loadGitSyncConfig({ ...base, OBSIDIAN_TC_VAULT_GIT_BRANCH: branch })).toThrow(
      /OBSIDIAN_TC_VAULT_GIT_BRANCH/,
    );
  });

  it("refuses physical overlap through a symlink and reverse containment", () => {
    const root = makeTempDir("obtc-git-sync-paths-");
    const vault = join(root, "real-vault");
    const vaultLink = join(root, "vault-link");
    mkdirSync(vault);
    symlinkSync(vault, vaultLink, "dir");
    expect(() =>
      loadGitSyncConfig({
        ...base,
        OBSIDIAN_TC_VAULT_PATH: vaultLink,
        OBSIDIAN_TC_CACHE_DIR: join(vault, "cache"),
      }),
    ).toThrow(/OBSIDIAN_TC_(?:VAULT_PATH|CACHE_DIR)/);
    expect(() =>
      loadGitSyncConfig({
        ...base,
        OBSIDIAN_TC_VAULT_PATH: join(root, "cache", "git-sync", "vault"),
        OBSIDIAN_TC_CACHE_DIR: join(root, "cache"),
      }),
    ).toThrow(/OBSIDIAN_TC_(?:VAULT_PATH|CACHE_DIR)/);
  });

  it("builds pinned and trust-on-first-use SSH commands with safely quoted paths", () => {
    const config = {
      stateDir: "/tmp/state dir/it's-safe",
      sshKeyPath: "/tmp/state dir/it's-safe/id_key",
      knownHostsPath: "/tmp/state dir/it's-safe/known_hosts",
    } as GitSyncConfig;
    expect(buildSshCommand(config, true)).toContain("StrictHostKeyChecking=yes");
    expect(buildSshCommand(config, false)).toContain("StrictHostKeyChecking=accept-new");
    const command = buildSshCommand(config, true);
    expect(command).toContain("IdentitiesOnly=yes");
    expect(command).toContain("UserKnownHostsFile=");
    expect(command).toContain("'\"'\"'");
  });
});

describe.skipIf(process.platform === "win32")("git-sync CLI parsing", () => {
  it("parses the long-running and once forms and advertises their POSIX support", () => {
    expect(parseCliArgs(["git-sync"])).toEqual({ kind: "git-sync", once: false });
    expect(parseCliArgs(["git-sync", "--once"])).toEqual({ kind: "git-sync", once: true });
    expect(USAGE).toContain("obsidian-tc git-sync [--once]");
    expect(USAGE).toContain("POSIX only (Linux, macOS)");
  });

  it("refuses unknown git-sync flags including out-of-scope supervise", () => {
    expect(parseCliArgs(["git-sync", "--supervise"]).kind).toBe("error");
    expect(parseCliArgs(["git-sync", "--wat"]).kind).toBe("error");
  });
});
