import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { bootGitSync, type GitSyncOptions } from "../src/git-sync/boot";
import { loadGitSyncConfig } from "../src/git-sync/env";
import type { GitExecutor } from "../src/git-sync/git";
import { commitAll, git, makeGitFixture, syncEnv } from "./git-sync-test-helpers";

const execFileAsync = promisify(execFile);

describe.skipIf(process.platform === "win32")("git-sync boot", () => {
  it("ignores hostile host-global Git configuration in test fixtures", () => {
    const root = mkdtempSync(join(import.meta.dirname, ".git-sync-host-config-"));
    const hostile = join(root, "host.gitconfig");
    writeFileSync(hostile, "[commit]\n\tgpgsign = true\n[core]\n\thooksPath = /missing/hooks\n");
    const original = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = hostile;
    try {
      expect(() => makeGitFixture()).not.toThrow();
    } finally {
      if (original === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clones an empty directory and checks out the configured branch", async () => {
    const fixture = makeGitFixture();
    mkdirSync(fixture.vault);
    await bootGitSync(loadGitSyncConfig(syncEnv(fixture)));
    expect(readFileSync(join(fixture.vault, "a.md"), "utf8")).toBe("seed\n");
    expect(git(fixture.vault, ["branch", "--show-current"])).toBe("main");
  });

  it("clones when the vault contains only empty directories", async () => {
    const fixture = makeGitFixture();
    mkdirSync(join(fixture.vault, "empty", "nested"), { recursive: true });
    await bootGitSync(loadGitSyncConfig(syncEnv(fixture)));
    expect(git(fixture.vault, ["remote", "get-url", "origin"])).toBe(fixture.url);
  });

  it("continues an existing clone whose origin matches", async () => {
    const fixture = makeGitFixture();
    git(fixture.root, ["clone", fixture.url, fixture.vault]);
    await expect(bootGitSync(loadGitSyncConfig(syncEnv(fixture)))).resolves.toBeDefined();
    expect(git(fixture.vault, ["status", "--porcelain"])).toBe("");
  });

  it("pulls a matching existing clone before boot returns", async () => {
    const fixture = makeGitFixture();
    git(fixture.root, ["clone", fixture.url, fixture.vault]);
    writeFileSync(join(fixture.laptop, "boot-pull.md"), "arrived during boot\n");
    commitAll(fixture.laptop, "boot pull");
    git(fixture.laptop, ["push"]);
    await bootGitSync(loadGitSyncConfig(syncEnv(fixture)));
    expect(readFileSync(join(fixture.vault, "boot-pull.md"), "utf8")).toBe("arrived during boot\n");
  });

  it("fetches before selecting a configured branch that was created after the clone", async () => {
    const fixture = makeGitFixture();
    git(fixture.root, ["clone", fixture.url, fixture.vault]);
    git(fixture.laptop, ["checkout", "-b", "notes"]);
    writeFileSync(join(fixture.laptop, "notes.md"), "branch fetched first\n");
    commitAll(fixture.laptop, "notes branch");
    git(fixture.laptop, ["push", "-u", "origin", "notes"]);
    const sync = await bootGitSync(
      loadGitSyncConfig(syncEnv(fixture, { OBSIDIAN_TC_VAULT_GIT_BRANCH: "notes" })),
    );
    expect(sync.branch).toBe("notes");
    expect(readFileSync(join(fixture.vault, "notes.md"), "utf8")).toBe("branch fetched first\n");
  });

  it("refuses to switch a dirty existing clone and leaves both branches and files untouched", async () => {
    const fixture = makeGitFixture();
    git(fixture.laptop, ["checkout", "-b", "other"]);
    writeFileSync(join(fixture.laptop, "other.md"), "other branch\n");
    commitAll(fixture.laptop, "other branch");
    git(fixture.laptop, ["push", "-u", "origin", "other"]);
    git(fixture.root, ["clone", fixture.url, fixture.vault]);
    git(fixture.vault, ["branch", "other", "origin/other"]);
    const trackedBytes = Buffer.from("dirty main bytes\n\0", "utf8");
    const untrackedBytes = Buffer.from([0, 1, 2, 3, 255]);
    writeFileSync(join(fixture.vault, "a.md"), trackedBytes);
    writeFileSync(join(fixture.vault, "pending.bin"), untrackedBytes);
    const mainBefore = git(fixture.vault, ["rev-parse", "main"]);
    const otherBefore = git(fixture.vault, ["rev-parse", "other"]);

    await expect(
      bootGitSync(loadGitSyncConfig(syncEnv(fixture, { OBSIDIAN_TC_VAULT_GIT_BRANCH: "other" }))),
    ).rejects.toThrow(/main.*other/);

    expect(git(fixture.vault, ["branch", "--show-current"])).toBe("main");
    expect(git(fixture.vault, ["rev-parse", "main"])).toBe(mainBefore);
    expect(git(fixture.vault, ["rev-parse", "other"])).toBe(otherBefore);
    expect(readFileSync(join(fixture.vault, "a.md"))).toEqual(trackedBytes);
    expect(readFileSync(join(fixture.vault, "pending.bin"))).toEqual(untrackedBytes);
    const status = JSON.parse(readFileSync(join(fixture.cache, "git-sync", "status.json"), "utf8"));
    expect(status.lastError).toMatch(/main.*other/);
  });

  it("uses the remote HEAD when no branch is configured", async () => {
    const fixture = makeGitFixture();
    const sync = await bootGitSync(
      loadGitSyncConfig(syncEnv(fixture, { OBSIDIAN_TC_VAULT_GIT_BRANCH: undefined })),
    );
    expect(sync.branch).toBe("main");
    expect(git(fixture.vault, ["branch", "--show-current"])).toBe("main");
  });

  it("accepts a symlink to a vault directory and gives a clear error for a broken one", async () => {
    const fixture = makeGitFixture();
    const target = join(fixture.root, "vault-target");
    const link = join(fixture.root, "vault-link");
    mkdirSync(target);
    symlinkSync(target, link, "dir");
    fixture.vault = link;
    await bootGitSync(loadGitSyncConfig(syncEnv(fixture)));
    expect(readFileSync(join(target, "a.md"), "utf8")).toBe("seed\n");

    const broken = join(fixture.root, "broken-vault");
    symlinkSync(join(fixture.root, "missing-target"), broken, "dir");
    fixture.vault = broken;
    await expect(bootGitSync(loadGitSyncConfig(syncEnv(fixture)))).rejects.toThrow(
      `git-sync refuses non-directory vault path ${broken}`,
    );
  });

  it("does not walk up to an ancestor repository when vault .git is invalid", async () => {
    const fixture = makeGitFixture();
    const parent = join(fixture.root, "parent");
    mkdirSync(parent);
    git(parent, ["init", "--initial-branch=main"]);
    git(parent, ["remote", "add", "origin", fixture.url]);
    const vault = join(parent, "nested-vault");
    mkdirSync(join(vault, ".git"), { recursive: true });
    fixture.vault = vault;
    await expect(bootGitSync(loadGitSyncConfig(syncEnv(fixture)))).rejects.toThrow(
      `git-sync refuses invalid repository in ${vault}`,
    );
  });

  it("leaves an empty vault unchanged when checkout of a staged clone fails", async () => {
    const fixture = makeGitFixture();
    mkdirSync(join(fixture.vault, "empty", "nested"), { recursive: true });
    const executor: GitExecutor = async (file, args, options) => {
      if (args.includes("reset")) {
        throw Object.assign(new Error("injected checkout failure"), {
          stderr: "injected checkout failure",
        });
      }
      return execFileAsync(file, args, options);
    };
    await expect(bootGitSync(loadGitSyncConfig(syncEnv(fixture)), { executor })).rejects.toThrow(
      "injected checkout failure",
    );
    expect(existsSync(join(fixture.vault, ".git"))).toBe(false);
    expect(existsSync(join(fixture.vault, "empty", "nested"))).toBe(true);
  });

  it("clones directly into the vault when staging beside it is unavailable", async () => {
    const fixture = makeGitFixture();
    mkdirSync(join(fixture.vault, "pre-existing", "nested"), { recursive: true });
    let stagingAttempts = 0;
    const cloneDestinations: string[] = [];
    const options: GitSyncOptions & {
      createCloneStagingDirectory(prefix: string): Promise<string>;
    } = {
      createCloneStagingDirectory: async () => {
        stagingAttempts += 1;
        throw Object.assign(new Error("staging parent is not writable"), { code: "EACCES" });
      },
      executor: async (file, args, executorOptions) => {
        if (args.includes("clone")) cloneDestinations.push(args.at(-1) ?? "");
        return execFileAsync(file, args, executorOptions);
      },
    };

    await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), options);

    expect(stagingAttempts).toBe(1);
    expect(cloneDestinations).toEqual([fixture.vault]);
    expect(readFileSync(join(fixture.vault, "a.md"), "utf8")).toBe("seed\n");
    expect(existsSync(join(fixture.vault, "pre-existing", "nested"))).toBe(true);
  });

  it("cleans only direct-clone artifacts when checkout fails", async () => {
    const fixture = makeGitFixture();
    mkdirSync(join(fixture.vault, "pre-existing", "nested"), { recursive: true });
    let stagingAttempts = 0;
    const options: GitSyncOptions & {
      createCloneStagingDirectory(prefix: string): Promise<string>;
    } = {
      createCloneStagingDirectory: async () => {
        stagingAttempts += 1;
        throw Object.assign(new Error("vault is a mount point"), { code: "EBUSY" });
      },
      executor: async (file, args, executorOptions) => {
        if (args.includes("reset")) {
          throw Object.assign(new Error("injected direct checkout failure"), {
            stderr: "injected direct checkout failure",
          });
        }
        return execFileAsync(file, args, executorOptions);
      },
    };

    await expect(bootGitSync(loadGitSyncConfig(syncEnv(fixture)), options)).rejects.toThrow(
      "injected direct checkout failure",
    );

    expect(stagingAttempts).toBe(1);
    expect(existsSync(join(fixture.vault, ".git"))).toBe(false);
    expect(existsSync(join(fixture.vault, "a.md"))).toBe(false);
    expect(existsSync(join(fixture.vault, "pre-existing", "nested"))).toBe(true);
  });

  it("refuses a non-repository without changing its file bytes or mtime", async () => {
    const fixture = makeGitFixture();
    mkdirSync(fixture.vault);
    const note = join(fixture.vault, "keep.md");
    writeFileSync(note, Buffer.from([0, 1, 2, 3]));
    const before = statSync(note, { bigint: true });
    await expect(bootGitSync(loadGitSyncConfig(syncEnv(fixture)))).rejects.toThrow(fixture.vault);
    const after = statSync(note, { bigint: true });
    expect(readFileSync(note)).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(existsSync(join(fixture.cache, "git-sync"))).toBe(false);
  });

  it("refuses a clone whose origin differs", async () => {
    const fixture = makeGitFixture();
    const other = makeGitFixture();
    git(fixture.root, ["clone", other.url, fixture.vault]);
    await expect(bootGitSync(loadGitSyncConfig(syncEnv(fixture)))).rejects.toThrow(fixture.vault);
  });
});
