// Every git child of the server suite must run with git auto maintenance off. A commit otherwise
// starts a detached `git maintenance run --auto`, which can outlive the test that made the repo and
// recreate its directory after the test removed it (the tmp-guard leak on merge-group run
// 38997383655). git-maintenance-setup.ts switches it off in process.env, which every worker and
// every git child spawned with the default env inherits.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const MAINTENANCE_KEY = /^GIT_CONFIG_KEY_\d+$/;

describe("git auto maintenance is off for the server suite", () => {
  it("a commit made through process.env starts no detached maintenance run", () => {
    const repo = makeTempDir("obtc-gitmaint-");
    try {
      const env = {
        ...process.env,
        GIT_TRACE: "1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      };
      const run = (args: string[]) =>
        spawnSync("git", args, {
          cwd: repo,
          env,
          encoding: "utf8",
          timeout: stallTimeout(30_000),
        });
      expect(run(["init", "-q"]).status).toBe(0);
      writeFileSync(join(repo, "a.md"), "x\n");
      expect(run(["add", "a.md"]).status).toBe(0);
      const commit = run(["commit", "-q", "-m", "m"]);
      expect(commit.status).toBe(0);
      expect(commit.stderr).not.toMatch(/maintenance run/);
    } finally {
      rmTemp(repo);
    }
  });

  it("the setup leaves exactly one maintenance.auto=false entry in process.env", () => {
    const entries = Object.keys(process.env).filter(
      (key) => MAINTENANCE_KEY.test(key) && process.env[key] === "maintenance.auto",
    );
    expect(entries).toHaveLength(1);
    const index = entries[0]?.split("_").at(-1);
    expect(process.env[`GIT_CONFIG_VALUE_${index}`]).toBe("false");
  });
});
