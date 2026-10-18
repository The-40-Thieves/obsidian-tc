import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { bootGitSync } from "../src/git-sync/boot";
import { loadGitSyncConfig } from "../src/git-sync/env";
import type { GitExecutor } from "../src/git-sync/git";
import {
  commitAll,
  git,
  gitSubcommand,
  installRejectingHook,
  makeGitFixture,
  syncEnv,
} from "./git-sync-test-helpers";

const execFileAsync = promisify(execFile);

describe.skipIf(process.platform === "win32")("git-sync bidirectional synchronization", () => {
  it("ignores repository-configured upload-pack and receive-pack commands", async () => {
    const fixture = makeGitFixture();
    git(fixture.root, ["clone", fixture.url, fixture.vault]);
    const uploadMarker = join(fixture.root, "upload-pack-ran");
    const receiveMarker = join(fixture.root, "receive-pack-ran");
    const uploadPack = join(fixture.root, "upload-pack");
    const receivePack = join(fixture.root, "receive-pack");
    writeFileSync(uploadPack, `#!/bin/sh\ntouch '${uploadMarker}'\nexec git-upload-pack "$@"\n`);
    writeFileSync(receivePack, `#!/bin/sh\ntouch '${receiveMarker}'\nexec git-receive-pack "$@"\n`);
    chmodSync(uploadPack, 0o755);
    chmodSync(receivePack, 0o755);
    git(fixture.vault, ["config", "remote.origin.uploadpack", uploadPack]);
    git(fixture.vault, ["config", "remote.origin.receivepack", receivePack]);
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)));
    writeFileSync(join(fixture.vault, "safe-remote.md"), "configured URL only\n");
    await sync.syncOnce();
    expect(existsSync(uploadMarker)).toBe(false);
    expect(existsSync(receiveMarker)).toBe(false);
  });

  it("separates every supported remote and path positional argument from options", async () => {
    const fixture = makeGitFixture();
    const invocations: string[][] = [];
    const executor: GitExecutor = async (file, args, options) => {
      invocations.push([...args]);
      return execFileAsync(file, args, options);
    };
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), { executor });
    writeFileSync(join(fixture.vault, "separators.md"), "safe arguments\n");
    await sync.syncOnce();
    const clone = invocations.find((args) => gitSubcommand(args) === "clone");
    const fetch = invocations.find((args) => gitSubcommand(args) === "fetch");
    const add = invocations.find((args) => gitSubcommand(args) === "add");
    const push = invocations.find((args) => gitSubcommand(args) === "push");
    expect(clone?.slice(-3)).toEqual(["--", fixture.url, expect.any(String)]);
    expect(fetch?.slice(-3)).toEqual([
      "--",
      fixture.url,
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
    expect(add?.at(-1)).toBe("--");
    expect(push?.slice(-3)).toEqual(["--", fixture.url, "HEAD:refs/heads/main"]);
  });

  it("pulls a laptop commit into the vault", async () => {
    const fixture = makeGitFixture();
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)));
    const bytes = Buffer.from([35, 32, 65, 10, 0, 10]);
    writeFileSync(join(fixture.laptop, "a.md"), bytes);
    commitAll(fixture.laptop, "laptop update");
    git(fixture.laptop, ["push"]);
    await sync.syncOnce();
    expect(readFileSync(join(fixture.vault, "a.md"))).toEqual(bytes);
  });

  it("commits one vault batch with the configured author and paths, then pushes it", async () => {
    const fixture = makeGitFixture();
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)));
    writeFileSync(join(fixture.vault, "a.md"), "vault changed a\n");
    writeFileSync(join(fixture.vault, "b.md"), "vault created b\n");
    await sync.syncOnce();
    const log = git(fixture.vault, ["log", "-1", "--format=%an <%ae>%n%B"]);
    expect(log).toContain("Vault Bot <vault@example.test>");
    expect(log).toContain("obsidian-tc: update 2 notes");
    expect(log).toContain("a.md");
    expect(log).toContain("b.md");
    git(fixture.laptop, ["pull", "--ff-only"]);
    expect(readFileSync(join(fixture.laptop, "a.md"), "utf8")).toBe("vault changed a\n");
    expect(readFileSync(join(fixture.laptop, "b.md"), "utf8")).toBe("vault created b\n");
    expect(git(fixture.vault, ["rev-list", "--count", "HEAD~1..HEAD"])).toBe("1");
  });

  it("rebases concurrent non-conflicting work and keeps history linear", async () => {
    const fixture = makeGitFixture();
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)));
    writeFileSync(join(fixture.vault, "vault.md"), "vault\n");
    writeFileSync(join(fixture.laptop, "laptop.md"), "laptop\n");
    commitAll(fixture.laptop, "laptop concurrent");
    git(fixture.laptop, ["push"]);
    await sync.syncOnce();
    expect(git(fixture.vault, ["rev-list", "--min-parents=2", "--count", "HEAD"])).toBe("0");
    expect(existsSync(join(fixture.vault, "vault.md"))).toBe(true);
    expect(existsSync(join(fixture.vault, "laptop.md"))).toBe(true);
  });

  it("records a completed pull when a later non-rejection push error occurs", async () => {
    const fixture = makeGitFixture();
    const executor: GitExecutor = async (file, args, options) => {
      if (gitSubcommand(args) === "push") {
        throw Object.assign(new Error("transport unavailable"), {
          stderr: "transport unavailable",
        });
      }
      return execFileAsync(file, args, options);
    };
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), { executor });
    writeFileSync(join(fixture.vault, "pending.md"), "pending push\n");
    await expect(sync.syncOnce()).rejects.toThrow("transport unavailable");
    const status = JSON.parse(readFileSync(join(fixture.cache, "git-sync", "status.json"), "utf8"));
    expect(status.lastPullAt).toBeTruthy();
    expect(status.lastPushAt).toBeNull();
    expect(status.lastError).toContain("transport unavailable");
  });
});

describe.skipIf(process.platform === "win32")("git-sync conflict and retry policy", () => {
  it("commits an edit made during a rejected push onto the conflict branch", async () => {
    const fixture = makeGitFixture();
    let mainPushes = 0;
    const executor: GitExecutor = async (file, args, options) => {
      const mainPush = gitSubcommand(args) === "push" && args.includes("HEAD:refs/heads/main");
      if (mainPush) {
        mainPushes += 1;
        if (mainPushes === 1) writeFileSync(join(fixture.vault, "a.md"), "edited during push\n");
        throw Object.assign(new Error("rejected"), {
          stderr: "[rejected] main -> main (non-fast-forward)",
        });
      }
      return execFileAsync(file, args, options);
    };
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), { executor });
    writeFileSync(join(fixture.vault, "before-push.md"), "initial local edit\n");
    await sync.syncOnce();
    const conflictRef = git(fixture.origin, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/obsidian-tc/conflict",
    ]);
    expect(conflictRef).toMatch(/^obsidian-tc\/conflict\//);
    expect(git(fixture.origin, ["show", `${conflictRef}:a.md`])).toBe("edited during push");
  });

  it("treats a failed rebase abort as fatal and never resets", async () => {
    const fixture = makeGitFixture("same line\n");
    let resetCalled = false;
    const executor: GitExecutor = async (file, args, options) => {
      const command = gitSubcommand(args);
      if (command === "rebase" && args.includes("--abort")) {
        throw Object.assign(new Error("abort blocked"), { stderr: "abort blocked" });
      }
      if (command === "reset") resetCalled = true;
      return execFileAsync(file, args, options);
    };
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), { executor });
    resetCalled = false;
    writeFileSync(join(fixture.vault, "a.md"), "vault text\n");
    writeFileSync(join(fixture.laptop, "a.md"), "laptop text\n");
    commitAll(fixture.laptop, "laptop conflict");
    git(fixture.laptop, ["push"]);
    await expect(sync.syncOnce()).rejects.toThrow("abort blocked");
    expect(resetCalled).toBe(false);
    const status = JSON.parse(readFileSync(join(fixture.cache, "git-sync", "status.json"), "utf8"));
    expect(status.lastError).toContain("abort blocked");
  });

  it("does not reset when pushing the conflict branch fails", async () => {
    const fixture = makeGitFixture();
    let resetCalled = false;
    const executor: GitExecutor = async (file, args, options) => {
      const command = gitSubcommand(args);
      if (command === "push") {
        if (args.some((arg) => arg.startsWith("HEAD:refs/heads/obsidian-tc/conflict/"))) {
          throw Object.assign(new Error("conflict push unavailable"), {
            stderr: "conflict push unavailable",
          });
        }
        throw Object.assign(new Error("rejected"), {
          stderr: "[rejected] main -> main (non-fast-forward)",
        });
      }
      if (command === "reset") resetCalled = true;
      return execFileAsync(file, args, options);
    };
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), { executor });
    resetCalled = false;
    writeFileSync(join(fixture.vault, "keep.md"), "keep locally\n");
    await expect(sync.syncOnce()).rejects.toThrow("conflict push unavailable");
    expect(resetCalled).toBe(false);
    expect(readFileSync(join(fixture.vault, "keep.md"), "utf8")).toBe("keep locally\n");
  });

  it("treats a vanished transient file as no commit instead of failing the sync", async () => {
    const fixture = makeGitFixture();
    const transient = join(fixture.vault, "transient.md");
    let removed = false;
    const executor: GitExecutor = async (file, args, options) => {
      if (!removed && gitSubcommand(args) === "add") {
        removed = true;
        rmSync(transient);
      }
      return execFileAsync(file, args, options);
    };
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), { executor });
    writeFileSync(transient, "temporary\n");
    await expect(sync.commitDirty()).resolves.toBe(false);
  });
  it("rescues a rebase conflict to a branch, resets to upstream, and records it", async () => {
    const fixture = makeGitFixture("same line\n");
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)));
    writeFileSync(join(fixture.vault, "a.md"), "vault text\n");
    writeFileSync(join(fixture.laptop, "a.md"), "laptop text\n");
    commitAll(fixture.laptop, "laptop conflict");
    git(fixture.laptop, ["push"]);
    await sync.syncOnce();
    expect(readFileSync(join(fixture.vault, "a.md"), "utf8")).toBe("laptop text\n");
    const refs = git(fixture.origin, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/obsidian-tc/conflict",
    ]);
    const conflictRef = refs.split("\n").find(Boolean);
    expect(conflictRef).toMatch(/^obsidian-tc\/conflict\/\d{4}-\d{2}-\d{2}T/);
    git(fixture.laptop, ["fetch", "origin", `${conflictRef}:refs/remotes/origin/conflict-test`]);
    expect(git(fixture.laptop, ["show", "origin/conflict-test:a.md"])).toBe("vault text");
    const status = JSON.parse(readFileSync(join(fixture.cache, "git-sync", "status.json"), "utf8"));
    expect(status.conflicts.at(-1)?.branch).toBe(conflictRef);
  });

  it("retries one rejected push and succeeds without a conflict branch", async () => {
    const fixture = makeGitFixture();
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)));
    const marker = installRejectingHook(fixture, "once");
    writeFileSync(join(fixture.vault, "retry.md"), "retry\n");
    await sync.syncOnce();
    expect(existsSync(marker)).toBe(true);
    expect(
      git(fixture.origin, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/obsidian-tc/conflict",
      ]),
    ).toBe("");
    expect(git(fixture.vault, ["rev-list", "--left-right", "--count", "origin/main...HEAD"])).toBe(
      "0\t0",
    );
  });

  it("uses the conflict path after three consecutive main-branch rejections", async () => {
    const fixture = makeGitFixture();
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)));
    installRejectingHook(fixture, "main-always");
    writeFileSync(join(fixture.vault, "rejected.md"), "rescue me\n");
    await sync.syncOnce();
    const status = JSON.parse(readFileSync(join(fixture.cache, "git-sync", "status.json"), "utf8"));
    expect(status.conflicts.at(-1)?.reason).toContain("push rejected");
    expect(status.conflicts.at(-1)?.attempts).toBe(3);
    expect(
      git(fixture.origin, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/obsidian-tc/conflict",
      ]),
    ).not.toBe("");
    expect(existsSync(join(fixture.vault, "rejected.md"))).toBe(false);
  });
});
