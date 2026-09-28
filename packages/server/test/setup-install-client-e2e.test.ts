// PR B of GH #995's two-part follow-up: end-to-end tests for `obsidian-tc setup --install-client`
// — the real filesystem writer (cli/commands/setup-install-client.ts's `runInstallClient`), with
// platform/env/home injected (never the real host's) and `runClaudeMcpAdd` stubbed (never actually
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
    const runClaudeMcpAdd = vi.fn(() => "Added obsidian-tc\n");

    await runInstallClient(
      { kind: "setup", installClient: "claude-code", yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home: "/home/op", runClaudeMcpAdd },
    );

    expect(runClaudeMcpAdd).toHaveBeenCalledWith([
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
    const runClaudeMcpAdd = vi.fn(() => "should not run");

    await runInstallClient(
      { kind: "setup", installClient: "claude-code", yes: false, dryRun: true, force: false },
      { platform: "linux", env: {}, home: "/home/op", runClaudeMcpAdd },
    );

    expect(runClaudeMcpAdd).not.toHaveBeenCalled();
    expect(stdout.join("")).toMatch(/dry-run/);
  });

  it("a failed/missing `claude` binary is reported, not thrown", async () => {
    captureOutput();
    const runClaudeMcpAdd = vi.fn(() => {
      throw new Error("ENOENT: no such file or directory, spawn claude");
    });

    await runInstallClient(
      { kind: "setup", installClient: "claude-code", yes: false, dryRun: false, force: false },
      { platform: "linux", env: {}, home: "/home/op", runClaudeMcpAdd },
    );

    expect(stderr.join("")).toMatch(/ENOENT/);
    expect(process.exitCode).toBe(1);
  });

  it("finding 6: the printed command quotes a config path containing a space", async () => {
    captureOutput();
    const runClaudeMcpAdd = vi.fn(() => "Added obsidian-tc\n");
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
      { platform: "linux", env: {}, home: "/home/op", runClaudeMcpAdd },
    );

    // execFileSync itself gets the unquoted argv array (argv-safe by construction — never a
    // shell) — only the printed, copy-pasteable line needs quoting.
    expect(runClaudeMcpAdd).toHaveBeenCalledWith(expect.arrayContaining([configPath]));
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
      { platform: "linux", env: {}, home, runClaudeMcpAdd: () => "" },
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
      { platform: "linux", env: {}, home, runClaudeMcpAdd: () => "" },
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
      { platform: "linux", env: {}, home, runClaudeMcpAdd: () => "" },
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
      { platform: "linux", env: {}, home, runClaudeMcpAdd: () => "" },
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
      { platform: "linux", env: {}, home, runClaudeMcpAdd: () => "" },
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
