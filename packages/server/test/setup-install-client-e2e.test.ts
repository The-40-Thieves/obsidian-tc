// PR B of GH #995's two-part follow-up: end-to-end tests for `obsidian-tc setup --install-client`
// — the real filesystem writer (cli/commands/setup-install-client.ts's `runInstallClient`), with
// platform/env/home injected (never the real host's) and `runCli` stubbed (never actually
// shells out to a `claude` binary in CI). See test/setup-client-install.test.ts for the pure
// path/merge logic these call into.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInstallClient } from "../src/cli/commands/setup-install-client";
import { rmTemp } from "./tmp";

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

let stdout: string[];
let stderr: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function captureOutput(): void {
  stdout = [];
  stderr = [];
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
}

afterEach(() => {
  stdoutSpy?.mockRestore();
  stderrSpy?.mockRestore();
  process.exitCode = undefined;
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* best-effort */
    }
  }
});

describe("runInstallClient — claude-code", () => {
  it("prints and runs the documented `claude mcp add` command", async () => {
    captureOutput();
    const runCli = vi.fn(() => "Added obsidian-tc\n");

    await runInstallClient(
      { kind: "setup", installClient: "claude-code", yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(runCli).toHaveBeenCalledWith("claude", [
      "mcp",
      "add",
      "--scope",
      "user",
      "obsidian-tc",
      "--",
      "obsidian-tc",
      "--config",
      expect.stringContaining("config.json"),
    ]);
    expect(stdout.join("")).toContain("claude mcp add --scope user obsidian-tc");
    expect(stdout.join("")).toContain("Added obsidian-tc");
    expect(process.exitCode).toBeUndefined();
  });

  it("--dry-run prints the command but never runs it", async () => {
    captureOutput();
    const runCli = vi.fn(() => "should not run");

    await runInstallClient(
      { kind: "setup", installClient: "claude-code", yes: false, dryRun: true, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(runCli).not.toHaveBeenCalled();
    expect(stdout.join("")).toMatch(/dry-run/);
  });

  it("a failed/missing `claude` binary is reported, not thrown", async () => {
    captureOutput();
    const runCli = vi.fn(() => {
      throw new Error("ENOENT: no such file or directory, spawn claude");
    });

    await runInstallClient(
      { kind: "setup", installClient: "claude-code", yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(stderr.join("")).toMatch(/ENOENT/);
    expect(process.exitCode).toBe(1);
  });

  it("finding 6: the printed command quotes a config path containing a space", async () => {
    captureOutput();
    const runCli = vi.fn(() => "Added obsidian-tc\n");
    const configPath = "/home/op user/.obsidian-tc/config.json";

    await runInstallClient(
      {
        kind: "setup",
        installClient: "claude-code",
        configPath,
        yes: false,
        dryRun: false,
        force: false,
      },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    // execFileSync itself gets the unquoted argv array (argv-safe by construction — never a
    // shell) — only the printed, copy-pasteable line needs quoting.
    expect(runCli).toHaveBeenCalledWith("claude", expect.arrayContaining([configPath]));
    expect(stdout.join("")).toContain(`'${configPath}'`);
  });
});

describe("runInstallClient — claude-desktop / cursor JSON merge", () => {
  it("writes a fresh claude_desktop_config.json when none exists", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");

    await runInstallClient(
      {
        kind: "setup",
        installClient: "claude-desktop",
        configPath,
        yes: false,
        dryRun: false,
        force: false,
      },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    const target = join(home, ".config", "Claude", "claude_desktop_config.json");
    expect(existsSync(target)).toBe(true);
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk.mcpServers["obsidian-tc"]).toEqual({
      command: "obsidian-tc",
      args: ["--config", configPath],
    });
  });

  it("merges into an existing cursor mcp.json without dropping other servers, and backs it up", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");
    const cursorDir = join(home, ".cursor");
    const cursorPath = join(cursorDir, "mcp.json");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      cursorPath,
      JSON.stringify({ mcpServers: { github: { command: "gh-mcp", args: [] } } }),
    );

    await runInstallClient(
      {
        kind: "setup",
        installClient: "cursor",
        configPath,
        yes: false,
        dryRun: false,
        force: false,
      },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    const onDisk = JSON.parse(readFileSync(cursorPath, "utf8"));
    expect(onDisk.mcpServers.github).toEqual({ command: "gh-mcp", args: [] });
    expect(onDisk.mcpServers["obsidian-tc"]).toEqual({
      command: "obsidian-tc",
      args: ["--config", configPath],
    });
    expect(stdout.join("")).toMatch(/backed up/);
  });

  it("refuses a duplicate obsidian-tc entry without --force, and does not touch the file", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");
    const cursorDir = join(home, ".cursor");
    const cursorPath = join(cursorDir, "mcp.json");
    mkdirSync(cursorDir, { recursive: true });
    const original = JSON.stringify({
      mcpServers: { "obsidian-tc": { command: "obsidian-tc", args: ["--config", "/old.json"] } },
    });
    writeFileSync(cursorPath, original);

    await runInstallClient(
      {
        kind: "setup",
        installClient: "cursor",
        configPath,
        yes: false,
        dryRun: false,
        force: false,
      },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    expect(readFileSync(cursorPath, "utf8")).toBe(original);
    expect(stderr.join("")).toMatch(/already has an "obsidian-tc"/);
    expect(process.exitCode).toBe(1);
  });

  it("--force overwrites the duplicate entry", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");
    const cursorDir = join(home, ".cursor");
    const cursorPath = join(cursorDir, "mcp.json");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      cursorPath,
      JSON.stringify({
        mcpServers: { "obsidian-tc": { command: "obsidian-tc", args: ["--config", "/old.json"] } },
      }),
    );

    await runInstallClient(
      {
        kind: "setup",
        installClient: "cursor",
        configPath,
        yes: false,
        dryRun: false,
        force: true,
      },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    const onDisk = JSON.parse(readFileSync(cursorPath, "utf8"));
    expect(onDisk.mcpServers["obsidian-tc"].args).toEqual(["--config", configPath]);
  });

  it("--dry-run writes nothing", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");

    await runInstallClient(
      {
        kind: "setup",
        installClient: "claude-desktop",
        configPath,
        yes: false,
        dryRun: true,
        force: false,
      },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    const target = join(home, ".config", "Claude", "claude_desktop_config.json");
    expect(existsSync(target)).toBe(false);
    expect(stdout.join("")).toMatch(/dry-run/);
    // CI fix (windows-latest build-test): the printed text is the JSON.stringify'd config, which
    // escapes every backslash — `configPath` on Windows (`D:\a\...\config.json`) is never a raw
    // substring of that escaped output. Compare against the SAME escaping `JSON.stringify` would
    // produce (or parse the printed JSON back), not the raw path.
    expect(stdout.join("")).toContain(JSON.stringify(configPath));
  });
});

// RED case: this change's own registry rewrite — before it, "codex"/"antigravity"/"hermes" were
// not valid --install-client values at all, so runInstallClient threw a plain
// "runInstallClient called without --install-client" (installClient stayed undefined at parse
// time) rather than running that client's own CLI.
describe.each([
  { client: "codex" as const, binary: "codex", first: "mcp" },
  { client: "antigravity" as const, binary: "agy", first: "mcp" },
  { client: "hermes" as const, binary: "hermes", first: "mcp" },
])("runInstallClient — $client (CLI)", ({ client, binary, first }) => {
  it("prints and runs that client's own mcp-add command", async () => {
    captureOutput();
    const runCli = vi.fn((_binary: string, _args: string[]) => "ok\n");

    await runInstallClient(
      { kind: "setup", installClient: client, yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(runCli).toHaveBeenCalledTimes(1);
    const [calledBinary, calledArgs] = runCli.mock.calls[0] ?? ["", []];
    expect(calledBinary).toBe(binary);
    expect(calledArgs[0]).toBe(first);
    expect(calledArgs).toContain("obsidian-tc");
    expect(stdout.join("")).toContain(binary);
    expect(process.exitCode).toBeUndefined();
  });

  it("--dry-run prints the command but never runs it", async () => {
    captureOutput();
    const runCli = vi.fn(() => "should not run");

    await runInstallClient(
      { kind: "setup", installClient: client, yes: false, dryRun: true, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(runCli).not.toHaveBeenCalled();
    expect(stdout.join("")).toMatch(/dry-run/);
  });

  it("a failed/missing binary is reported, not thrown", async () => {
    captureOutput();
    const runCli = vi.fn(() => {
      throw new Error(`ENOENT: no such file or directory, spawn ${binary}`);
    });

    await runInstallClient(
      { kind: "setup", installClient: client, yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(stderr.join("")).toMatch(/ENOENT/);
    expect(process.exitCode).toBe(1);
  });

  it("the printed command quotes a config path containing a space", async () => {
    captureOutput();
    const runCli = vi.fn(() => "ok\n");
    const configPath = "/home/op user/.obsidian-tc/config.json";

    await runInstallClient(
      { kind: "setup", installClient: client, configPath, yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    // execFileSync itself gets the unquoted argv array (argv-safe by construction — never a
    // shell) — only the printed, copy-pasteable line needs quoting.
    expect(runCli).toHaveBeenCalledWith(binary, expect.arrayContaining([configPath]));
    expect(stdout.join("")).toContain(`'${configPath}'`);
  });
});

describe("runInstallClient — chatgpt (instructions-only)", () => {
  it("prints instructions and writes nothing, exit 0", async () => {
    captureOutput();
    const runCli = vi.fn(() => "should never be called");

    await runInstallClient(
      { kind: "setup", installClient: "chatgpt", yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(runCli).not.toHaveBeenCalled();
    expect(stdout.join("")).toMatch(/remote|HTTPS/i);
    expect(stdout.join("")).toMatch(/Deployment-Modes/);
    expect(process.exitCode).toBeUndefined();
  });

  it("--dry-run and --force change nothing — still just prints instructions", async () => {
    captureOutput();
    const runCli = vi.fn(() => "should never be called");

    await runInstallClient(
      { kind: "setup", installClient: "chatgpt", yes: false, dryRun: true, force: true },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(runCli).not.toHaveBeenCalled();
    expect(stdout.join("")).toMatch(/remote|HTTPS/i);
    expect(process.exitCode).toBeUndefined();
  });
});

// RED case: before this change, "vscode"/"opencode"/"windsurf"/"gemini"/"zed"/"devin"/"aider" were
// not valid --install-client values — parse-setup.ts refused them before runInstallClient was ever
// reached.
describe("runInstallClient — vscode (CLI, name embedded in JSON payload)", () => {
  it("prints and runs `code --add-mcp '{...}'`", async () => {
    captureOutput();
    const runCli = vi.fn((_binary: string, _args: string[]) => "ok\n");

    await runInstallClient(
      { kind: "setup", installClient: "vscode", yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(runCli).toHaveBeenCalledTimes(1);
    const [calledBinary, calledArgs] = runCli.mock.calls[0] ?? ["", []];
    expect(calledBinary).toBe("code");
    expect(calledArgs[0]).toBe("--add-mcp");
    expect(JSON.parse(calledArgs[1] as string)).toMatchObject({ name: "obsidian-tc" });
    expect(process.exitCode).toBeUndefined();
  });

  it("a failed/missing `code` binary is reported, not thrown", async () => {
    captureOutput();
    const runCli = vi.fn(() => {
      throw new Error("ENOENT: no such file or directory, spawn code");
    });

    await runInstallClient(
      { kind: "setup", installClient: "vscode", yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(stderr.join("")).toMatch(/ENOENT/);
    expect(process.exitCode).toBe(1);
  });
});

describe("runInstallClient — gemini (CLI)", () => {
  it("prints and runs `gemini mcp add`", async () => {
    captureOutput();
    const runCli = vi.fn(() => "ok\n");

    await runInstallClient(
      { kind: "setup", installClient: "gemini", yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(runCli).toHaveBeenCalledWith(
      "gemini",
      expect.arrayContaining(["mcp", "add", "obsidian-tc"]),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("--dry-run prints the command but never runs it", async () => {
    captureOutput();
    const runCli = vi.fn(() => "should not run");

    await runInstallClient(
      { kind: "setup", installClient: "gemini", yes: false, dryRun: true, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(runCli).not.toHaveBeenCalled();
    expect(stdout.join("")).toMatch(/dry-run/);
  });
});

describe("runInstallClient — opencode (jsonc-merge)", () => {
  it("writes a fresh opencode.json when none exists", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");

    await runInstallClient(
      {
        kind: "setup",
        installClient: "opencode",
        configPath,
        yes: false,
        dryRun: false,
        force: false,
      },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    const target = join(home, ".config", "opencode", "opencode.json");
    expect(existsSync(target)).toBe(true);
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk.mcp["obsidian-tc"]).toEqual({
      type: "local",
      command: ["obsidian-tc", "--config", configPath],
      enabled: true,
      environment: {},
    });
  });

  it("merges into an existing opencode.json WITHOUT dropping a comment or another server", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");
    const dir = join(home, ".config", "opencode");
    const target = join(dir, "opencode.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      target,
      [
        "{",
        "  // keep this comment",
        '  "mcp": {',
        '    "fs": { "type": "local", "command": ["x"] }',
        "  }",
        "}",
      ].join("\n"),
    );

    await runInstallClient(
      {
        kind: "setup",
        installClient: "opencode",
        configPath,
        yes: false,
        dryRun: false,
        force: false,
      },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    const text = readFileSync(target, "utf8");
    expect(text).toContain("// keep this comment");
    const parsed = JSON.parse(text.replace(/\/\/.*$/gm, ""));
    expect(parsed.mcp.fs).toEqual({ type: "local", command: ["x"] });
    expect(parsed.mcp["obsidian-tc"].type).toBe("local");
  });

  it("refuses a duplicate obsidian-tc entry without --force", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");
    const dir = join(home, ".config", "opencode");
    const target = join(dir, "opencode.json");
    mkdirSync(dir, { recursive: true });
    const original = JSON.stringify({
      mcp: { "obsidian-tc": { type: "local", command: ["old"] } },
    });
    writeFileSync(target, original);

    await runInstallClient(
      {
        kind: "setup",
        installClient: "opencode",
        configPath,
        yes: false,
        dryRun: false,
        force: false,
      },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    expect(readFileSync(target, "utf8")).toBe(original);
    expect(stderr.join("")).toMatch(/already has an "obsidian-tc"/);
    expect(process.exitCode).toBe(1);
  });

  it("--dry-run writes nothing", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");

    await runInstallClient(
      {
        kind: "setup",
        installClient: "opencode",
        configPath,
        yes: false,
        dryRun: true,
        force: false,
      },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(false);
    expect(stdout.join("")).toMatch(/dry-run/);
  });
});

describe("runInstallClient — windsurf (json-merge, legacy-path preference)", () => {
  it("writes the CURRENT devin path when no legacy install exists", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");

    await runInstallClient(
      {
        kind: "setup",
        installClient: "windsurf",
        configPath,
        yes: false,
        dryRun: false,
        force: false,
      },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    const target = join(home, ".config", "devin", "mcp_config.json");
    expect(existsSync(target)).toBe(true);
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk.mcpServers["obsidian-tc"]).toEqual({
      command: "obsidian-tc",
      args: ["--config", configPath],
    });
  });

  it("prefers the LEGACY Codeium path when it already exists on disk", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");
    const legacyDir = join(home, ".codeium", "windsurf");
    const legacyPath = join(legacyDir, "mcp_config.json");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ mcpServers: {} }));

    await runInstallClient(
      {
        kind: "setup",
        installClient: "windsurf",
        configPath,
        yes: false,
        dryRun: false,
        force: false,
      },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    const onDisk = JSON.parse(readFileSync(legacyPath, "utf8"));
    expect(onDisk.mcpServers["obsidian-tc"]).toEqual({
      command: "obsidian-tc",
      args: ["--config", configPath],
    });
    expect(existsSync(join(home, ".config", "devin", "mcp_config.json"))).toBe(false);
  });

  it("--install-client devin-desktop (the alias) writes to the same place as windsurf", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");

    await runInstallClient(
      {
        kind: "setup",
        installClient: "windsurf", // parse-setup.ts already normalized the alias before this layer
        configPath,
        yes: false,
        dryRun: false,
        force: false,
      },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    expect(existsSync(join(home, ".config", "devin", "mcp_config.json"))).toBe(true);
  });
});

describe("runInstallClient — zed (jsonc-merge, no source:custom field)", () => {
  it("writes a fresh settings.json with the three-field entry", async () => {
    captureOutput();
    const home = tmpDir("otc-install-client-home-");
    const configPath = join(home, ".obsidian-tc", "config.json");

    await runInstallClient(
      { kind: "setup", installClient: "zed", configPath, yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home, runCli: () => "" },
    );

    const target = join(home, ".config", "zed", "settings.json");
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk.context_servers["obsidian-tc"]).toEqual({
      command: "obsidian-tc",
      args: ["--config", configPath],
      env: {},
    });
    expect(onDisk.context_servers["obsidian-tc"].source).toBeUndefined();
  });
});

describe("runInstallClient — devin (instructions-only, distinct from windsurf)", () => {
  it("prints instructions and writes nothing, exit 0", async () => {
    captureOutput();
    const runCli = vi.fn(() => "should never be called");

    await runInstallClient(
      { kind: "setup", installClient: "devin", yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(runCli).not.toHaveBeenCalled();
    expect(stdout.join("")).toMatch(/no local-stdio reach|cloud/i);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("runInstallClient — aider (unsupported: no MCP mechanism at all)", () => {
  it("writes nothing and exits non-zero with a clear message, ignoring --dry-run/--force", async () => {
    captureOutput();
    const runCli = vi.fn(() => "should never be called");

    await runInstallClient(
      { kind: "setup", installClient: "aider", yes: false, dryRun: true, force: true },
      { platform: "linux", env: {}, home: "/home/op", runCli },
    );

    expect(runCli).not.toHaveBeenCalled();
    expect(stderr.join("")).toMatch(/no MCP support/i);
    expect(process.exitCode).toBe(1);
  });
});
