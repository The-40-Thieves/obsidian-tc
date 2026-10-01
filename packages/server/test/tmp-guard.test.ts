import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";
import {
  type AllowedLeftover,
  fileSlug,
  formatLeakReport,
  isEmptyDirChain,
  RUN_ROOT_PREFIX,
  STALE_RUN_ROOT_MS,
  scanLeaks,
  sweepStaleRunRoots,
  TMP_GUARD_ROOT_ENV,
} from "./tmp-guard";

const here = dirname(fileURLToPath(import.meta.url));
const vitestBin = resolve(here, "../node_modules/vitest/vitest.mjs");

// The incident (2026-09-30, Cave's / at 97%): these are the verbatim directory names that piled up
// in /tmp — ~38k of them — because nothing ever failed when a fixture skipped its teardown.
const INCIDENT_ENTRIES = [
  "obtc-m5-cache-AbC123",
  "obtc-m5-cache-xYz789",
  "obtc-reranker-auto-select-uvReAb",
  "tc-perf-lock-Q1w2E3",
  "check-redos-nested-9fGh2J",
  "where-symbol-k3L9mN",
  "otc-vec-embed-pQ4rS5",
  "verify-aaaaaa",
  "ab-bbbbbb",
  "bench-cccccc",
];

describe("scanLeaks / formatLeakReport", () => {
  it("names every leftover under a per-file directory, with its file and size", () => {
    const root = makeTempDir(RUN_ROOT_PREFIX);
    for (const entry of INCIDENT_ENTRIES) {
      mkdirSync(join(root, "test_leaky-suite", entry), { recursive: true });
    }
    writeFileSync(
      join(root, "test_leaky-suite", INCIDENT_ENTRIES[0] as string, "f.bin"),
      "x".repeat(2048),
    );
    mkdirSync(join(root, "test_clean-suite"), { recursive: true });

    const leaks = scanLeaks(root);
    expect(leaks.map((l) => l.entry).sort()).toEqual([...INCIDENT_ENTRIES].sort());
    expect(new Set(leaks.map((l) => l.file))).toEqual(new Set(["test_leaky-suite"]));
    expect(leaks.find((l) => l.entry === INCIDENT_ENTRIES[0])?.bytes).toBe(2048);

    const report = formatLeakReport(leaks);
    expect(report).toContain("10 temp entries");
    expect(report).toContain("9 place(s)");
    expect(report).toContain("test_leaky-suite/obtc-m5-cache-*  x2");
    expect(report).toContain("obtc-m5-cache x2");
    expect(report).toContain("e.g. obtc-m5-cache-AbC123 [f.bin]");
    expect(report).toContain("makeTempDir()");
  });

  it("reports nothing for a root whose test files cleaned up", () => {
    const root = makeTempDir(RUN_ROOT_PREFIX);
    mkdirSync(join(root, "test_a"));
    mkdirSync(join(root, "test_b"));
    expect(scanLeaks(root)).toEqual([]);
    expect(scanLeaks(makeTempDir(RUN_ROOT_PREFIX))).toEqual([]);
  });

  it("flags a stray file placed directly in the run root", () => {
    const root = makeTempDir(RUN_ROOT_PREFIX);
    writeFileSync(join(root, "stray.txt"), "x");
    expect(scanLeaks(root).map((l) => l.entry)).toEqual(["stray.txt"]);
  });

  it("the default allowlist exempts the setup's own HOME pin and nothing a test would create", () => {
    const root = makeTempDir(RUN_ROOT_PREFIX);
    const owned = ["otc-test-home-AbC123", "__PSScriptPolicyTest_abc.0q0.ps1"];
    for (const entry of [...owned, ...INCIDENT_ENTRIES]) {
      mkdirSync(join(root, "test_x", entry), { recursive: true });
    }
    for (const entry of owned) expect(scanLeaks(root).map((l) => l.entry)).not.toContain(entry);
    expect(scanLeaks(root)).toHaveLength(INCIDENT_ENTRIES.length);
  });

  it("exempts PowerShell Add-Type scratch dirs on win32 only, and only when they hold csc files", () => {
    const root = makeTempDir(RUN_ROOT_PREFIX);
    const dir = join(root, "test_x");
    // Verbatim from the 2026-10-01 windows-latest run: an 8-character name with csc's files inside
    // it, and the same shape already emptied.
    mkdirSync(join(dir, "xwnxn3xb"), { recursive: true });
    for (const ext of [".0.cs", ".cmdline", ".dll", ".err"]) {
      writeFileSync(join(dir, "xwnxn3xb", `xwnxn3xb${ext}`), "x");
    }
    mkdirSync(join(dir, "rldevw4j"));
    // Near-misses a test could really leave: wrong contents, wrong length, not a directory.
    mkdirSync(join(dir, "abcdefgh"));
    writeFileSync(join(dir, "abcdefgh", "vault.md"), "x");
    mkdirSync(join(dir, "abcdefg"));
    writeFileSync(join(dir, "abcdefgi"), "x");

    expect(
      scanLeaks(root, undefined, "win32")
        .map((l) => l.entry)
        .sort(),
    ).toEqual(["abcdefg", "abcdefgh", "abcdefgi"]);
    // The same names on Linux/macOS are a leak: nothing there makes them.
    expect(scanLeaks(root, undefined, "linux")).toHaveLength(5);
  });

  it("isEmptyDirChain: only a leftover with no files in it, however deep", () => {
    const root = makeTempDir(RUN_ROOT_PREFIX);
    mkdirSync(join(root, "test_x", "otc-home-AbC123", "AppData", "Roaming"), { recursive: true });
    mkdirSync(join(root, "test_x", "otc-home-DeF456", "AppData", "Roaming"), { recursive: true });
    writeFileSync(join(root, "test_x", "otc-home-DeF456", "AppData", "Roaming", "a.json"), "");
    mkdirSync(join(root, "test_x", "obtc-bare-GhI789"));
    writeFileSync(join(root, "test_x", "obtc-file-JkL012"), "");
    const byEntry = new Map(scanLeaks(root).map((l) => [l.entry, isEmptyDirChain(l)]));
    expect(byEntry.get("otc-home-AbC123")).toBe(true);
    // a zero-byte FILE is still a file; a bare empty directory has no nested path to show for itself
    expect(byEntry.get("otc-home-DeF456")).toBe(false);
    expect(byEntry.get("obtc-file-JkL012")).toBe(false);
    expect(byEntry.get("obtc-bare-GhI789")).toBe(false);
  });

  it("reports a tool's nested debris down to its first leaf", () => {
    const root = makeTempDir(RUN_ROOT_PREFIX);
    mkdirSync(join(root, "test_x", "otc-home-AbC123", "AppData", "Local"), { recursive: true });
    writeFileSync(join(root, "test_x", "otc-home-AbC123", "AppData", "Local", "p.bin"), "x");
    expect(formatLeakReport(scanLeaks(root))).toContain("[AppData/Local/p.bin]");
  });

  it("an allowlist entry exempts only what it matches", () => {
    const root = makeTempDir(RUN_ROOT_PREFIX);
    mkdirSync(join(root, "test_x", "shared-model-cache"), { recursive: true });
    mkdirSync(join(root, "test_x", "obtc-m5-cache-AbC123"), { recursive: true });
    const allow: AllowedLeftover[] = [
      { entry: /^shared-model-cache$/, reason: "shared by design, test fixture" },
    ];
    expect(scanLeaks(root, allow).map((l) => l.entry)).toEqual(["obtc-m5-cache-AbC123"]);
  });
});

describe("sweepStaleRunRoots", () => {
  it("removes only obtc-run-* roots older than the cutoff (a killed run's leftovers)", () => {
    const base = makeTempDir("obtc-sweep-base-");
    const old = join(base, `${RUN_ROOT_PREFIX}old111`);
    const fresh = join(base, `${RUN_ROOT_PREFIX}new222`);
    const foreign = join(base, "someone-elses-dir");
    for (const d of [old, fresh, foreign]) mkdirSync(join(d, "inner"), { recursive: true });
    const longAgo = new Date(Date.now() - STALE_RUN_ROOT_MS - 60_000);
    for (const d of [old, foreign]) utimesSync(d, longAgo, longAgo);

    expect(sweepStaleRunRoots(base)).toEqual([`${RUN_ROOT_PREFIX}old111`]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // a concurrent run's live root
    expect(existsSync(foreign)).toBe(true); // not ours, however old
  });
});

describe("fileSlug", () => {
  it("is relative to the package root, filesystem-safe and bounded", () => {
    expect(fileSlug("/pkg/test/acl-path.test.ts", "/pkg")).toBe("test_acl-path");
    expect(fileSlug(undefined, "/pkg")).toBe("unknown-file");
    const long = fileSlug(`/pkg/test/${"a".repeat(200)}.test.ts`, "/pkg");
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("run-scoped TMPDIR (the globalSetup + setup pair is active for this very file)", () => {
  it("tmpdir() sits under the run's private root, in a directory named for this file", () => {
    const runRoot = process.env[TMP_GUARD_ROOT_ENV];
    expect(runRoot).toBeTruthy();
    expect(tmpdir().startsWith(runRoot as string)).toBe(true);
    expect(tmpdir()).toContain("tmp-guard");
  });
});

describe("makeTempDir", () => {
  it("creates under tmpdir() and rmTemp removes it", () => {
    const dir = makeTempDir("obtc-helper-");
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dir)).toBe(true);
    rmTemp(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

// The gate itself, end to end: a child vitest run in a scratch project that has the SAME
// globalSetup/setup pair. Without these, a gate that silently stopped failing would look exactly
// like a clean suite.
describe("the leak gate in a child vitest run", () => {
  function runChild(testBody: string): { code: number; out: string } {
    const proj = makeTempDir("obtc-guard-child-");
    const url = (f: string) => JSON.stringify(pathToFileURL(resolve(here, f)).href);
    writeFileSync(
      join(proj, "vitest.config.mjs"),
      `export default { test: { globals: true, include: ["*.test.mjs"], environment: "node",
        globalSetup: [${JSON.stringify(resolve(here, "tmp-guard-global-setup.ts"))}],
        setupFiles: [${JSON.stringify(resolve(here, "tmp-guard-setup.ts"))}] } };\n`,
    );
    writeFileSync(
      join(proj, "child.test.mjs"),
      `import { mkdtempSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\n` +
        `const { makeTempDir } = await import(${url("tmp.ts")});\n${testBody}\n`,
    );
    // The child must start its OWN guard root, not inherit this file's.
    // Its own tmp base too, inside `proj`, so whatever the child's vitest leaves in it (its module
    // cache directory, on some OSes) is removed with `proj` instead of landing in this file's gate.
    const childTmp = join(proj, "tmp");
    mkdirSync(childTmp);
    const { [TMP_GUARD_ROOT_ENV]: _inherited, ...inherited } = process.env;
    const env = { ...inherited, NO_COLOR: "1", TMPDIR: childTmp, TMP: childTmp, TEMP: childTmp };
    const r = spawnSync(process.execPath, [vitestBin, "run", "--root", proj], {
      cwd: proj,
      encoding: "utf8",
      env,
      timeout: stallTimeout(60_000),
    });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  it("FAILS the run and names the file + dir when a test leaves a raw mkdtemp behind", () => {
    const r = runChild(
      `it("leaks", () => { mkdtempSync(join(tmpdir(), "obtc-m5-cache-")); expect(1).toBe(1); });`,
    );
    expect(r.out).toContain("[tmp-guard]");
    expect(r.out).toMatch(/child\/obtc-m5-cache-\*/);
    expect(r.code).not.toBe(0);
  }, 60_000);

  it("passes when the fixture goes through makeTempDir, even though the test never removes it", () => {
    const r = runChild(
      `it("tidy", () => { const d = makeTempDir("obtc-m5-cache-"); expect(d.length).toBeGreaterThan(0); });`,
    );
    expect(r.out).not.toContain("[tmp-guard]");
    expect(r.code).toBe(0);
  }, 60_000);
});
