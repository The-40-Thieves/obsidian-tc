import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { bootGitSync } from "../src/git-sync/boot";
import { buildSshCommand, type GitSyncConfig, loadGitSyncConfig } from "../src/git-sync/env";
import { createGitRunner, type GitExecutor, type GitInvocation } from "../src/git-sync/git";
import { git, gitSubcommand, makeGitFixture, syncEnv } from "./git-sync-test-helpers";
import { makeTempDir } from "./tmp";

const execFileAsync = promisify(execFile);

describe.skipIf(process.platform === "win32")("git-sync secret handling", () => {
  it("redacts a newline-terminated HTTPS token before trimming command output", async () => {
    const fixture = makeGitFixture();
    const token = "tkn-SECRET-with-newline\n";
    const config = loadGitSyncConfig(
      syncEnv(fixture, {
        OBSIDIAN_TC_VAULT_GIT_URL: "https://example.test/org/vault.git",
        OBSIDIAN_TC_VAULT_GIT_TOKEN: token,
      }),
    );
    const runner = await createGitRunner(config, async () => {
      throw Object.assign(new Error("request failed"), {
        stderr: `remote echoed ${token}`,
      });
    });

    const error = await runner.run(["fetch"]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(token.trim());
    expect((error as { stderr: string }).stderr).toBe("remote echoed [REDACTED]");
  });

  it("redacts a multi-line SSH key and each echoed key line before trimming stderr", async () => {
    const fixture = makeGitFixture();
    const key =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nssh-SECRET-line\n-----END OPENSSH PRIVATE KEY-----\n";
    const config = loadGitSyncConfig(
      syncEnv(fixture, {
        OBSIDIAN_TC_VAULT_GIT_URL: "git@example.test:org/vault.git",
        OBSIDIAN_TC_VAULT_GIT_SSH_KEY: key,
      }),
    );
    const runner = await createGitRunner(config, async () => {
      throw Object.assign(new Error("ssh failed"), {
        stderr: `ssh rejected key:\n${key}echoed line: ssh-SECRET-line\n`,
      });
    });

    const error = await runner.run(["fetch"]).catch((caught: unknown) => caught);
    const emitted = `${String(error)}\n${(error as { stderr: string }).stderr}`;

    expect(error).toBeInstanceOf(Error);
    expect(emitted).not.toContain("ssh-SECRET-line");
    expect(emitted).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(emitted).toContain("[REDACTED]");
  });

  it.each([
    ["ssh", "protocol.ssh.allow=always"],
    ["https", "protocol.https.allow=always"],
    ["file", "protocol.file.allow=always"],
    ["local", "protocol.file.allow=always"],
  ] as const)(
    "locks every %s git invocation to its configured transport",
    async (urlKind, allow) => {
      const fixture = makeGitFixture();
      const config = {
        ...loadGitSyncConfig(syncEnv(fixture)),
        urlKind,
        ...(urlKind === "ssh" ? { sshKey: "key\n" } : {}),
        ...(urlKind === "https" ? { token: "token" } : {}),
      };
      const invocations: GitInvocation[] = [];
      const runner = await createGitRunner(config, async (file, args, options) => {
        invocations.push({ file, args, cwd: String(options.cwd), env: options.env });
        return { stdout: "", stderr: "" };
      });
      await runner.run(["status"]);
      expect(invocations[0]?.args).toEqual([
        "-c",
        "protocol.allow=never",
        "-c",
        allow,
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "submodule.recurse=false",
        "status",
      ]);
    },
  );

  it("keeps an HTTPS token out of argv, config, status, and logs and redacts git stderr", async () => {
    const fixture = makeGitFixture();
    git(fixture.root, ["clone", fixture.url, fixture.vault]);
    const url = "https://example.test/org/vault.git";
    const token = "tkn-SECRET-123";
    git(fixture.vault, ["remote", "set-url", "origin", url]);
    const invocations: GitInvocation[] = [];
    const logs: string[] = [];
    const executor: GitExecutor = async (file, args, options) => {
      invocations.push({ file, args: [...args], cwd: String(options.cwd), env: options.env });
      if (gitSubcommand(args) === "fetch") {
        throw Object.assign(new Error("fetch failed"), { stderr: `remote said ${token}` });
      }
      return execFileAsync(file, args, options);
    };
    await expect(
      bootGitSync(
        loadGitSyncConfig(
          syncEnv(fixture, {
            OBSIDIAN_TC_VAULT_GIT_URL: url,
            OBSIDIAN_TC_VAULT_GIT_TOKEN: token,
          }),
        ),
        { executor, logger: (line) => logs.push(line) },
      ),
    ).rejects.toThrow("fetch failed");
    const artifacts = [
      JSON.stringify(invocations.map((entry) => entry.args)),
      readFileSync(join(fixture.vault, ".git", "config"), "utf8"),
      readFileSync(join(fixture.cache, "git-sync", "status.json"), "utf8"),
      logs.join("\n"),
    ];
    for (const artifact of artifacts) expect(artifact).not.toContain(token);
    expect(invocations.some((entry) => entry.env.OBSIDIAN_TC_GIT_TOKEN === token)).toBe(true);
  });

  it("writes an SSH key at 0600 and keeps its text out of argv, config, status, and logs", async () => {
    const fixture = makeGitFixture();
    git(fixture.root, ["clone", fixture.url, fixture.vault]);
    const url = "git@example.test:org/vault.git";
    const key = "-----BEGIN PRIVATE KEY-----\nssh-SECRET-456\n-----END PRIVATE KEY-----";
    git(fixture.vault, ["remote", "set-url", "origin", url]);
    const invocations: GitInvocation[] = [];
    const logs: string[] = [];
    const executor: GitExecutor = async (file, args, options) => {
      invocations.push({ file, args: [...args], cwd: String(options.cwd), env: options.env });
      if (gitSubcommand(args) === "fetch") return { stdout: "", stderr: "" };
      return execFileAsync(file, args, options);
    };
    await bootGitSync(
      loadGitSyncConfig(
        syncEnv(fixture, {
          OBSIDIAN_TC_VAULT_GIT_URL: url,
          OBSIDIAN_TC_VAULT_GIT_SSH_KEY: key,
        }),
      ),
      { executor, logger: (line) => logs.push(line) },
    );
    const state = join(fixture.cache, "git-sync");
    expect(statSync(join(state, "id_key")).mode & 0o777).toBe(0o600);
    const artifacts = [
      JSON.stringify(invocations.map((entry) => entry.args)),
      readFileSync(join(fixture.vault, ".git", "config"), "utf8"),
      readFileSync(join(state, "status.json"), "utf8"),
      logs.join("\n"),
    ];
    for (const artifact of artifacts) expect(artifact).not.toContain(key);
    expect(readFileSync(join(state, "id_key"), "utf8")).toBe(`${key}\n`);
  });

  it("atomically replaces a loose or symlinked key without exposing new key bytes", async () => {
    const fixture = makeGitFixture();
    const state = join(fixture.cache, "git-sync");
    mkdirSync(state, { recursive: true });
    chmodSync(state, 0o777);
    const victim = join(fixture.root, "victim");
    writeFileSync(victim, "do not overwrite\n", { mode: 0o666 });
    symlinkSync(victim, join(state, "id_key"));
    const config = loadGitSyncConfig(
      syncEnv(fixture, {
        OBSIDIAN_TC_VAULT_GIT_URL: "git@example.test:org/vault.git",
        OBSIDIAN_TC_VAULT_GIT_SSH_KEY: "new secret",
      }),
    );
    await createGitRunner(config, async () => ({ stdout: "", stderr: "" }));
    expect(readFileSync(victim, "utf8")).toBe("do not overwrite\n");
    expect(readFileSync(config.sshKeyPath, "utf8")).toBe("new secret\n");
    expect(statSync(config.sshKeyPath).mode & 0o777).toBe(0o600);
    expect(statSync(state).mode & 0o777).toBe(0o700);
  });

  it("preserves spaced and quoted SSH paths through the shell and ssh option parser", () => {
    const root = makeTempDir("obtc ssh command '");
    const bin = join(root, "bin");
    const output = join(root, "ssh-args");
    mkdirSync(bin);
    const fakeSsh = join(bin, "ssh");
    writeFileSync(fakeSsh, '#!/bin/sh\nexec /usr/bin/ssh -G "$@" > "$SSH_ARGS_OUT"\n');
    chmodSync(fakeSsh, 0o755);
    const config = {
      stateDir: root,
      sshKeyPath: join(root, "id key"),
      knownHostsPath: join(root, "known hosts"),
    } as GitSyncConfig;
    writeFileSync(config.sshKeyPath, "not-a-real-key\n", { mode: 0o600 });
    execFileSync("/bin/sh", ["-c", `${buildSshCommand(config, true)} example.test`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SSH_ARGS_OUT: output },
    });
    const parsed = readFileSync(output, "utf8");
    expect(parsed).toContain(`identityfile ${config.sshKeyPath}`);
    expect(parsed).toContain(`userknownhostsfile ${config.knownHostsPath}`);
    expect(parsed).toContain("stricthostkeychecking true");
  });

  it("does not bake the HTTPS token into the askpass script", async () => {
    const fixture = makeGitFixture();
    git(fixture.root, ["clone", fixture.url, fixture.vault]);
    git(fixture.vault, ["remote", "set-url", "origin", "https://example.test/org/vault.git"]);
    const config = loadGitSyncConfig(
      syncEnv(fixture, {
        OBSIDIAN_TC_VAULT_GIT_URL: "https://example.test/org/vault.git",
        OBSIDIAN_TC_VAULT_GIT_TOKEN: "tkn-SECRET-789",
      }),
    );
    const sync = await bootGitSync(config, {
      executor: async (file, args, options) => {
        if (gitSubcommand(args) === "fetch") return { stdout: "", stderr: "" };
        return execFileAsync(file, args, options);
      },
    });
    expect(sync).toBeDefined();
    expect(readFileSync(config.askpassPath, "utf8")).not.toContain("tkn-SECRET-789");
    expect(
      execFileSync(config.askpassPath, ["Password for https://example.test"], {
        env: { ...process.env, OBSIDIAN_TC_GIT_TOKEN: "tkn-SECRET-789" },
        encoding: "utf8",
      }),
    ).toBe("tkn-SECRET-789\n");
  });
});
