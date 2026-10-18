import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { GitSyncConfig } from "./env";
import type { GitCommandError, GitRunner } from "./git";
import type { StatusStore } from "./status";

export type SyncLogger = (line: string) => void;

function changedPaths(porcelain: string): string[] {
  const records = porcelain.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (path) paths.push(path);
    if ((code.includes("R") || code.includes("C")) && records[index + 1]) {
      paths.push(records[index + 1] ?? "");
      index += 1;
    }
  }
  return [...new Set(paths)];
}

function safeMessagePath(path: string): string {
  return path.replace(/[\r\n\0]/g, "�");
}

function rejectedPush(error: GitCommandError): boolean {
  return /\[(?:remote )?rejected\]|non-fast-forward|failed to push some refs|hook declined/i.test(
    error.stderr,
  );
}

function conflictBranchName(now = new Date()): string {
  return `obsidian-tc/conflict/${now.toISOString().replace(/[:.]/g, "-")}`;
}

export class GitSync {
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    readonly config: GitSyncConfig,
    readonly runner: GitRunner,
    readonly status: StatusStore,
    readonly branch: string,
    readonly logger: SyncLogger,
  ) {}

  porcelain(): Promise<string> {
    return this.exclusive(() => this.porcelainUnlocked());
  }

  dirtySnapshot(): Promise<{ dirty: boolean; fingerprint: string }> {
    return this.exclusive(() => this.dirtySnapshotUnlocked());
  }

  commitDirty(): Promise<boolean> {
    return this.exclusive(() => this.commitDirtyUnlocked());
  }

  syncOnce(): Promise<void> {
    return this.exclusive(() => this.performSync());
  }

  private porcelainUnlocked(): Promise<string> {
    return this.runner.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"]);
  }

  private async dirtySnapshotUnlocked(): Promise<{ dirty: boolean; fingerprint: string }> {
    const porcelain = await this.porcelainUnlocked();
    const paths = changedPaths(porcelain);
    const facts: string[] = [];
    for (const path of paths) {
      try {
        const info = await lstat(join(this.config.vaultDir, path));
        facts.push(`${path}\0${info.size}\0${info.mtimeMs}`);
      } catch {
        facts.push(`${path}\0missing`);
      }
    }
    return { dirty: porcelain.length > 0, fingerprint: `${porcelain}\0${facts.join("\0")}` };
  }

  private async commitDirtyUnlocked(): Promise<boolean> {
    if (this.config.push === "off") return false;
    const porcelain = await this.porcelainUnlocked();
    if (!porcelain) return false;
    const paths = changedPaths(porcelain);
    await this.runner.run(["add", "-A", "--"]);
    const staged = await this.runner.tryRun(["diff", "--cached", "--quiet", "--exit-code", "--"]);
    if (staged.ok) return false;
    if (staged.error?.exitCode !== 1) throw staged.error;
    const shown = paths.slice(0, 20).map(safeMessagePath);
    const suffix = paths.length > shown.length ? `\n… and ${paths.length - shown.length} more` : "";
    const message = `obsidian-tc: update ${paths.length} notes\n\n${shown.join("\n")}${suffix}`;
    await this.runner.run(["commit", "-m", message]);
    this.logger(`[git-sync] commit paths=${paths.length}`);
    return true;
  }

  private async performSync(): Promise<void> {
    if (this.config.push === "batched") await this.commitDirtyUnlocked();
    await this.fetchBranch();
    if (this.config.push === "off") {
      await this.runner.run(["merge", "--ff-only", `origin/${this.branch}`]);
      const head = (await this.runner.run(["rev-parse", "HEAD"])).trim();
      await this.status.update({
        lastPullAt: new Date().toISOString(),
        head,
        lastError: null,
      });
      this.logger(`[git-sync] pull branch=${this.branch} mode=ff-only`);
      return;
    }
    const rebased = await this.runner.tryRun(["rebase", `origin/${this.branch}`]);
    if (!rebased.ok) {
      if (await this.rebaseHasConflicts()) {
        await this.rescueConflict("rebase conflict", undefined, true);
        return;
      }
      throw rebased.error;
    }
    const pulledHead = (await this.runner.run(["rev-parse", "HEAD"])).trim();
    await this.status.update({
      lastPullAt: new Date().toISOString(),
      head: pulledHead,
      lastError: null,
    });
    this.logger(`[git-sync] pull branch=${this.branch} mode=rebase`);
    await this.pushWithRetries();
    const head = (await this.runner.run(["rev-parse", "HEAD"])).trim();
    await this.status.update({
      lastPullAt: new Date().toISOString(),
      head,
      lastError: null,
    });
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.inFlight.then(async () => {
      try {
        return await task();
      } catch (error) {
        await this.recordError(error);
        throw error;
      }
    });
    this.inFlight = operation.catch(() => undefined);
    return operation;
  }

  private async recordError(error: unknown): Promise<void> {
    const message = this.runner.redact(error);
    let head: string | null = null;
    const result = await this.runner.tryRun(["rev-parse", "HEAD"]);
    if (result.ok) head = result.stdout.trim();
    await this.status.update({ lastError: message, ...(head ? { head } : {}) });
    this.logger(`[git-sync] error ${message.replace(/[\r\n]+/g, " ")}`);
  }

  private async pushWithRetries(): Promise<void> {
    const ahead = Number(
      (await this.runner.run(["rev-list", "--count", `origin/${this.branch}..HEAD`])).trim(),
    );
    if (ahead === 0) return;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const pushed = await this.runner.tryRun([
        "push",
        "--",
        this.config.url,
        `HEAD:refs/heads/${this.branch}`,
      ]);
      if (pushed.ok) {
        await this.runner.run(["update-ref", `refs/remotes/origin/${this.branch}`, "HEAD"]);
        await this.status.update({ lastPushAt: new Date().toISOString(), lastError: null });
        this.logger(`[git-sync] push branch=${this.branch} commits=${ahead} attempt=${attempt}`);
        return;
      }
      if (!pushed.error || !rejectedPush(pushed.error)) throw pushed.error;
      if (attempt === 3) {
        await this.rescueConflict("push rejected after 3 attempts", 3);
        return;
      }
      await this.commitDirtyUnlocked();
      await this.fetchBranch();
      const rebased = await this.runner.tryRun(["rebase", `origin/${this.branch}`]);
      if (!rebased.ok) {
        if (await this.rebaseHasConflicts()) {
          await this.rescueConflict("rebase conflict after rejected push", attempt, true);
          return;
        }
        throw rebased.error;
      }
    }
  }

  private async rebaseHasConflicts(): Promise<boolean> {
    const rebaseHead = await this.runner.tryRun(["rev-parse", "--verify", "-q", "REBASE_HEAD"]);
    if (rebaseHead.ok) return true;
    const unmerged = await this.runner.tryRun(["diff", "--name-only", "--diff-filter=U"]);
    return unmerged.ok && unmerged.stdout.trim().length > 0;
  }

  private fetchBranch(): Promise<string> {
    return this.runner.run([
      "fetch",
      "--no-recurse-submodules",
      "--",
      this.config.url,
      `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`,
    ]);
  }

  private async rescueConflict(
    reason: string,
    attempts?: number,
    rebaseInProgress = false,
  ): Promise<void> {
    if (rebaseInProgress) await this.runner.run(["rebase", "--abort"]);
    const branch = conflictBranchName();
    while (true) {
      await this.commitDirtyUnlocked();
      await this.runner.run(["push", "--", this.config.url, `HEAD:refs/heads/${branch}`]);
      if (!(await this.commitDirtyUnlocked())) break;
    }
    await this.runner.run(["reset", "--hard", `origin/${this.branch}`]);
    const head = (await this.runner.run(["rev-parse", "HEAD"])).trim();
    await this.status.addConflict({ at: new Date().toISOString(), branch, reason, attempts }, head);
    this.logger(`[git-sync] conflict branch=${branch} reason=${reason}`);
  }
}
