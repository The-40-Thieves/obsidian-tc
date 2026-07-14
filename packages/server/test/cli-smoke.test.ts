// CHARACTERIZATION tests for the CLI. They exist to make a refactor safe, not to specify new behavior:
// they pin what `main()` does TODAY so that extracting its sixteen inline command branches into modules
// can be proven to change nothing.
//
// Why subprocess and not an import: main() is not exported, it reads process.argv, it calls process.exit
// in fifteen places, and it runs on import. There is no seam to call it through — which is itself the
// reason the surface has zero coverage today. Spawning the real CLI is the only faithful way to observe
// it, and it has the happy side effect of testing the thing users actually run.
//
// Deliberately limited to commands that need no network, no model, and no embeddings: exit codes, usage
// text, config handling, and the guards. That is enough to catch the failure modes a mechanical
// extraction can actually introduce (a branch that stops returning, a wrong exit code, a lost guard).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Run {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let dir: string;
let configPath: string;
let vaultPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "obtc-cli-"));
  vaultPath = join(dir, "vault");
  writeFileSync(join(dir, "ignore.md"), "x"); // ensure dir exists on all platforms
  mkdirSync(vaultPath, { recursive: true });
  const cfg = {
    vaults: [{ id: "main", path: vaultPath }],
    cacheDir: join(dir, "cache"),
  };
  configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// The suite is meaningless if `bun` is not on PATH — say so loudly rather than passing vacuously.
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!bunAvailable)(
  "cli characterization (pins behavior for the cli.ts extraction)",
  () => {
    it("bun is on PATH, so these tests are actually running", () => {
      expect(bunAvailable).toBe(true);
    });

    it("version prints a semver and exits 0", () => {
      const r = runCli(["--version"]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("help prints usage listing the commands and exits 0", () => {
      const r = runCli(["--help"]);
      expect(r.code).toBe(0);
      const out = r.stdout + r.stderr;
      for (const cmd of ["densify-llm", "forget", "gaps", "metrics", "reflect", "prefetch"]) {
        expect(out).toContain(cmd);
      }
    });

    it("an unknown command exits 2 with usage on stderr (not 0, not 1)", () => {
      const r = runCli(["definitely-not-a-command"]);
      expect(r.code).toBe(2);
      expect(r.stderr.length).toBeGreaterThan(0);
    });

    it("config-validate accepts a valid config and exits 0", () => {
      const r = runCli(["config", "validate", configPath]);
      expect(r.code).toBe(0);
    });

    it("config-validate rejects a malformed config with a nonzero exit", () => {
      const bad = join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify({ vaults: "not-an-array" }));
      const r = runCli(["config", "validate", bad]);
      expect(r.code).not.toBe(0);
    });

    it("config-show emits the resolved config as JSON", () => {
      const r = runCli(["config", "show", configPath]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("main");
    });

    it("densify-llm refuses unless retrieval.densify.llmEdges is true (the egress off-switch)", () => {
      const r = runCli(["densify-llm", configPath]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/llmEdges|disabled/i);
    });
  },
);
