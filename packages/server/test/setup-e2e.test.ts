// `obsidian-tc setup` end to end (PR A of GH #995's two-part follow-up): runs the REAL run_setup
// path against a temp HOME/XDG_CONFIG_HOME with a fake obsidian.json registry, and asserts the
// written config loads through the REAL loader (config/load.ts's loadConfig) and that `config show`
// reports the effective embeddings source as "configured" — the exact GH #995 property this command
// exists to establish: a decision `setup` writes down must never look like something boot merely
// defaulted to or kept.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registryCandidates } from "../src/capability/locate";
import { run_config_show } from "../src/cli/commands/config-show";
import { run_setup } from "../src/cli/commands/setup";
import { resolveServeConfigWithProvenance } from "../src/cli/resolve-config";
import { loadConfig } from "../src/config/load";
import { rmTemp, stubHomedir } from "./tmp";

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
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
    const { home } = fakeObsidianEnv();
    const configDir = join(home, ".obsidian-tc");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ existing: true }));

    await run_setup({ kind: "setup", yes: true, dryRun: false, force: true });

    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.existing).toBeUndefined();
    expect(onDisk.vaults).toBeDefined();
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
