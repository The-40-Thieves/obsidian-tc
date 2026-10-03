// `obsidian-tc setup` end to end (PR A of GH #995's two-part follow-up): runs the REAL run_setup
// path against a temp HOME/XDG_CONFIG_HOME with a fake obsidian.json registry, and asserts the
// written config loads through the REAL loader (config/load.ts's loadConfig) and that `config show`
// reports the effective embeddings source as "configured" — the exact GH #995 property this command
// exists to establish: a decision `setup` writes down must never look like something boot merely
// defaulted to or kept.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registryCandidates } from "../src/capability/locate";
import { run_config_show } from "../src/cli/commands/config-show";
import { run_setup } from "../src/cli/commands/setup";
import { resolveServeConfigWithProvenance } from "../src/cli/resolve-config";
import { loadConfig } from "../src/config/load";
import { makeTempDir, rmTemp, stubHomedir } from "./tmp";

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = makeTempDir(prefix);
  tmpDirs.push(d);
  return d;
};

// Restored per-KEY in afterEach below, never via a whole `process.env = {...}` reassignment: Node's
// `os.homedir()` caches its result after the first call in a process and only re-reads `HOME` on a
// direct property WRITE (`process.env.HOME = ...`) — replacing the whole `process.env` object
// breaks that invalidation hook, so every later test's `homedir()` (and this command's own
// `defaultSetupConfigPath`/`resolveCapabilityProfile`, which both call it) would keep returning the
// FIRST test's HOME forever, silently pointing every later write at the wrong directory. Measured
// directly: `node -e` reproduces stale homedir() output after one `process.env = {...ORIGINAL}`.
//
// Fix round 2 (Codex review 1001-verify-r2), CI part B: `HOME` alone has no effect on
// `os.homedir()` on windows-latest (it reads `USERPROFILE` there — see tmp.ts's `stubHomedir`
// header) — restored via that helper's own returned closure. `APPDATA` is stubbed the same way, for
// the same reason `registryCandidates`' own win32 branch needs it (below).
const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_APPDATA = process.env.APPDATA;
let restoreHome: (() => void) | undefined;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stdout: string[];

beforeEach(() => {
  stdout = [];
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  // Never make a real network call in a test — Ollama is assumed absent regardless of what
  // happens to be running on the host box.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("ECONNREFUSED (stubbed — no Ollama in tests)"))),
  );
});

afterEach(() => {
  stdoutSpy.mockRestore();
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

/** Point a whole fake environment (home + a registered vault) at temp dirs, so
 *  `resolveCapabilityProfile`'s real locateRegistry()/discoverPlugins() find exactly this, never
 *  anything on the real host running these tests.
 *
 *  Fix round 2, CI part B (macOS + Windows): the registry file must land wherever THIS process's
 *  OWN `locateRegistry()` will actually look on THIS platform — capability/locate.ts's own
 *  `registryCandidates` is PLATFORM-SPECIFIC (macOS: `~/Library/Application Support/obsidian`;
 *  Windows: `%APPDATA%\Obsidian`; Linux: `$XDG_CONFIG_HOME/obsidian`), so a Linux-only
 *  `XDG_CONFIG_HOME`-based path here (the pre-fix shape) left EVERY registry-dependent test in this
 *  file finding no vault at all on macOS/Windows CI runners — `locateRegistry` ignores
 *  `XDG_CONFIG_HOME` on those platforms entirely. Reused (not re-derived) from that module so this
 *  test can never drift from what the real locator does. */
function fakeObsidianEnv(): { home: string; vaultPath: string; registryPath: string } {
  const home = tmpDir("otc-setup-e2e-home-");
  const xdgConfig = tmpDir("otc-setup-e2e-xdg-");
  const vaultPath = tmpDir("otc-setup-e2e-vault-");
  restoreHome = stubHomedir(home);
  process.env.XDG_CONFIG_HOME = xdgConfig;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  const registryPath = registryCandidates(process.platform, process.env, home)[0];
  if (registryPath === undefined) {
    throw new Error(`no obsidian.json registry candidate for platform ${process.platform}`);
  }
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(
    registryPath,
    JSON.stringify({ vaults: { main: { path: vaultPath, open: true } } }),
  );
  return { home, vaultPath, registryPath };
}

describe("obsidian-tc setup — end to end", () => {
  it("writes a config (via --yes) that loads through the real loader with source 'configured'", async () => {
    const { home } = fakeObsidianEnv();
    const configPath = join(home, ".obsidian-tc", "config.json");

    await run_setup({ kind: "setup", yes: true, dryRun: false, force: false });

    expect(existsSync(configPath)).toBe(true);
    // Loads without throwing through the REAL config/load.ts.
    const loaded = loadConfig(configPath);
    expect(loaded.vaults).toHaveLength(1);
    expect(loaded.vaults[0]?.id).toBe("main");

    // `config show` — the SAME resolver GH #995 fixed boot with — must report this as something
    // the user configured, never "default" or a kept/ambiguous value: setup wrote it down.
    const shown = await runConfigShow(configPath);
    const effective = shown.embeddingsEffective as Record<string, unknown>;
    expect(effective.source).toBe("configured");
    expect(effective.provider).toBe((shown.embeddings as Record<string, unknown>).provider);
  });

  it("--dry-run writes nothing", async () => {
    const { home } = fakeObsidianEnv();
    const configPath = join(home, ".obsidian-tc", "config.json");

    await run_setup({ kind: "setup", yes: false, dryRun: true, force: false });

    expect(existsSync(configPath)).toBe(false);
    expect(stdout.join("")).toMatch(/dry-run/);
  });

  it("no TTY and no --yes writes nothing", async () => {
    const { home } = fakeObsidianEnv();
    const configPath = join(home, ".obsidian-tc", "config.json");
    // vitest's stdin is not a TTY by construction; asserted explicitly so this test fails loudly
    // if that ever stops being true rather than silently passing for the wrong reason.
    expect(process.stdin.isTTY).toBeFalsy();

    await run_setup({ kind: "setup", yes: false, dryRun: false, force: false });

    expect(existsSync(configPath)).toBe(false);
  });

  it("refuses to overwrite an existing config without --force, and does not touch it", async () => {
    const { home } = fakeObsidianEnv();
    const configDir = join(home, ".obsidian-tc");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ existing: true }));

    await run_setup({ kind: "setup", yes: true, dryRun: false, force: false });

    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ existing: true });
  });

  it("--force backs up the existing config and writes the new one", async () => {
    const { home, vaultPath } = fakeObsidianEnv();
    const configDir = join(home, ".obsidian-tc");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir, { recursive: true });
    const original = JSON.stringify({ vaults: [{ id: "work", path: vaultPath }] });
    writeFileSync(configPath, original);

    await run_setup({ kind: "setup", yes: true, dryRun: false, force: true });

    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.embeddings).toBeDefined(); // setup wrote its decision
    const backups = readdirSync(configDir).filter((f) => f.startsWith("config.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(configDir, backups[0] ?? ""), "utf8")).toBe(original);
  });

  // Finding 1 (fix round, cross-vendor review): the review's own scenario — first-run's fallback
  // auto-wrote this config (setupOrigin: "first-run-fallback"); an operator follows doctor's own
  // hint and runs `setup --force` to review it. That is a real, operator-reviewed write, and must
  // drop the marker — `doctor` must stop calling it unreviewed the moment this run completes.
  it("--force re-run over a first-run-fallback config drops setupOrigin (an operator-reviewed write)", async () => {
    const { home, vaultPath } = fakeObsidianEnv();
    const configDir = join(home, ".obsidian-tc");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        vaults: [{ id: "main", path: vaultPath }],
        setupOrigin: "first-run-fallback",
      }),
    );

    await run_setup({ kind: "setup", yes: true, dryRun: false, force: true });

    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.setupOrigin).toBeUndefined();
  });

  // Fix round (Codex review 1001-verify), finding 2 (HIGH): an existing config's OWN cacheDir and
  // keys setup does not own must survive a re-run, and detection must probe against ITS cacheDir.
  it("--force re-run against an existing config preserves its cacheDir and keys setup does not own", async () => {
    const { home, vaultPath } = fakeObsidianEnv();
    const configDir = join(home, ".obsidian-tc");
    const configPath = join(configDir, "config.json");
    const customCacheDir = join(home, "custom-cache");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        vaults: [{ id: "main", path: vaultPath }],
        cacheDir: customCacheDir,
        auth: { jwtSecret: "keep-me-unless-you-are-a-generic-key" },
      }),
    );

    await run_setup({ kind: "setup", yes: true, dryRun: false, force: true });

    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.cacheDir).toBe(customCacheDir);
    expect(onDisk.auth).toEqual({ jwtSecret: "keep-me-unless-you-are-a-generic-key" });
  });

  // Fix round 2 (Codex review 1001-verify-r2), finding 2 (HIGH): the exact pre-1.31.4 / GH #995
  // victim shape — vaults, no embeddings, no cacheDir — must not have `finalizeConfig` throwing
  // during DETECTION lose the raw file's OWN keys (auth, acl) on a --force re-run. Before the fix,
  // `loadExistingConfig` returned `undefined` on ANY throw (readConfigFile OR finalizeConfig), so
  // `existingRaw` was never set and the merge started from an empty object, discarding auth/acl.
  it("--force re-run against a pre-1.31.4 config (no cacheDir, no embeddings) preserves auth/acl instead of discarding them", async () => {
    const { home, vaultPath } = fakeObsidianEnv();
    const configDir = join(home, ".obsidian-tc");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        vaults: [{ id: "work", path: vaultPath }],
        auth: { jwtSecret: "keep-me-unless-you-are-a-generic-key" },
        acl: { readOnly: true },
      }),
    );

    await run_setup({ kind: "setup", yes: true, dryRun: false, force: true });

    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.auth).toEqual({ jwtSecret: "keep-me-unless-you-are-a-generic-key" });
    expect(onDisk.acl).toEqual({ readOnly: true });
    expect(onDisk.vaults).toEqual(expect.arrayContaining([{ id: "work", path: vaultPath }]));
  });

  // Round 2 (Codex spot-check on the ACL-glob refusal): a config that FAILS schema validation used to
  // have its parsed raw object dropped by `loadExistingConfig`, so `setup --force` rebuilt from `{}`
  // and replaced every `acl`/`auth`/`egress` block with permissive defaults: a fail-open reached by
  // following the startup hint. Setup now REFUSES to touch a config that does not validate.
  describe("setup never replaces a config that fails validation (it refuses, nothing is written)", () => {
    const exitCodeBefore = process.exitCode;
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let stderr: string[];
    beforeEach(() => {
      stderr = [];
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        stderr.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    });
    afterEach(() => {
      stderrSpy.mockRestore();
      process.exitCode = exitCodeBefore;
    });

    const restrictive = (vaultPath: string, glob: string) => ({
      vaults: [{ id: "work", path: vaultPath }],
      auth: { jwtSecret: "keep-me-unless-you-are-a-generic-key" },
      acl: { readOnly: true, rules: [{ glob, scopes: ["admin:private"] }] },
      egress: { excludePaths: ["Private/**"] },
    });

    it.each([
      ["--force", { yes: true, dryRun: false, force: true }],
      ["--yes", { yes: true, dryRun: false, force: false }],
      ["--dry-run", { yes: false, dryRun: true, force: false }],
    ])(
      'acl.rules[0].glob "/Private/**" with %s: file untouched, error names the field',
      async (_n, flags) => {
        const { home, vaultPath } = fakeObsidianEnv();
        const configDir = join(home, ".obsidian-tc");
        const configPath = join(configDir, "config.json");
        mkdirSync(configDir, { recursive: true });
        const before = JSON.stringify(restrictive(vaultPath, "/Private/**"));
        writeFileSync(configPath, before);

        await run_setup({ kind: "setup", ...flags });

        expect(readFileSync(configPath, "utf8")).toBe(before);
        expect(readdirSync(configDir)).toEqual(["config.json"]); // no backup, no temp file
        expect(process.exitCode).toBe(1);
        const err = stderr.join("");
        expect(err).toMatch(/acl\.rules\.0\.glob/);
        expect(err).toMatch(/fix/i);
        expect(stdout.join("")).not.toContain('"readOnly"'); // no merged-config preview either
      },
    );

    it("any other validation failure is refused too (an invalid auth block is not replaced)", async () => {
      const { home, vaultPath } = fakeObsidianEnv();
      const configDir = join(home, ".obsidian-tc");
      const configPath = join(configDir, "config.json");
      mkdirSync(configDir, { recursive: true });
      const before = JSON.stringify({
        ...restrictive(vaultPath, "Private/**"),
        acl: { readOnly: "yes please" },
      });
      writeFileSync(configPath, before);

      await run_setup({ kind: "setup", yes: true, dryRun: false, force: true });

      expect(readFileSync(configPath, "utf8")).toBe(before);
      expect(process.exitCode).toBe(1);
      expect(stderr.join("")).toMatch(/acl\.readOnly/);
    });
  });

  // Round 3 (Codex spot-check): the round-2 refusal covered only a config that PARSES into an object.
  // Malformed JSON was read as "no existing config", and a valid JSON root that is not an object
  // (`null`, `123`, `"x"`, `false`) crashed the loader with a TypeError that the same catch-all
  // swallowed, so `--yes --force` rebuilt from defaults over a file that may have carried a
  // restrictive acl/auth/egress. Every unreadable-as-an-object config is now refused the same way;
  // only the explicit `--replace-invalid-config` flag (never implied by `--force`) may replace one.
  describe("setup never replaces a config it cannot read as an object (malformed JSON, non-object root)", () => {
    const exitCodeBefore = process.exitCode;
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let stderr: string[];
    beforeEach(() => {
      stderr = [];
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        stderr.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    });
    afterEach(() => {
      stderrSpy.mockRestore();
      process.exitCode = exitCodeBefore;
    });

    const unreadable: Array<[string, string, RegExp]> = [
      ["malformed JSON", '{"vaults": [', /not valid JSON/i],
      ["a truncated acl block", '{"acl": {"readOnly": tru', /not valid JSON/i],
      ["null", "null", /root is null/i],
      ["123", "123", /root is a number/i],
      ['"x"', '"x"', /root is a string/i],
      ["false", "false", /root is a boolean/i],
      ["an array", "[]", /root is an array/i],
    ];
    const modes: Array<[string, { yes: boolean; dryRun: boolean; force: boolean }]> = [
      ["--force", { yes: false, dryRun: false, force: true }],
      ["--yes --force", { yes: true, dryRun: false, force: true }],
      ["--dry-run", { yes: false, dryRun: true, force: false }],
    ];

    for (const [label, content, message] of unreadable) {
      it.each(modes)(
        `${label} with %s: file byte-identical, exit 1, nothing else written`,
        async (_m, flags) => {
          const { home } = fakeObsidianEnv();
          const configDir = join(home, ".obsidian-tc");
          const configPath = join(configDir, "config.json");
          mkdirSync(configDir, { recursive: true });
          writeFileSync(configPath, content);

          await run_setup({ kind: "setup", ...flags });

          expect(readFileSync(configPath, "utf8")).toBe(content);
          expect(readdirSync(configDir)).toEqual(["config.json"]); // no backup, no temp file
          expect(process.exitCode).toBe(1);
          const err = stderr.join("");
          expect(err).toMatch(message);
          expect(err).toMatch(/--replace-invalid-config/);
          expect(stdout.join("")).not.toContain("(--dry-run: nothing written)");
        },
      );
    }

    it("a SyntaxError names the line and column where the engine reports a position", async () => {
      const { home } = fakeObsidianEnv();
      const configDir = join(home, ".obsidian-tc");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config.json"), '{\n  "vaults": [],\n  oops\n}');

      await run_setup({ kind: "setup", yes: true, dryRun: false, force: true });

      expect(process.exitCode).toBe(1);
      // V8 prints its own `(line L column C)` or a `position N` (converted to line/column here); an
      // engine that reports neither (Bun) leaves only its own message, which is still printed.
      const err = stderr.join("");
      expect(err).toMatch(/not valid JSON/i);
      if (/position \d+|line \d+/.test(err)) expect(err).toMatch(/line 3,? column \d+/);
    });

    it.each([
      ["malformed JSON", '{"acl": {"readOnly": true,', "malformed"],
      ["a null root", "null", "null"],
    ])(
      "--replace-invalid-config replaces %s, keeps a backup and says what is discarded",
      async (_n, content) => {
        const { home } = fakeObsidianEnv();
        const configDir = join(home, ".obsidian-tc");
        const configPath = join(configDir, "config.json");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(configPath, content);

        await run_setup({
          kind: "setup",
          yes: true,
          dryRun: false,
          force: false,
          replaceInvalidConfig: true,
        });

        expect(process.exitCode).toBe(exitCodeBefore);
        expect(loadConfig(configPath).vaults).toHaveLength(1); // a real, loadable replacement
        const backups = readdirSync(configDir).filter((f) => f.startsWith("config.json.bak-"));
        expect(backups).toHaveLength(1);
        expect(readFileSync(join(configDir, backups[0] ?? ""), "utf8")).toBe(content);
        expect(stderr.join("")).toMatch(/discard/i);
        expect(stderr.join("")).toMatch(/acl, auth and egress/i);
      },
    );

    it("--replace-invalid-config over a schema-invalid config discards its blocks (nothing is merged back)", async () => {
      const { home, vaultPath } = fakeObsidianEnv();
      const configDir = join(home, ".obsidian-tc");
      const configPath = join(configDir, "config.json");
      mkdirSync(configDir, { recursive: true });
      const before = JSON.stringify({
        vaults: [{ id: "work", path: vaultPath }],
        auth: { jwtSecret: "old-secret-that-must-not-survive-a-replace" },
        acl: { rules: [{ glob: "/Private/**", scopes: ["admin:private"] }] },
      });
      writeFileSync(configPath, before);

      await run_setup({
        kind: "setup",
        yes: true,
        dryRun: false,
        force: false,
        replaceInvalidConfig: true,
      });

      const written = readFileSync(configPath, "utf8");
      expect(written).not.toContain("old-secret-that-must-not-survive-a-replace");
      expect(written).not.toContain("/Private/**");
      expect(loadConfig(configPath).vaults.length).toBeGreaterThan(0);
      const backups = readdirSync(configDir).filter((f) => f.startsWith("config.json.bak-"));
      expect(readFileSync(join(configDir, backups[0] ?? ""), "utf8")).toBe(before);
    });

    it("--replace-invalid-config with --dry-run warns, previews and writes nothing", async () => {
      const { home } = fakeObsidianEnv();
      const configDir = join(home, ".obsidian-tc");
      const configPath = join(configDir, "config.json");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, "123");

      await run_setup({
        kind: "setup",
        yes: false,
        dryRun: true,
        force: false,
        replaceInvalidConfig: true,
      });

      expect(readFileSync(configPath, "utf8")).toBe("123");
      expect(readdirSync(configDir)).toEqual(["config.json"]);
      expect(stderr.join("")).toMatch(/discard/i);
      expect(stdout.join("")).toContain("(--dry-run: nothing written)");
    });

    it("an ABSENT config is still created on first run (no flag needed)", async () => {
      const { home } = fakeObsidianEnv();
      const configPath = join(home, ".obsidian-tc", "config.json");

      await run_setup({ kind: "setup", yes: true, dryRun: false, force: false });

      expect(existsSync(configPath)).toBe(true);
      expect(process.exitCode).toBe(exitCodeBefore);
    });
  });

  // Fix round 2, finding C (orchestrator): `setup` printed the merged config to stdout via a bare
  // JSON.stringify on EVERY run (including --dry-run) — an existing config's inline apiKey/secret
  // reached stdout unredacted, unlike `config show` (which runs the same raw object through
  // redactConfig). Prove an inline secret already on disk never reaches stdout.
  it("never prints an existing config's inline secret to stdout, dry-run or not", async () => {
    const { home, vaultPath } = fakeObsidianEnv();
    const configDir = join(home, ".obsidian-tc");
    const configPath = join(configDir, "config.json");
    const cacheDir = join(home, "cache");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        vaults: [{ id: "work", path: vaultPath }],
        cacheDir,
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 1536,
          apiKey: "sk-live-SUPER-SECRET",
        },
      }),
    );

    await run_setup({ kind: "setup", yes: false, dryRun: true, force: false });

    expect(stdout.join("")).not.toContain("sk-live-SUPER-SECRET");
  });

  // Finding 7 (MEDIUM): --vault validation.
  it("--vault pointing at a nonexistent path is refused before any other I/O", async () => {
    const { home } = fakeObsidianEnv();
    const configPath = join(home, ".obsidian-tc", "config.json");
    const missing = join(home, "does-not-exist");

    await run_setup({
      kind: "setup",
      yes: true,
      dryRun: false,
      force: false,
      vaultPath: missing,
    });

    expect(existsSync(configPath)).toBe(false);
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it("a registry vault whose path no longer exists is skipped with a warning, not written", async () => {
    const { home, registryPath } = fakeObsidianEnv();
    const configPath = join(home, ".obsidian-tc", "config.json");
    // Corrupt the registry entry to point at a path that was never created.
    writeFileSync(
      registryPath,
      JSON.stringify({ vaults: { main: { path: join(home, "ghost-vault"), open: true } } }),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await run_setup({ kind: "setup", yes: true, dryRun: false, force: false });

    expect(existsSync(configPath)).toBe(false); // no vault detected -> "no vault found" exit
    const warned = stderrSpy.mock.calls.some((c) => String(c[0]).includes("no longer exists"));
    expect(warned).toBe(true);
    stderrSpy.mockRestore();
  });

  // Setup hardening item 1: an EXISTING config's own vault paths were never existence-checked —
  // only fresh registry vaults were. A moved/deleted path must be WARNED about, never silently
  // dropped from the config (an operator's own prior entry is not setup's to delete).
  it("an existing config's own vault whose path no longer exists is kept, not silently deleted, and warned about", async () => {
    const { home, vaultPath } = fakeObsidianEnv();
    const configDir = join(home, ".obsidian-tc");
    const configPath = join(configDir, "config.json");
    const ghostPath = join(home, "ghost-existing-vault");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        vaults: [
          { id: "ghost", path: ghostPath },
          { id: "main", path: vaultPath },
        ],
      }),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await run_setup({ kind: "setup", yes: true, dryRun: false, force: true });

    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.vaults).toEqual(expect.arrayContaining([{ id: "ghost", path: ghostPath }]));
    const warned = stderrSpy.mock.calls.some(
      (c) => String(c[0]).includes(ghostPath) && String(c[0]).includes("no longer exists"),
    );
    expect(warned).toBe(true);
    stderrSpy.mockRestore();
  });

  // Setup hardening item 1: on an id collision, the existing config's path previously won
  // SILENTLY over a live Obsidian-registry entry at a different path for the same id. That must be
  // surfaced instead, and --force/--yes together must NOT auto-resolve it — the operator resolves
  // by hand.
  it("surfaces a vault id collision between the existing config and a live registry entry, and refuses to write even with --yes --force", async () => {
    const { home, vaultPath } = fakeObsidianEnv(); // registers "main" -> vaultPath live
    const configDir = join(home, ".obsidian-tc");
    const configPath = join(configDir, "config.json");
    const staleVaultPath = tmpDir("otc-setup-e2e-stale-vault-"); // exists, but a DIFFERENT path
    mkdirSync(configDir, { recursive: true });
    const before = JSON.stringify({ vaults: [{ id: "main", path: staleVaultPath }] });
    writeFileSync(configPath, before);

    await run_setup({ kind: "setup", yes: true, dryRun: false, force: true });

    // Refused before any write — the file on disk is byte-for-byte untouched.
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    const printed = stdout.join("");
    expect(printed).toContain(staleVaultPath);
    expect(printed).toContain(vaultPath);
  });

  // Low: dry-run / no-TTY leave ZERO filesystem side effects — not just "the target is absent".
  it("--dry-run creates no backup, no temp file, and no directory", async () => {
    const { home } = fakeObsidianEnv();
    const configDir = join(home, ".obsidian-tc");

    await run_setup({ kind: "setup", yes: false, dryRun: true, force: false });

    expect(existsSync(configDir)).toBe(false);
  });

  it("no TTY and no --yes creates no backup, no temp file, and no directory", async () => {
    const { home } = fakeObsidianEnv();
    const configDir = join(home, ".obsidian-tc");

    await run_setup({ kind: "setup", yes: false, dryRun: false, force: false });

    expect(existsSync(configDir)).toBe(false);
  });

  // Finding 1 (HIGH), e2e: an unmappable stored provider id must never reach disk as a guess.
  it("refuses to write when the existing index's stored provider is unmappable", async () => {
    const { home } = fakeObsidianEnv();
    const configPath = join(home, ".obsidian-tc", "config.json");
    const cacheDir = join(home, ".obsidian-tc");
    mkdirSync(cacheDir, { recursive: true });
    await seedUnmappableIndex(cacheDir);

    await run_setup({ kind: "setup", yes: true, dryRun: false, force: false });

    expect(existsSync(configPath)).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  // DEFAULT PATH: setup's own output must be what a bare `obsidian-tc` (no flags) picks up.
  it("serve's resolveServeConfigWithProvenance picks up setup's default-path output with no flags", async () => {
    const { home } = fakeObsidianEnv();
    const configPath = join(home, ".obsidian-tc", "config.json");

    await run_setup({ kind: "setup", yes: true, dryRun: false, force: false });
    expect(existsSync(configPath)).toBe(true);

    const resolved = resolveServeConfigWithProvenance(undefined);
    expect(resolved.config.vaults[0]?.id).toBe("main");
  });
});

/** Fix-round finding 1 e2e helper: writes a real cache.db with an active embedding row whose
 *  model id has an UNMAPPABLE provider prefix (not in sticky-provider.ts's
 *  RECONSTRUCTABLE_PROVIDERS) — the exact shape `probeEmbeddingsProviderSource` must refuse to
 *  guess past. Same fixture shape as test/cli-index-embeddings-sticky.test.ts's own seed. */
async function seedUnmappableIndex(cacheDir: string): Promise<void> {
  const { openDatabase } = await import("../src/db/open");
  const { provisionCacheDb } = await import("../src/db/provision");
  const db = await openDatabase(join(cacheDir, "cache.db"));
  provisionCacheDb(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
     VALUES ('c1', 'main', 'a.md', '0', '[]', 'x', 'hash', 1, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES ('c1', 'module:corp-embed', 1536, ?, 1, ?)`,
  ).run(Buffer.alloc(1536 * 4), now);
  db.close?.();
}

async function runConfigShow(configPath: string): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  try {
    await run_config_show({ kind: "config-show", configPath });
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(chunks.join("")) as Record<string, unknown>;
}
