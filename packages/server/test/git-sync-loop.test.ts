import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  makeGitFixture,
  syncEnv,
  waitFor,
} from "./git-sync-test-helpers";

const execFileAsync = promisify(execFile);

const fastBatch = { tickMs: 50, quietMs: 200, capMs: 1_000, triggerPollMs: 50 };

async function runUntil(
  sync: Awaited<ReturnType<typeof bootGitSync>>,
  action: () => Promise<void>,
) {
  const controller = new AbortController();
  const running = sync.run(controller.signal);
  try {
    await action();
  } finally {
    controller.abort();
    await running;
  }
}

describe.skipIf(process.platform === "win32")("git-sync batching", () => {
  it("serializes dirty snapshots and commits through one in-flight operation", async () => {
    const fixture = makeGitFixture();
    let active = 0;
    let maximum = 0;
    const executor: GitExecutor = async (file, args, options) => {
      if (gitSubcommand(args) === "status") {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          return await execFileAsync(file, args, options);
        } finally {
          active -= 1;
        }
      }
      return execFileAsync(file, args, options);
    };
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), { executor });
    writeFileSync(join(fixture.vault, "locked.md"), "one operation\n");
    await Promise.all([sync.dirtySnapshot(), sync.commitDirty()]);
    expect(maximum).toBe(1);
  });

  it("records one bad tick and continues batching on a later tick", async () => {
    const fixture = makeGitFixture();
    let statusCalls = 0;
    const logs: string[] = [];
    const executor: GitExecutor = async (file, args, options) => {
      if (gitSubcommand(args) === "status") {
        statusCalls += 1;
        if (statusCalls === 1) {
          throw Object.assign(new Error("index lock collision"), { stderr: "index.lock exists" });
        }
      }
      return execFileAsync(file, args, options);
    };
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), {
      ...fastBatch,
      executor,
      logger: (line) => logs.push(line),
    });
    writeFileSync(join(fixture.vault, "after-error.md"), "still running\n");
    await runUntil(sync, async () => {
      await waitFor(() => git(fixture.vault, ["log", "-1", "--format=%B"]).includes("after-error"));
    });
    expect(logs.join("\n")).toContain("index.lock exists");
    expect(statusCalls).toBeGreaterThan(1);
  });
  it("resets the quiet window after each observed write and makes one commit", async () => {
    const fixture = makeGitFixture();
    const quietMs = 200;
    let statusCalls = 0;
    const executor: GitExecutor = async (file, args, options) => {
      if (gitSubcommand(args) === "status") statusCalls += 1;
      return execFileAsync(file, args, options);
    };
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), {
      ...fastBatch,
      tickMs: 25,
      quietMs,
      capMs: 30_000,
      executor,
    });
    const before = Number(git(fixture.vault, ["rev-list", "--count", "HEAD"]));
    let lastWriteAt = 0;
    let commitObservedAt = 0;
    await runUntil(sync, async () => {
      const note = join(fixture.vault, "batched.md");
      writeFileSync(note, "one\n");
      await waitFor(() => statusCalls >= 1);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const beforeSecondObservation = statusCalls;
      writeFileSync(note, "two\n");
      await waitFor(() => statusCalls > beforeSecondObservation);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(Number(git(fixture.vault, ["rev-list", "--count", "HEAD"]))).toBe(before);

      const beforeThirdObservation = statusCalls;
      lastWriteAt = Date.now();
      writeFileSync(note, "three\n");
      await waitFor(() => statusCalls > beforeThirdObservation);
      await waitFor(() => {
        const committed =
          Number(git(fixture.vault, ["rev-list", "--count", "HEAD"])) === before + 1;
        if (committed) commitObservedAt = Date.now();
        return committed;
      }, 2_000);
    });
    expect(Number(git(fixture.vault, ["rev-list", "--count", "HEAD"]))).toBe(before + 1);
    expect(commitObservedAt - lastWriteAt).toBeGreaterThanOrEqual(quietMs);
    expect(git(fixture.vault, ["show", "HEAD:batched.md"])).toBe("three");
    expect(git(fixture.vault, ["status", "--porcelain"])).toBe("");
  });

  it("measures the quiet window from when a write is observed, not from a tick that began earlier", async () => {
    const fixture = makeGitFixture();
    const quietMs = 200;
    const note = join(fixture.vault, "in-flight.md");
    let armed = false;
    let written = false;
    let lastWriteAt = 0;
    let commitObservedAt = 0;
    const executor: GitExecutor = async (file, args, options) => {
      if (armed && !written && gitSubcommand(args) === "status") {
        // The write lands while this status is in flight. Its tick started before the write.
        written = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
        lastWriteAt = Date.now();
        writeFileSync(note, "in flight\n");
      }
      return execFileAsync(file, args, options);
    };
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), {
      ...fastBatch,
      tickMs: 25,
      quietMs,
      capMs: 30_000,
      executor,
    });
    const before = Number(git(fixture.vault, ["rev-list", "--count", "HEAD"]));
    await runUntil(sync, async () => {
      armed = true;
      await waitFor(() => {
        const committed =
          Number(git(fixture.vault, ["rev-list", "--count", "HEAD"])) === before + 1;
        if (committed) commitObservedAt = Date.now();
        return committed;
      }, 5_000);
    });
    expect(written).toBe(true);
    expect(commitObservedAt - lastWriteAt).toBeGreaterThanOrEqual(quietMs);
    expect(git(fixture.vault, ["show", "HEAD:in-flight.md"])).toBe("in flight");
  });

  it("commits at the cap while writes continue", async () => {
    const fixture = makeGitFixture();
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), {
      ...fastBatch,
      quietMs: 10_000,
      capMs: 500,
    });
    const before = Number(git(fixture.vault, ["rev-list", "--count", "HEAD"]));
    await runUntil(sync, async () => {
      let writes = 0;
      const writer = setInterval(() => {
        writes += 1;
        writeFileSync(join(fixture.vault, "continuous.md"), `${writes}\n`);
      }, 50);
      try {
        await waitFor(() => Number(git(fixture.vault, ["rev-list", "--count", "HEAD"])) > before);
      } finally {
        clearInterval(writer);
      }
    });
    expect(Number(git(fixture.vault, ["rev-list", "--count", "HEAD"]))).toBeGreaterThan(before);
  });
});

describe.skipIf(process.platform === "win32")("git-sync pull triggers and read-only mode", () => {
  it("samples an existing trigger before polling and does not pull redundantly", async () => {
    const fixture = makeGitFixture();
    let fetches = 0;
    const executor: GitExecutor = async (file, args, options) => {
      if (gitSubcommand(args) === "fetch") fetches += 1;
      return execFileAsync(file, args, options);
    };
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), {
      ...fastBatch,
      executor,
    });
    writeFileSync(join(fixture.cache, "git-sync", "trigger"), "already observed\n");
    await runUntil(sync, async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(fetches).toBe(0);
  });
  it("pulls after the trigger mtime changes even when the interval is far away", async () => {
    const fixture = makeGitFixture();
    const sync = await bootGitSync(loadGitSyncConfig(syncEnv(fixture)), fastBatch);
    writeFileSync(join(fixture.laptop, "triggered.md"), "arrived\n");
    commitAll(fixture.laptop, "triggered");
    git(fixture.laptop, ["push"]);
    const trigger = join(fixture.cache, "git-sync", "trigger");
    writeFileSync(trigger, "initial\n");
    await runUntil(sync, async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(trigger, "changed\n");
      await waitFor(() => existsSync(join(fixture.vault, "triggered.md")));
    });
    expect(readFileSync(join(fixture.vault, "triggered.md"), "utf8")).toBe("arrived\n");
  });

  it("never commits or pushes in PUSH=off and can fast-forward around a non-overlapping edit", async () => {
    const fixture = makeGitFixture();
    const sync = await bootGitSync(
      loadGitSyncConfig(syncEnv(fixture, { OBSIDIAN_TC_VAULT_GIT_PUSH: "off" })),
    );
    const originalHead = git(fixture.vault, ["rev-parse", "HEAD"]);
    writeFileSync(join(fixture.vault, "local-only.md"), "do not commit\n");
    writeFileSync(join(fixture.laptop, "upstream.md"), "pull me\n");
    commitAll(fixture.laptop, "upstream");
    git(fixture.laptop, ["push"]);
    await sync.syncOnce();
    expect(existsSync(join(fixture.vault, "upstream.md"))).toBe(true);
    expect(readFileSync(join(fixture.vault, "local-only.md"), "utf8")).toBe("do not commit\n");
    expect(git(fixture.vault, ["status", "--porcelain"])).toContain("local-only.md");
    expect(git(fixture.origin, ["rev-parse", "main"])).not.toBe(originalHead);
  });

  it("reports a dirty-file fast-forward block and leaves the file byte-identical", async () => {
    const fixture = makeGitFixture("base\n");
    const sync = await bootGitSync(
      loadGitSyncConfig(syncEnv(fixture, { OBSIDIAN_TC_VAULT_GIT_PUSH: "off" })),
    );
    const localBytes = Buffer.from("local uncommitted\n");
    writeFileSync(join(fixture.vault, "a.md"), localBytes);
    writeFileSync(join(fixture.laptop, "a.md"), "upstream committed\n");
    commitAll(fixture.laptop, "blocking upstream");
    git(fixture.laptop, ["push"]);
    await expect(sync.syncOnce()).rejects.toThrow();
    expect(readFileSync(join(fixture.vault, "a.md"))).toEqual(localBytes);
    const status = JSON.parse(readFileSync(join(fixture.cache, "git-sync", "status.json"), "utf8"));
    expect(status.lastError).toBeTruthy();
    expect(status.lastError).not.toContain("local uncommitted");
  });
});
