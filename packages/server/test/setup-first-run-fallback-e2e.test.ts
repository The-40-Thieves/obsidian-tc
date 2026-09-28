// PR B of GH #995's two-part follow-up: end-to-end tests for the first-run fallback — the REAL
// detect()/decideSetup()/writeSetupConfig() path (test/setup-first-run-fallback.test.ts covers the
// pure gating/formatting logic in isolation). Mirrors test/setup-e2e.test.ts's own
// `fakeObsidianEnv` fixture so `resolveCapabilityProfile`'s real locateRegistry() finds exactly
// what each test sets up, never anything on the real host running these tests.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registryCandidates } from "../src/capability/locate";
import { defaultSetupConfigPath } from "../src/cli/resolve-config";
import {
  attemptFirstRunFallback,
  shouldAttemptFirstRunFallback,
} from "../src/cli/setup/first-run-fallback";
import { loadConfig } from "../src/config/load";
import { rmTemp, stubHomedir } from "./tmp";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "first-run-fallback-probe.ts");
// Same "bun expected on every dev/CI box, skip rather than fail when genuinely absent" guard as
// vault-lock.test.ts's own.
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

// Same HOME/USERPROFILE-cache trap setup-e2e.test.ts documents — restored per-KEY, never via a
// whole `process.env = {...}` reassignment.
const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_APPDATA = process.env.APPDATA;
let restoreHome: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("ECONNREFUSED (stubbed — no Ollama in tests)"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreHome?.();
  restoreHome = undefined;
  if (ORIGINAL_XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG_CONFIG_HOME;
  if (ORIGINAL_APPDATA === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = ORIGINAL_APPDATA;
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* best-effort */
    }
  }
});

/** Same fixture as setup-e2e.test.ts's own `fakeObsidianEnv` — a fake HOME + registry with the
 *  given vault ids, so `resolveCapabilityProfile`'s real locator finds exactly this. */
function fakeObsidianEnv(vaultIds: string[]): { home: string; vaultPaths: Record<string, string> } {
  const home = tmpDir("otc-first-run-home-");
  const xdgConfig = tmpDir("otc-first-run-xdg-");
  restoreHome = stubHomedir(home);
  process.env.XDG_CONFIG_HOME = xdgConfig;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  const registryPath = registryCandidates(process.platform, process.env, home)[0];
  if (registryPath === undefined) {
    throw new Error(`no obsidian.json registry candidate for platform ${process.platform}`);
  }
  const vaultPaths: Record<string, string> = {};
  const vaults: Record<string, { path: string; open: boolean }> = {};
  for (const id of vaultIds) {
    const p = tmpDir(`otc-first-run-vault-${id}-`);
    vaultPaths[id] = p;
    vaults[id] = { path: p, open: true };
  }
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ vaults }));
  return { home, vaultPaths };
}

describe("attemptFirstRunFallback — exactly one vault", () => {
  it("writes a config and reports it as written; the config boots through the real loader", async () => {
    const { home, vaultPaths } = fakeObsidianEnv(["main"]);

    const result = await attemptFirstRunFallback();

    expect(result.outcome).toBe("written");
    if (result.outcome !== "written") throw new Error("unreachable");
    expect(result.path).toBe(defaultSetupConfigPath());
    expect(result.config.vaults).toMatchObject([{ id: "main", path: vaultPaths.main }]);
    // Boots through the REAL loader, not just the in-memory result — same property
    // test/setup-e2e.test.ts asserts for `obsidian-tc setup` itself.
    const loaded = loadConfig(result.path);
    expect(loaded.vaults[0]?.id).toBe("main");
    // PR B's own provenance marker — read the raw file directly (setupOrigin is a plain schema
    // field, but this asserts it landed on DISK, not just in the parsed return value).
    const onDisk = JSON.parse(readFileSync(result.path, "utf8"));
    expect(onDisk.setupOrigin).toBe("first-run-fallback");
    void home;
  });
});

describe("attemptFirstRunFallback — declines and writes nothing", () => {
  it("declines with 0 vaults found (no registry entries)", async () => {
    fakeObsidianEnv([]);

    const result = await attemptFirstRunFallback();

    expect(result.outcome).toBe("declined");
    expect(existsSync(defaultSetupConfigPath())).toBe(false);
  });

  it("declines with >=2 vaults found (ambiguous)", async () => {
    fakeObsidianEnv(["main", "second"]);

    const result = await attemptFirstRunFallback();

    expect(result.outcome).toBe("declined");
    if (result.outcome === "declined") {
      expect(result.reason).toMatch(/2 vaults/);
    }
    expect(existsSync(defaultSetupConfigPath())).toBe(false);
  });
});

describe("attemptFirstRunFallback — concurrency", () => {
  it("two concurrent first-runs converge on ONE file and both get a usable config back", async () => {
    const { vaultPaths } = fakeObsidianEnv(["main"]);

    const [a, b] = await Promise.all([attemptFirstRunFallback(), attemptFirstRunFallback()]);

    // Exactly one of the two actually created the file; the other re-read it (raced).
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["raced", "written"]);
    // Both booted with the SAME resolved config, off the SAME single file.
    for (const r of [a, b]) {
      if (r.outcome === "declined") throw new Error("unreachable — both must succeed");
      expect(r.path).toBe(defaultSetupConfigPath());
      expect(r.config.vaults).toMatchObject([{ id: "main", path: vaultPaths.main }]);
    }
    expect(existsSync(defaultSetupConfigPath())).toBe(true);
  });

  // Finding 2 (fix round, cross-vendor review): the in-process test above cannot actually overlap
  // the create — `writeSetupConfig` is fully synchronous, so `Promise.all` on two calls in ONE
  // process only ever exercises "the file already existed at the opening `existsSync`", never a
  // real `linkSync`/`wx` EEXIST race. This spawns two REAL OS processes (bun) against the SAME
  // HOME/registry, launched as close together as `spawn` allows, and asserts the SAME "exactly one
  // written, one raced, both boot the identical config" invariant against genuine concurrency.
  it.runIf(bunAvailable)(
    "two REAL concurrent processes racing the same first-run converge on ONE file",
    async () => {
      const { vaultPaths } = fakeObsidianEnv(["main"]);

      const runProbe = (): Promise<{ code: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve) => {
          const child = spawn("bun", [PROBE], { env: process.env, stdio: "pipe" });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => {
            stdout += String(d);
          });
          child.stderr.on("data", (d) => {
            stderr += String(d);
          });
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        });

      const [a, b] = await Promise.all([runProbe(), runProbe()]);
      expect(a.code, `probe A stderr: ${a.stderr}`).toBe(0);
      expect(b.code, `probe B stderr: ${b.stderr}`).toBe(0);
      const resultA = JSON.parse(a.stdout.trim().split("\n").pop() ?? "{}");
      const resultB = JSON.parse(b.stdout.trim().split("\n").pop() ?? "{}");

      const outcomes = [resultA.outcome, resultB.outcome].sort();
      expect(outcomes).toEqual(["raced", "written"]);
      for (const r of [resultA, resultB]) {
        expect(r.path).toBe(defaultSetupConfigPath());
        expect(r.vaultIds).toEqual(["main"]);
      }
      expect(existsSync(defaultSetupConfigPath())).toBe(true);
      const onDisk = JSON.parse(readFileSync(defaultSetupConfigPath(), "utf8"));
      expect(onDisk.vaults).toMatchObject([{ id: "main", path: vaultPaths.main }]);
    },
    20_000,
  );
});

describe("attemptFirstRunFallback — race read retries past a genuinely-overlapping partial file", () => {
  // Finding 4 (fix round, cross-vendor review): the in-process concurrency test above cannot
  // actually overlap `writeSetupConfig`'s own synchronous write with a racing reader — this test
  // does, directly, against `readRacedConfigFile`'s real code path: pre-create the target as an
  // unparseable file (the exact shape a still-in-flight `wx`-fallback write, or a genuinely
  // racing writer, leaves behind), let `attemptFirstRunFallback` hit its own "already exists ->
  // race-read" branch, and complete the file to valid JSON from a REAL `setTimeout` running
  // concurrently with the retry loop's `await sleep(...)` — genuine event-loop overlap, not a
  // synchronous illusion of one. A retry loop that reads once and throws immediately on the
  // initial `SyntaxError` (rather than retrying) fails this test: the valid content never lands
  // before that first read.
  it("succeeds once the racing writer's content lands mid-retry, not just when it was already there", async () => {
    const { vaultPaths } = fakeObsidianEnv(["main"]);
    const target = defaultSetupConfigPath();
    mkdirSync(dirname(target), { recursive: true });
    // An empty file: exactly what a crash between `openSync(target, "wx")` and a completed
    // `writeSync` (write.ts's own "finding 1" comment) — or a genuinely racing writer mid-flight —
    // leaves at this exact path. `JSON.parse("")` throws `SyntaxError`.
    writeFileSync(target, "");
    const validRaw = JSON.stringify({
      vaults: [{ id: "main", path: vaultPaths.main }],
      cacheDir: dirname(target),
    });
    // 500ms: comfortably longer than `detect()`'s own real async overhead (registry/hardware
    // probes; the Ollama probe is stubbed to reject instantly via the module-level `fetch` mock
    // above) reaching the first read, and comfortably inside the 2s/20ms retry budget — a
    // non-retrying read throws on that first attempt, long before this timer fires.
    setTimeout(() => writeFileSync(target, validRaw), 500);

    const result = await attemptFirstRunFallback();

    expect(result.outcome).toBe("raced");
    if (result.outcome !== "raced") throw new Error("unreachable");
    expect(result.path).toBe(target);
    expect(result.config.vaults).toMatchObject([{ id: "main", path: vaultPaths.main }]);
  });
});

describe("attemptFirstRunFallback — winner and loser boot through the same finalizeConfig path", () => {
  const ORIGINAL_JWT_SECRET = process.env.OBSIDIAN_TC_JWT_SECRET;
  afterEach(() => {
    if (ORIGINAL_JWT_SECRET === undefined) delete process.env.OBSIDIAN_TC_JWT_SECRET;
    else process.env.OBSIDIAN_TC_JWT_SECRET = ORIGINAL_JWT_SECRET;
  });

  it("finding 3: the WINNER's config carries an env overlay (OBSIDIAN_TC_JWT_SECRET), same as a plain loadConfig would", async () => {
    fakeObsidianEnv(["main"]);
    const secret = "test-secret-from-env-0123456789x";
    process.env.OBSIDIAN_TC_JWT_SECRET = secret;

    const result = await attemptFirstRunFallback();

    expect(result.outcome).toBe("written");
    if (result.outcome === "declined") throw new Error("unreachable");
    // `writeSetupConfig`'s own `ServerConfigSchema.parse(raw)` never applies env overlays — this
    // is exactly the divergence finding 3 named: without the fix, the winner's in-memory config
    // has no jwtSecret at all here, even though the file it just wrote plus a plain restart
    // (`loadConfig`) would pick one up.
    expect(result.config.auth?.jwtSecret).toBe(secret);
    // A fresh load off the same file agrees — same source of truth, not a coincidence.
    const reloaded = loadConfig(result.path);
    expect(reloaded.auth?.jwtSecret).toBe(secret);
  });
});

describe("attemptFirstRunFallback — ambiguous registry with a stat-unreachable entry", () => {
  it("finding 4: declines when the registry named 2 vaults even though only 1 currently stats", async () => {
    const { vaultPaths } = fakeObsidianEnv(["main", "missing"]);
    const missingVaultPath = vaultPaths.missing;
    if (missingVaultPath === undefined) throw new Error("unreachable — fixture always sets it");
    // Simulate "missing"'s vault having been unplugged/deleted AFTER it was registered with
    // Obsidian: the registry entry survives, the directory does not.
    rmSync(missingVaultPath, { recursive: true, force: true });

    const result = await attemptFirstRunFallback();

    expect(result.outcome).toBe("declined");
    if (result.outcome !== "declined") throw new Error("unreachable");
    expect(result.reason).toMatch(/2 vaults/);
    expect(existsSync(defaultSetupConfigPath())).toBe(false);
  });
});

describe("shouldAttemptFirstRunFallback — existing config on disk", () => {
  it("is false once the default config path already exists", () => {
    const home = tmpDir("otc-first-run-existing-home-");
    restoreHome = stubHomedir(home);
    const target = defaultSetupConfigPath();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ vaults: [{ id: "main", path: home }] }));

    expect(shouldAttemptFirstRunFallback({ input: undefined, env: {} })).toBe(false);
  });
});
