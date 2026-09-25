// THE-1124 — `obsidian-tc memory import` as an actual CLI subprocess. `run_memory_import` calls
// `process.exit`, so — same rationale as compact-cli.test.ts's own header, which this file
// mirrors — importing it directly risks corrupting this test run's own exit code; spawn the real
// CLI instead.
//
// Review findings covered here (the ones that are properties of the COMMAND — building the
// caller's ACL from config, the pre-flight banner, and the cacheDir dry-run behavior — as opposed
// to properties of the pure `applyImport`/`buildParsedSource` functions, which have their own
// dedicated unit tests): the CLI's ctx.acl must actually come from the resolved config (a readOnly
// root, or a `writePaths` allowlist, must be enforced exactly like an MCP client would see), and a
// dry run must print where its vault/cache/mode landed and never create a cache directory that did
// not already exist.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SPAWN_TIMEOUT_MS = 20_000;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Run {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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

function writeConfig(configPath: string, vaultPath: string, cacheDir: string, acl?: unknown): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      vaults: [{ id: "main", path: vaultPath }],
      cacheDir,
      ...(acl !== undefined ? { acl } : {}),
    }),
  );
}

describe("obsidian-tc memory import — CLI", () => {
  it("exits 2 when --from/--dir/--vault are missing", () => {
    const vaultDir = scratch("obtc-mi-cli-vault-");
    const cacheDir = scratch("obtc-mi-cli-cache-");
    const configPath = join(scratch("obtc-mi-cli-cfg-"), "config.json");
    writeConfig(configPath, vaultDir, cacheDir);
    const srcDir = scratch("obtc-mi-cli-src-");
    writeOneNote(srcDir);

    const noFrom = runCli(["memory", "import", srcDir, "--config", configPath, "--vault", "main"]);
    expect(noFrom.code).toBe(2);
    expect(noFrom.stderr).toContain("--from");

    const noVault = runCli([
      "memory",
      "import",
      "--from",
      "basic-memory",
      srcDir,
      "--config",
      configPath,
    ]);
    expect(noVault.code).toBe(2);
    expect(noVault.stderr).toContain("--vault");
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
});
