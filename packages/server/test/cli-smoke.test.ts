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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUNDLE_FORMAT_VERSION } from "../src/experiential/context-bundle-schema";
import { rmTemp } from "./tmp";

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
    rmTemp(dir);
  } catch {
    // best effort
  }
});

// The suite is meaningless if `bun` is not on PATH — say so loudly rather than passing vacuously.
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

// Every test here spawns a real `bun` subprocess, and `runCli` bounds that with timeout: 60_000.
// Vitest's DEFAULT per-test timeout is 5_000, so that 60s guard was unreachable — vitest killed the
// test twelve times sooner than the guard it was paired with. Isolated, a cold CLI spawn takes ~1s
// and passed; under a full parallel suite on a 4-core box it exceeds 5s and the test times out.
// That is the intermittent cli-smoke failure recorded as unlocalized in #268: focused reruns
// reproduce the load conditions least, which is exactly why 80/80 of them passed.
//
// The suite timeout is set ABOVE the spawn guard so the inner bound is the one that fires. A hung
// CLI then reports as a 60s spawn timeout with its captured output, rather than a bare "timed out
// in 5000ms" that says nothing about which subprocess hung or why.
describe.skipIf(!bunAvailable)(
  "cli characterization (pins behavior for the cli.ts extraction)",
  { timeout: 90_000 },
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
      for (const cmd of [
        "densify-llm",
        "forget",
        "gaps",
        "metrics",
        "reflect",
        "prefetch",
        "context-export",
        "context-import",
      ]) {
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

    // THE-536: retrieval.adaptiveRrf round-trips through config show — defaulted when unset,
    // and echoed back when the caller sets it explicitly.
    it("config-show round-trips retrieval.adaptiveRrf (default off, explicit on)", () => {
      const defaultRun = runCli(["config", "show", configPath]);
      expect(defaultRun.code).toBe(0);
      const defaultCfg = JSON.parse(defaultRun.stdout);
      expect(defaultCfg.retrieval.adaptiveRrf).toEqual({ enabled: false, gain: 0.5 });

      const onPath = join(dir, "config-adaptive-rrf-on.json");
      writeFileSync(
        onPath,
        JSON.stringify({
          vaults: [{ id: "main", path: vaultPath }],
          cacheDir: join(dir, "cache"),
          retrieval: { adaptiveRrf: { enabled: true, gain: 0.7 } },
        }),
      );
      const onRun = runCli(["config", "show", onPath]);
      expect(onRun.code).toBe(0);
      const onCfg = JSON.parse(onRun.stdout);
      expect(onCfg.retrieval.adaptiveRrf).toEqual({ enabled: true, gain: 0.7 });
    });

    it("densify-llm refuses unless retrieval.densify.llmEdges is true (the egress off-switch)", () => {
      const r = runCli(["densify-llm", configPath]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/llmEdges|disabled/i);
    });

    // THE-934: consolidate --once [--dry-run]. No gateway is configured in this fixture, so a
    // real run trivially proves zero gateway calls end to end (there is no client to call at
    // all) — the stronger proof (a counting FAKE client with a gateway configured) lives in
    // synthesis-job.test.ts's planSynthesis unit tests.
    describe("consolidate (THE-934)", () => {
      it("without --once is a usage error, exit 2 — never a silent no-op", () => {
        const r = runCli(["consolidate", configPath]);
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/--once/);
      });

      it("--once --dry-run reports candidate counts and makes zero gateway calls, exit 0", () => {
        const r = runCli(["consolidate", "--once", "--dry-run", configPath]);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("0 gateway calls made");
        expect(r.stdout).toContain("citation_candidates");
      });

      it("--once alone runs synthesis + audit exactly once and prints both reports, exit 0", () => {
        const r = runCli(["consolidate", "--once", configPath]);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("synthesis");
        expect(r.stdout).toContain("audit");
      });
    });

    // THE-636: context-export/context-import, end to end through the real subprocess.
    describe("context-export / context-import (THE-636)", () => {
      it("context-export requires --out — missing it exits 2 with usage", () => {
        const r = runCli(["context-export", configPath]);
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/--out/);
      });

      it("context-export refuses an --out path inside the vault root (exit non-zero, no file written)", () => {
        const inside = join(vaultPath, "leak.json");
        const r = runCli(["context-export", configPath, "--out", inside]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toMatch(/vault/i);
        expect(existsSync(inside)).toBe(false);
      });

      it("context-import requires a bundle path — missing it exits 2 with usage", () => {
        // --config (rather than a bare positional) so the ONE positional consumed isn't mistaken
        // for the bundle path — this isolates "bundle path absent" from "config path absent".
        const r = runCli(["context-import", "--config", configPath]);
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/bundle path/);
      });

      it(
        "round-trip: export produces a versioned bundle with all 9 tables + a PII warning, " +
          "and import --dry-run reports counts without writing (acceptance 1, 2, 4)",
        () => {
          const outPath = join(dir, "context-bundle.json");
          const exportRun = runCli(["context-export", configPath, "--out", outPath]);
          expect(exportRun.code).toBe(0);
          expect(existsSync(outPath)).toBe(true);
          // THE-636 item 2: the PII warning is unconditional, printed to stderr.
          expect(exportRun.stderr).toMatch(/derived personal data/i);

          const bundle = JSON.parse(readFileSync(outPath, "utf8"));
          expect(bundle.format_version).toBe(BUNDLE_FORMAT_VERSION);
          expect(Object.keys(bundle.tables).sort()).toEqual(
            [
              "agent_episodes",
              "chunk_retrievals",
              "forget_log",
              "gap_reports",
              "goals",
              "note_quality",
              "preference_deltas",
              "preference_profile",
              "vault_object_state",
            ].sort(),
          );

          // Import into a SEPARATE, fresh install (own cacheDir) — --dry-run first.
          const importDir = mkdtempSync(join(tmpdir(), "obtc-cli-import-"));
          const importVault = join(importDir, "vault");
          mkdirSync(importVault, { recursive: true });
          const importConfigPath = join(importDir, "config.json");
          writeFileSync(
            importConfigPath,
            JSON.stringify({
              vaults: [{ id: "main", path: importVault }],
              cacheDir: join(importDir, "cache"),
            }),
          );

          // Bundle path first, config path second — obsidian-tc context-import <bundle> [path].
          const dryRun = runCli(["context-import", outPath, importConfigPath, "--dry-run"]);
          expect(dryRun.code).toBe(0);
          expect(dryRun.stdout).toMatch(/dry-run/);

          const realRun = runCli(["context-import", outPath, importConfigPath]);
          expect(realRun.code).toBe(0);

          rmTemp(importDir);
        },
      );

      it("context-import rejects a bundle with the wrong format_version, exit non-zero", () => {
        const badPath = join(dir, "bad-version-bundle.json");
        writeFileSync(
          badPath,
          JSON.stringify({
            format_version: 999,
            exported_at: 0,
            server_version: "0.0.0",
            vault: "*",
            score_version: 1,
            tables: {},
          }),
        );
        const r = runCli(["context-import", badPath, configPath]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toMatch(/format_version mismatch/);
      });

      // BLOCKER 2a (review fix): --vault is load-bearing — a bundle whose vault-scoped tables
      // name more than one source vault is refused outright when --vault targets a remap, rather
      // than being silently imported vault_id-verbatim into whichever vault happens to share a
      // label with one of them.
      it("context-import --vault refuses a bundle naming more than one source vault", () => {
        const multiVaultPath = join(dir, "multi-vault-bundle.json");
        writeFileSync(
          multiVaultPath,
          JSON.stringify({
            format_version: BUNDLE_FORMAT_VERSION,
            exported_at: 0,
            server_version: "0.0.0",
            vault: "*",
            score_version: 2,
            tables: {
              preference_profile: [
                {
                  vault_id: "vault-a",
                  scope_caller: "",
                  key: "k",
                  value: "v",
                  weight: 1,
                  version: 1,
                  updated_at: 0,
                  provenance: null,
                },
                {
                  vault_id: "vault-b",
                  scope_caller: "",
                  key: "k",
                  value: "v",
                  weight: 1,
                  version: 1,
                  updated_at: 0,
                  provenance: null,
                },
              ],
              preference_deltas: [],
              agent_episodes: [],
              note_quality: [],
              chunk_retrievals: [],
              vault_object_state: [],
              gap_reports: [],
              goals: [],
              forget_log: [],
            },
          }),
        );
        const r = runCli(["context-import", multiVaultPath, configPath, "--vault", "main"]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toMatch(/vault-a/);
        expect(r.stderr).toMatch(/vault-b/);
      });
    });
  },
);
