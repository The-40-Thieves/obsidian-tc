// THE-1124 — `obsidian-tc memory import` as an actual CLI subprocess. `run_memory_import` calls
// `process.exit`, so — same rationale as compact-cli.test.ts's own header, which this file
// mirrors — importing it directly risks corrupting this test run's own exit code; spawn the real
// CLI instead. The one exception is argument validation: those exit-2 cases drive the parser and
// `run_memory_import` in-process with `process.exit` replaced by a throw (nothing is written, and
// the real process keeps its exit code), and ONE real spawn pins that the exit status survives the
// process boundary. A spawn per usage case is what a stalled windows-latest runner killed.
//
// Review findings covered here (the ones that are properties of the COMMAND — building the
// caller's ACL from config, the pre-flight banner, and the cacheDir dry-run behavior — as opposed
// to properties of the pure `applyImport`/`buildParsedSource` functions, which have their own
// dedicated unit tests): the CLI's ctx.acl must actually come from the resolved config (a readOnly
// root, or a `writePaths` allowlist, must be enforced exactly like an MCP client would see), and a
// dry run must print where its vault/cache/mode landed and never create a cache directory that did
// not already exist.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../src/cli/args";
import { run_memory_import } from "../src/cli/commands/memory-import";
import { type CliRun, runBunSync } from "./spawn-cli";
import { stallTimeout } from "./stall-timeouts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
// Each real spawn is one cold `bun` boot; vitest's own default (5s) is what applied before.
const SPAWN_TEST_TIMEOUT_MS = stallTimeout(5_000);

function runCli(args: string[]): CliRun {
  return runBunSync([CLI, ...args]);
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/** Parse + run `memory import` in this process. `process.exit` throws instead of exiting, so the
 *  exit code `run_memory_import` chose is observed without ending the test run. */
async function runInProcess(args: string[]): Promise<{ code: number; stderr: string }> {
  const cmd = parseCliArgs(["memory", "import", ...args]);
  if (cmd.kind !== "memory-import") throw new Error(`parsed as ${cmd.kind}`);
  let stderr = "";
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  const err = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
    stderr += String(c);
    return true;
  });
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await run_memory_import(cmd);
    return { code: 0, stderr };
  } catch (e) {
    if (e instanceof ExitSignal) return { code: e.code, stderr };
    throw e;
  } finally {
    exit.mockRestore();
    err.mockRestore();
    out.mockRestore();
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** One basic-memory note with an observation — enough to exercise a real create_entity write. */
function writeOneNote(srcDir: string): void {
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "note.md"),
    "---\ntitle: CLI Test Note\ntype: note\n---\n## Observations\n- [fact] hello\n",
  );
}

function writeConfig(
  configPath: string,
  vaultPath: string,
  cacheDir: string,
  acl?: unknown,
  memoryDefense?: unknown,
): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      vaults: [{ id: "main", path: vaultPath, ...(memoryDefense ? { memoryDefense } : {}) }],
      cacheDir,
      ...(acl !== undefined ? { acl } : {}),
    }),
  );
}

// A fake OpenAI-shaped key, assembled at runtime — same no-literal-secret convention as
// memory-defense.test.ts.
function fakeOpenAiKey(): string {
  return ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
}

function writeOneNoteWithSecret(srcDir: string, secret: string): void {
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "note.md"),
    `---\ntitle: CLI Test Note\ntype: note\n---\n## Observations\n- [fact] ${secret}\n`,
  );
}

describe("obsidian-tc memory import — usage errors exit 2 (in-process)", () => {
  function fixture(): { srcDir: string; configPath: string } {
    const vaultDir = scratch("obtc-mi-cli-vault-");
    const cacheDir = scratch("obtc-mi-cli-cache-");
    const configPath = join(scratch("obtc-mi-cli-cfg-"), "config.json");
    writeConfig(configPath, vaultDir, cacheDir);
    const srcDir = scratch("obtc-mi-cli-src-");
    writeOneNote(srcDir);
    return { srcDir, configPath };
  }

  it("--from missing", async () => {
    const { srcDir, configPath } = fixture();
    const r = await runInProcess([srcDir, "--config", configPath, "--vault", "main"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--from");
  });

  it("--vault missing", async () => {
    const { srcDir, configPath } = fixture();
    const r = await runInProcess(["--from", "basic-memory", srcDir, "--config", configPath]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--vault");
  });

  it("source directory missing", async () => {
    const { configPath } = fixture();
    const r = await runInProcess([
      "--from",
      "basic-memory",
      "--config",
      configPath,
      "--vault",
      "main",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("source directory");
  });

  it("--vault names a vault the config does not have", async () => {
    const { srcDir, configPath } = fixture();
    const r = await runInProcess([
      "--from",
      "basic-memory",
      srcDir,
      "--config",
      configPath,
      "--vault",
      "nope",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown vault nope");
  });
});

describe("obsidian-tc memory import — CLI", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("smoke: the real process exits 2 (not 0, not killed) when --from is missing", () => {
    const vaultDir = scratch("obtc-mi-cli-vault-");
    const cacheDir = scratch("obtc-mi-cli-cache-");
    const configPath = join(scratch("obtc-mi-cli-cfg-"), "config.json");
    writeConfig(configPath, vaultDir, cacheDir);
    const srcDir = scratch("obtc-mi-cli-src-");
    writeOneNote(srcDir);

    const r = runCli(["memory", "import", srcDir, "--config", configPath, "--vault", "main"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--from");
  });

  it("prints a vault/cache/mode banner before doing anything, and dry-run does not create a missing cacheDir", () => {
    const vaultDir = scratch("obtc-mi-cli-vault-");
    const cacheDir = join(scratch("obtc-mi-cli-cache-parent-"), "cache-does-not-exist-yet");
    const configPath = join(scratch("obtc-mi-cli-cfg-"), "config.json");
    writeConfig(configPath, vaultDir, cacheDir);
    const srcDir = scratch("obtc-mi-cli-src-");
    writeOneNote(srcDir);

    const r = runCli([
      "memory",
      "import",
      "--from",
      "basic-memory",
      srcDir,
      "--config",
      configPath,
      "--vault",
      "main",
    ]);
    expect(r.stdout).toContain(`vault: ${vaultDir}`);
    expect(r.stdout).toContain(`cache: ${cacheDir}`);
    expect(r.stdout).toContain("mode: dry-run");
    expect(r.stdout.toLowerCase()).toContain("no cache yet");
    expect(existsSync(cacheDir)).toBe(false);
    expect(r.code).toBe(0);
  });

  it("a readOnly root ACL refuses every write and is reported as an error (exit non-zero)", () => {
    const vaultDir = scratch("obtc-mi-cli-vault-");
    const cacheDir = scratch("obtc-mi-cli-cache-");
    const configPath = join(scratch("obtc-mi-cli-cfg-"), "config.json");
    writeConfig(configPath, vaultDir, cacheDir, { readOnly: true, defaultScopes: [], rules: [] });
    const srcDir = scratch("obtc-mi-cli-src-");
    writeOneNote(srcDir);

    const r = runCli([
      "memory",
      "import",
      "--from",
      "basic-memory",
      srcDir,
      "--config",
      configPath,
      "--vault",
      "main",
      "--apply",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("error");
    expect(existsSync(join(vaultDir, "memory"))).toBe(false);
  });

  it("writePaths restricting to memory/** allows the write", () => {
    const vaultDir = scratch("obtc-mi-cli-vault-");
    const cacheDir = scratch("obtc-mi-cli-cache-");
    const configPath = join(scratch("obtc-mi-cli-cfg-"), "config.json");
    writeConfig(configPath, vaultDir, cacheDir, {
      readOnly: false,
      defaultScopes: [],
      rules: [],
      writePaths: ["memory/**"],
    });
    const srcDir = scratch("obtc-mi-cli-src-");
    writeOneNote(srcDir);

    const r = runCli([
      "memory",
      "import",
      "--from",
      "basic-memory",
      srcDir,
      "--config",
      configPath,
      "--vault",
      "main",
      "--apply",
    ]);
    expect(r.code).toBe(0);
    expect(existsSync(join(vaultDir, "memory", "note", "CLI Test Note.md"))).toBe(true);
  });

  it("writePaths restricting to an UNRELATED folder refuses the write (exit non-zero)", () => {
    const vaultDir = scratch("obtc-mi-cli-vault-");
    const cacheDir = scratch("obtc-mi-cli-cache-");
    const configPath = join(scratch("obtc-mi-cli-cfg-"), "config.json");
    writeConfig(configPath, vaultDir, cacheDir, {
      readOnly: false,
      defaultScopes: [],
      rules: [],
      writePaths: ["elsewhere/**"],
    });
    const srcDir = scratch("obtc-mi-cli-src-");
    writeOneNote(srcDir);

    const r = runCli([
      "memory",
      "import",
      "--from",
      "basic-memory",
      srcDir,
      "--config",
      configPath,
      "--vault",
      "main",
      "--apply",
    ]);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(vaultDir, "memory"))).toBe(false);
  });

  // GH #994 follow-up: `registerM5Tools` here used to be wired with NO memoryDefense accessor at
  // all, so create_entity's own scan defaulted to "off" for every vault regardless of the vault's
  // configured policy — a batch import through the "sanctioned" create_entity/add_observation
  // dispatch path (this file's own header) that silently bypassed memoryDefense anyway.
  it("memoryDefense block on the target vault refuses a secret-shaped observation (exit non-zero)", () => {
    const vaultDir = scratch("obtc-mi-cli-vault-");
    const cacheDir = scratch("obtc-mi-cli-cache-");
    const configPath = join(scratch("obtc-mi-cli-cfg-"), "config.json");
    writeConfig(configPath, vaultDir, cacheDir, undefined, { mode: "block", pii: false });
    const srcDir = scratch("obtc-mi-cli-src-");
    const secret = fakeOpenAiKey();
    writeOneNoteWithSecret(srcDir, secret);

    const r = runCli([
      "memory",
      "import",
      "--from",
      "basic-memory",
      srcDir,
      "--config",
      configPath,
      "--vault",
      "main",
      "--apply",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain(secret);
    expect(r.stderr).not.toContain(secret);
  });

  it("memoryDefense off (default) still imports a secret-shaped observation verbatim — unchanged baseline", () => {
    const vaultDir = scratch("obtc-mi-cli-vault-");
    const cacheDir = scratch("obtc-mi-cli-cache-");
    const configPath = join(scratch("obtc-mi-cli-cfg-"), "config.json");
    writeConfig(configPath, vaultDir, cacheDir);
    const srcDir = scratch("obtc-mi-cli-src-");
    const secret = fakeOpenAiKey();
    writeOneNoteWithSecret(srcDir, secret);

    const r = runCli([
      "memory",
      "import",
      "--from",
      "basic-memory",
      srcDir,
      "--config",
      configPath,
      "--vault",
      "main",
      "--apply",
    ]);
    expect(r.code).toBe(0);
  });
});
