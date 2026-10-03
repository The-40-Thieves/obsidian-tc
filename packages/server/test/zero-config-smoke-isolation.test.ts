import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertStateUnderHome,
  createIsolatedHome,
  isolatedHomeEnv,
  isUnder,
  removeTree,
  waitForPidExit,
} from "../scripts/lib/isolated-home.mjs";
import { runBunSync } from "./spawn-cli";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

/** Relative path -> sha256 for every file under `dir`, so "byte-identical" is a real comparison. */
function snapshot(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const next = join(rel, entry.name);
    if (entry.isDirectory()) Object.assign(out, snapshot(dir, next));
    else
      out[next] = createHash("sha256")
        .update(readFileSync(join(dir, next)))
        .digest("hex");
  }
  return out;
}

describe("isolated-home helper", () => {
  it("points HOME, USERPROFILE, every XDG dir and APPDATA/LOCALAPPDATA under the given home", () => {
    const env = isolatedHomeEnv("/h");
    expect(Object.keys(env).sort()).toEqual([
      "APPDATA",
      "HOME",
      "LOCALAPPDATA",
      "USERPROFILE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ]);
    for (const value of Object.values(env)) expect(isUnder(value, "/h")).toBe(true);
  });

  it("creates a home under the temp root, never the real one, and cleanup removes it", () => {
    const iso = createIsolatedHome("obtc-iso-test-");
    try {
      expect(existsSync(iso.home)).toBe(true);
      expect(iso.env.HOME).toBe(iso.home);
      expect(iso.home).not.toBe(homedir());
    } finally {
      iso.cleanup();
    }
    expect(existsSync(iso.root)).toBe(false);
  });

  it("assertStateUnderHome fails when the child created no state under the home", () => {
    const iso = createIsolatedHome("obtc-iso-test-");
    try {
      expect(() => assertStateUnderHome(iso.home)).toThrow(
        /did not resolve under the isolated home/,
      );
      mkdirSync(join(iso.home, ".obsidian-tc"));
      writeFileSync(join(iso.home, ".obsidian-tc", "cache.db"), "");
      expect(() => assertStateUnderHome(iso.home)).not.toThrow();
    } finally {
      iso.cleanup();
    }
  });
});

describe("isolated-home teardown helpers", () => {
  // The incident (windows-latest, 2026-10-02/03): the smoke's server child was SIGTERMed and its
  // transport closed, but the process itself was still going when the script's exit handler removed
  // the fixture vault and the isolated home, so 4-8 MB of bun cache and the vault outlived the test.
  it("waitForPidExit resolves true only once the process is really gone", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600)"], { stdio: "ignore" });
    const pid = child.pid as number;
    const started = Date.now();
    expect(await waitForPidExit(pid, stallTimeout(20_000))).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400); // stall-ok: lower bound on the child's life
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("waitForPidExit gives up (false) on a process that outlives the budget", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      expect(await waitForPidExit(child.pid as number, 300)).toBe(false); // stall-ok: the budget under test
    } finally {
      child.kill();
    }
  });

  it("removeTree removes a nested tree and tolerates one that is already gone", () => {
    const dir = makeTempDir("otc-remove-tree-");
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "f.txt"), "x");
    removeTree(dir);
    expect(existsSync(dir)).toBe(false);
    expect(() => removeTree(dir)).not.toThrow();
  });
});

describe("zero-config smoke never touches the real home", () => {
  it("passes twice in a row against a fake real home holding a conflicting state, leaving it byte-identical", () => {
    const fake = makeTempDir("otc-smoke-fake-home-");
    try {
      const fakeHome = join(fake, "home");
      const otherVault = join(fake, "other-vault");
      mkdirSync(fakeHome);
      mkdirSync(otherVault);
      writeFileSync(join(otherVault, "x.md"), "# x\n");
      const homeEnv = { HOME: fakeHome, USERPROFILE: fakeHome };

      // Seed `~/.obsidian-tc` with vault id "main" recorded against a DIFFERENT path: exactly the
      // state an earlier smoke run left on the operator's machine.
      runBunSync(["src/cli.ts", otherVault], {
        env: homeEnv,
        cwd: PACKAGE_ROOT,
        timeoutMs: 30_000,
      });
      expect(existsSync(join(fakeHome, ".obsidian-tc", "cache.db"))).toBe(true);
      // Only the operator's own state dir: the `bun` runner itself caches under $HOME/.bun.
      const state = join(fakeHome, ".obsidian-tc");
      const before = snapshot(state);

      for (const run of [1, 2]) {
        const r = spawnSync(
          "bun",
          ["scripts/zero-config-smoke.ts", "--cli", "src/cli.ts", "--runtime", "bun"],
          {
            cwd: PACKAGE_ROOT,
            encoding: "utf8",
            timeout: stallTimeout(60_000),
            env: { ...process.env, ...homeEnv },
          },
        );
        expect(r.stderr, `run ${run}`).toContain("PASS: zero-config smoke");
        expect(r.stderr, `run ${run}`).toContain("state dir resolved under the isolated home");
        expect(r.status, `run ${run}: ${r.stderr}`).toBe(0);
      }
      expect(snapshot(state)).toEqual(before);
    } finally {
      rmTemp(fake);
    }
  }, 180_000);
});
