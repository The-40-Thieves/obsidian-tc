// PR B of GH #995's two-part follow-up: pure unit tests for cli/setup/client-install.ts — path
// resolvers, entry/command builders, and the JSON merge. No filesystem, no `claude` binary. See
// test/setup-install-client-e2e.test.ts for the I/O glue (cli/commands/setup-install-client.ts).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALL_CLIENTS } from "../src/cli/parse-setup";
import {
  antigravityAddCommand,
  CLIENT_REGISTRY,
  chatgptInstructions,
  claudeCodeAddCommand,
  claudeDesktopConfigPath,
  clientLabel,
  codexAddCommand,
  cursorMcpConfigPath,
  formatClientSnippets,
  hermesAddCommand,
  mergeMcpServersEntry,
  obsidianTcServerEntry,
  shellQuoteArg,
} from "../src/cli/setup/client-install";

describe("claudeDesktopConfigPath", () => {
  it("uses %APPDATA%\\Claude on win32", () => {
    const p = claudeDesktopConfigPath(
      "win32",
      { APPDATA: "C:\\Users\\op\\AppData\\Roaming" },
      "C:\\Users\\op",
    );
    expect(p).toBe(join("C:\\Users\\op\\AppData\\Roaming", "Claude", "claude_desktop_config.json"));
  });

  it("falls back to home/AppData/Roaming on win32 when APPDATA is unset", () => {
    const p = claudeDesktopConfigPath("win32", {}, "/c/Users/op");
    expect(p).toBe(
      join("/c/Users/op", "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
    );
  });

  it("uses ~/Library/Application Support/Claude on darwin", () => {
    const p = claudeDesktopConfigPath("darwin", {}, "/Users/op");
    expect(p).toBe(
      join("/Users/op", "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
  });

  it("uses $XDG_CONFIG_HOME/Claude on linux when set", () => {
    const p = claudeDesktopConfigPath("linux", { XDG_CONFIG_HOME: "/home/op/.config" }, "/home/op");
    expect(p).toBe(join("/home/op/.config", "Claude", "claude_desktop_config.json"));
  });

  it("falls back to ~/.config/Claude on linux when XDG_CONFIG_HOME is unset", () => {
    const p = claudeDesktopConfigPath("linux", {}, "/home/op");
    expect(p).toBe(join("/home/op", ".config", "Claude", "claude_desktop_config.json"));
  });
});

describe("cursorMcpConfigPath", () => {
  it("is always ~/.cursor/mcp.json — no per-OS branching", () => {
    expect(cursorMcpConfigPath("/home/op")).toBe(join("/home/op", ".cursor", "mcp.json"));
  });
});

describe("claudeCodeAddCommand", () => {
  it("uses the documented `claude mcp add --scope user <name> -- <cmd> [args]` shape", () => {
    expect(claudeCodeAddCommand("/home/op/.obsidian-tc/config.json")).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "obsidian-tc",
      "--",
      "obsidian-tc",
      "--config",
      "/home/op/.obsidian-tc/config.json",
    ]);
  });
});

describe("obsidianTcServerEntry", () => {
  it("is the same {command,args} shape both JSON clients use", () => {
    expect(obsidianTcServerEntry("/cfg.json")).toEqual({
      command: "obsidian-tc",
      args: ["--config", "/cfg.json"],
    });
  });
});

describe("mergeMcpServersEntry", () => {
  it("creates mcpServers from scratch when no existing file", () => {
    const { alreadyExists, merged } = mergeMcpServersEntry(undefined, "/cfg.json");
    expect(alreadyExists).toBe(false);
    expect(merged).toEqual({
      mcpServers: { "obsidian-tc": { command: "obsidian-tc", args: ["--config", "/cfg.json"] } },
    });
  });

  it("preserves every OTHER server already present", () => {
    const existing = { mcpServers: { github: { command: "gh-mcp", args: [] } }, otherTopKey: 1 };
    const { merged } = mergeMcpServersEntry(existing, "/cfg.json");
    expect(merged.otherTopKey).toBe(1);
    expect((merged.mcpServers as Record<string, unknown>).github).toEqual({
      command: "gh-mcp",
      args: [],
    });
    expect((merged.mcpServers as Record<string, unknown>)["obsidian-tc"]).toEqual({
      command: "obsidian-tc",
      args: ["--config", "/cfg.json"],
    });
  });

  it("refuses a duplicate obsidian-tc entry without force — merged is unchanged", () => {
    const existing = {
      mcpServers: { "obsidian-tc": { command: "obsidian-tc", args: ["--config", "/old.json"] } },
    };
    const { alreadyExists, merged } = mergeMcpServersEntry(existing, "/new.json");
    expect(alreadyExists).toBe(true);
    expect(merged).toEqual(existing);
  });

  it("overwrites a duplicate obsidian-tc entry with force", () => {
    const existing = {
      mcpServers: { "obsidian-tc": { command: "obsidian-tc", args: ["--config", "/old.json"] } },
    };
    const { alreadyExists, merged } = mergeMcpServersEntry(existing, "/new.json", { force: true });
    expect(alreadyExists).toBe(false);
    expect((merged.mcpServers as Record<string, unknown>)["obsidian-tc"]).toEqual({
      command: "obsidian-tc",
      args: ["--config", "/new.json"],
    });
  });

  it("finding 5: refuses (never silently replaces) an mcpServers that is an array, not an object", () => {
    const existing = { mcpServers: [{ command: "gh-mcp" }], otherTopKey: 1 };
    expect(() => mergeMcpServersEntry(existing, "/cfg.json")).toThrow(
      /mcpServers.*not a JSON object/,
    );
  });

  it("finding 5: refuses a non-object, non-array mcpServers (a string) the same way", () => {
    const existing = { mcpServers: "not-an-object" };
    expect(() => mergeMcpServersEntry(existing, "/cfg.json")).toThrow(
      /mcpServers.*not a JSON object/,
    );
  });
});

describe("clientLabel", () => {
  it("has a human label for every INSTALL_CLIENTS id", () => {
    expect(clientLabel("claude-code")).toBe("Claude Code");
    expect(clientLabel("claude-desktop")).toBe("Claude Desktop");
    expect(clientLabel("cursor")).toBe("Cursor");
    expect(clientLabel("codex")).toBe("Codex CLI");
    expect(clientLabel("chatgpt")).toBe("ChatGPT");
    expect(clientLabel("antigravity")).toBe("Antigravity");
    expect(clientLabel("hermes")).toBe("Hermes Agent");
  });
});

describe("codexAddCommand", () => {
  it("uses the documented `codex mcp add <name> -- <command>...` shape", () => {
    expect(codexAddCommand("/home/op/.obsidian-tc/config.json")).toEqual([
      "mcp",
      "add",
      "obsidian-tc",
      "--",
      "obsidian-tc",
      "--config",
      "/home/op/.obsidian-tc/config.json",
    ]);
  });
});

describe("antigravityAddCommand", () => {
  it("uses the documented `agy mcp add <name> <commandOrUrl> [args...]` shape", () => {
    expect(antigravityAddCommand("/home/op/.obsidian-tc/config.json")).toEqual([
      "mcp",
      "add",
      "obsidian-tc",
      "obsidian-tc",
      "--config",
      "/home/op/.obsidian-tc/config.json",
    ]);
  });
});

describe("hermesAddCommand", () => {
  it("uses the documented `hermes mcp add <name> --command <cmd> --args <args...>` shape, with --args LAST", () => {
    expect(hermesAddCommand("/home/op/.obsidian-tc/config.json")).toEqual([
      "mcp",
      "add",
      "obsidian-tc",
      "--command",
      "obsidian-tc",
      "--args",
      "--config",
      "/home/op/.obsidian-tc/config.json",
    ]);
  });
});

describe("chatgptInstructions", () => {
  it("names the remote-HTTPS-only limitation and points at the shared-HTTP-server docs", () => {
    const text = chatgptInstructions();
    expect(text).toMatch(/remote|HTTPS/i);
    expect(text).toMatch(/no local/i);
    expect(text).toContain("docs/wiki/Deployment-Modes.md");
    expect(text).toContain("run-one-shared-server-for-several-clients");
  });
});

describe("CLIENT_REGISTRY", () => {
  it("has exactly one entry per INSTALL_CLIENTS id, each with a non-empty displayName and sourceNote", () => {
    for (const client of INSTALL_CLIENTS) {
      const entry = CLIENT_REGISTRY[client];
      expect(entry, `missing registry entry for "${client}"`).toBeDefined();
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(entry.sourceNote.length).toBeGreaterThan(0);
    }
    expect(Object.keys(CLIENT_REGISTRY).sort()).toEqual([...INSTALL_CLIENTS].sort());
  });

  it("every cli-kind entry's binary is invoked via buildArgs, never a shell", () => {
    for (const client of INSTALL_CLIENTS) {
      const entry = CLIENT_REGISTRY[client];
      if (entry.kind !== "cli") continue;
      expect(entry.binary.length).toBeGreaterThan(0);
      expect(entry.buildArgs("/cfg.json")).toContain("obsidian-tc");
    }
  });
});

describe("formatClientSnippets", () => {
  it("names all seven clients and the config path", () => {
    const text = formatClientSnippets("/home/op/.obsidian-tc/config.json", "linux", {}, "/home/op");
    expect(text).toContain("Claude Code");
    expect(text).toContain("Claude Desktop");
    expect(text).toContain("Cursor");
    expect(text).toContain("Codex CLI");
    expect(text).toContain("ChatGPT");
    expect(text).toContain("Antigravity");
    expect(text).toContain("Hermes Agent");
    expect(text).toContain("/home/op/.obsidian-tc/config.json");
    expect(text).toContain("claude mcp add --scope user obsidian-tc -- obsidian-tc --config");
    expect(text).toContain("codex mcp add obsidian-tc -- obsidian-tc --config");
    expect(text).toContain("agy mcp add obsidian-tc obsidian-tc --config");
    expect(text).toContain("hermes mcp add obsidian-tc --command obsidian-tc --args --config");
    expect(text).toContain("docs/wiki/Deployment-Modes.md");
  });

  it("finding 3: labels the win32 snippet as PowerShell and single-quotes its config path", () => {
    const text = formatClientSnippets(
      "C:\\Users\\Op Name\\.obsidian-tc\\config.json",
      "win32",
      {},
      "C:\\Users\\Op Name",
    );
    expect(text).toMatch(/Claude Code.*PowerShell/);
    expect(text).toContain(
      "claude mcp add --scope user obsidian-tc -- obsidian-tc --config 'C:\\Users\\Op Name\\.obsidian-tc\\config.json'",
    );
  });

  it("finding 6: quotes the printed claude mcp add line's config path when it has a space", () => {
    const text = formatClientSnippets(
      "/home/op user/.obsidian-tc/config.json",
      "linux",
      {},
      "/home/op user",
    );
    expect(text).toContain(
      "claude mcp add --scope user obsidian-tc -- obsidian-tc --config '/home/op user/.obsidian-tc/config.json'",
    );
  });
});

describe("shellQuoteArg", () => {
  it("leaves a plain token unquoted on POSIX", () => {
    expect(shellQuoteArg("obsidian-tc", "linux")).toBe("obsidian-tc");
  });

  it("single-quotes a POSIX arg containing a space, escaping an embedded single quote", () => {
    expect(shellQuoteArg("/home/op's stuff/config.json", "linux")).toBe(
      "'/home/op'\\''s stuff/config.json'",
    );
  });

  // Finding 3 (fix round, cross-vendor review): the printed win32 line is documented as a
  // PowerShell literal (PowerShell is the default Windows terminal). A DOUBLE-quoted win32 arg
  // still expands `$var`/backtick escapes/`%VAR%` inside PowerShell and cmd.exe respectively —
  // single-quoting is the one PowerShell literal form where NONE of those expand, only an
  // embedded `'` needs escaping (doubled, PowerShell's own quoting rule).
  it("single-quotes a win32 arg containing a space, PowerShell-style", () => {
    expect(shellQuoteArg("C:\\Users\\Op Name\\config.json", "win32")).toBe(
      "'C:\\Users\\Op Name\\config.json'",
    );
  });

  it("leaves a plain token unquoted on win32", () => {
    expect(shellQuoteArg("--config", "win32")).toBe("--config");
  });

  it("finding 3: single-quotes and never expands a win32 path containing $", () => {
    expect(shellQuoteArg("C:\\Users\\foo$bar\\config.json", "win32")).toBe(
      "'C:\\Users\\foo$bar\\config.json'",
    );
  });

  it("finding 3: single-quotes and never expands a win32 path containing a backtick", () => {
    expect(shellQuoteArg("C:\\Users\\foo`bar\\config.json", "win32")).toBe(
      "'C:\\Users\\foo`bar\\config.json'",
    );
  });

  it("finding 3: single-quotes and never expands a win32 path containing %VAR%", () => {
    expect(shellQuoteArg("C:\\Users\\%USERNAME%\\config.json", "win32")).toBe(
      "'C:\\Users\\%USERNAME%\\config.json'",
    );
  });

  it("finding 3: doubles an embedded single quote — PowerShell's own escape inside a single-quoted string", () => {
    expect(shellQuoteArg("C:\\Users\\Op's Name\\config.json", "win32")).toBe(
      "'C:\\Users\\Op''s Name\\config.json'",
    );
  });
});
