import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run_git_sync } from "../src/cli/commands/git-sync";
import { git, makeGitFixture, syncEnv, waitFor } from "./git-sync-test-helpers";
import { stallTimeout } from "./stall-timeouts";

const SERVER_DIR = join(import.meta.dirname, "..");

function bunBinary(): string {
  const realHome = userInfo().homedir;
  const rootPackage = JSON.parse(
    readFileSync(join(SERVER_DIR, "..", "..", "package.json"), "utf8"),
  );
  const version = String(rootPackage.packageManager).replace(/^bun@/, "");
  const executable = process.platform === "win32" ? "bun.exe" : "bun";
  for (const candidate of [
    join("/data", "tools", "mise", "installs", "bun", version, "bin", executable),
    join(realHome, ".local", "share", "mise", "installs", "bun", version, "bin", executable),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "bun";
}

const BUN = bunBinary();
const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

it("refuses git-sync on Windows before loading its configuration", async () => {
  await expect(run_git_sync({ kind: "git-sync", once: true }, "win32")).rejects.toThrow(
    "git-sync supports Linux and macOS only (it runs in the -git container image)",
  );
});

describe.skipIf(process.platform === "win32")("git-sync CLI", () => {
  it("boots, performs one sync, and exits for --once", () => {
    const fixture = makeGitFixture();
    const result = execFileSync(BUN, ["src/cli.ts", "git-sync", "--once"], {
      cwd: SERVER_DIR,
      env: { ...process.env, ...syncEnv(fixture) },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: stallTimeout(30_000),
    });
    expect(result).toBe("");
    expect(readFileSync(join(fixture.vault, "a.md"), "utf8")).toBe("seed\n");
  });

  it(
    "finishes an in-flight push after SIGTERM and exits zero",
    async () => {
      const fixture = makeGitFixture();
      git(fixture.root, ["clone", fixture.url, fixture.vault]);
      writeFileSync(join(fixture.vault, "shutdown.md"), "finish this push\n");
      const marker = join(fixture.root, "push-started");
      const release = join(fixture.root, "release-push");
      const bin = join(fixture.root, "bin");
      mkdirSync(bin);
      const gitWrapper = join(bin, "git");
      writeFileSync(
        gitWrapper,
        `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = push ]; then\n    touch '${marker}'\n    while [ ! -e '${release}' ]; do sleep 0.02; done\n    break\n  fi\ndone\nexec '${REAL_GIT}' "$@"\n`,
      );
      chmodSync(gitWrapper, 0o755);
      const child = spawn(BUN, ["src/cli.ts", "git-sync"], {
        cwd: SERVER_DIR,
        env: { ...process.env, ...syncEnv(fixture), PATH: `${bin}:${process.env.PATH}` },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      try {
        await waitFor(() => existsSync(marker), stallTimeout(10_000));
        expect(child.kill("SIGTERM")).toBe(true);
        writeFileSync(release, "continue\n");
        const [code, signal] = (await once(child, "exit")) as [
          number | null,
          NodeJS.Signals | null,
        ];
        expect({ code, signal, stderr }).toMatchObject({ code: 0, signal: null });
        expect(git(fixture.origin, ["show", "main:shutdown.md"])).toBe("finish this push");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    stallTimeout(15_000),
  );

  it(
    "exits zero when SIGTERM arrives during a boot operation that later fails",
    async () => {
      const fixture = makeGitFixture();
      git(fixture.root, ["clone", fixture.url, fixture.vault]);
      const marker = join(fixture.root, "fetch-started");
      const release = join(fixture.root, "release-fetch");
      const bin = join(fixture.root, "bin");
      mkdirSync(bin);
      const gitWrapper = join(bin, "git");
      writeFileSync(
        gitWrapper,
        `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = fetch ]; then\n    touch '${marker}'\n    while [ ! -e '${release}' ]; do sleep 0.02; done\n    exit 1\n  fi\ndone\nexec '${REAL_GIT}' "$@"\n`,
      );
      chmodSync(gitWrapper, 0o755);
      const child = spawn(BUN, ["src/cli.ts", "git-sync"], {
        cwd: SERVER_DIR,
        env: { ...process.env, ...syncEnv(fixture), PATH: `${bin}:${process.env.PATH}` },
        stdio: ["ignore", "ignore", "ignore"],
      });
      try {
        await waitFor(() => existsSync(marker), stallTimeout(10_000));
        expect(child.kill("SIGTERM")).toBe(true);
        writeFileSync(release, "fail now\n");
        const [code, signal] = (await once(child, "exit")) as [
          number | null,
          NodeJS.Signals | null,
        ];
        expect({ code, signal }).toEqual({ code: 0, signal: null });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    stallTimeout(15_000),
  );
});
