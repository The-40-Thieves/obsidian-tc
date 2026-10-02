// PR C follow-up: pure unit tests for cli/setup/client-install-agents.ts — path resolvers and entry
// builders for Cline, Roo Code, Continue, Goose, Amazon Q, Kiro, JetBrains, Warp, Augment. No
// filesystem. See test/setup-install-client-e2e.test.ts for the I/O glue.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALL_CLIENTS } from "../src/cli/parse-setup";
import { CLIENT_REGISTRY } from "../src/cli/setup/client-install";
import {
  AGENT_CLIENT_REGISTRY,
  amazonQInstructions,
  augmentAddCommand,
  clineMcpSettingsPath,
  clineServerEntry,
  continueMcpServerFilePath,
  continueServerEntry,
  gooseConfigPath,
  gooseServerEntry,
  jetbrainsInstructions,
  kiroMcpConfigPath,
  kiroServerEntry,
  rooMcpSettingsPath,
  rooServerEntry,
  warpMcpConfigPath,
  warpServerEntry,
} from "../src/cli/setup/client-install-agents";

describe("clineMcpSettingsPath", () => {
  it("linux: VS Code globalStorage under saoudrizwan.claude-dev", () => {
    expect(clineMcpSettingsPath("linux", {}, "/home/op")).toBe(
      join(
        "/home/op",
        ".config",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      ),
    );
  });

  it("darwin: Library/Application Support", () => {
    expect(clineMcpSettingsPath("darwin", {}, "/Users/op")).toBe(
      join(
        "/Users/op",
        "Library",
        "Application Support",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      ),
    );
  });

  it("win32: %APPDATA%", () => {
    expect(
      clineMcpSettingsPath(
        "win32",
        { APPDATA: "C:\\Users\\op\\AppData\\Roaming" },
        "C:\\Users\\op",
      ),
    ).toBe(
      join(
        "C:\\Users\\op\\AppData\\Roaming",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      ),
    );
  });

  it("clineServerEntry uses command/args/env/disabled/autoApprove", () => {
    expect(clineServerEntry("/cfg.json")).toEqual({
      command: "obsidian-tc",
      args: ["--config", "/cfg.json"],
      env: {},
      disabled: false,
      autoApprove: [],
    });
  });
});

describe("rooMcpSettingsPath", () => {
  it("uses mcp_settings.json (NOT cline's filename) under rooveterinaryinc.roo-cline", () => {
    expect(rooMcpSettingsPath("linux", {}, "/home/op")).toBe(
      join(
        "/home/op",
        ".config",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "settings",
        "mcp_settings.json",
      ),
    );
  });

  it("rooServerEntry uses alwaysAllow, not autoApprove", () => {
    expect(rooServerEntry("/cfg.json")).toEqual({
      command: "obsidian-tc",
      args: ["--config", "/cfg.json"],
      env: {},
      alwaysAllow: [],
      disabled: false,
    });
  });
});

describe("continueMcpServerFilePath / continueServerEntry", () => {
  it("is a dedicated .continue/mcpServers/obsidian-tc.yaml, home-anchored on every OS", () => {
    expect(continueMcpServerFilePath("/home/op")).toBe(
      join("/home/op", ".continue", "mcpServers", "obsidian-tc.yaml"),
    );
  });

  it("builds the whole per-server file's document (name/version/schema + one-entry mcpServers list)", () => {
    expect(continueServerEntry("/cfg.json")).toEqual({
      name: "obsidian-tc",
      version: "0.0.1",
      schema: "v1",
      mcpServers: [
        {
          name: "obsidian-tc",
          type: "stdio",
          command: "obsidian-tc",
          args: ["--config", "/cfg.json"],
        },
      ],
    });
  });
});

describe("gooseConfigPath / gooseServerEntry", () => {
  it("uses ~/.config/goose/config.yaml on linux/darwin", () => {
    expect(gooseConfigPath("linux", {}, "/home/op")).toBe(
      join("/home/op", ".config", "goose", "config.yaml"),
    );
  });

  it("uses %APPDATA%\\Block\\goose\\config\\config.yaml on win32", () => {
    expect(
      gooseConfigPath("win32", { APPDATA: "C:\\Users\\op\\AppData\\Roaming" }, "C:\\Users\\op"),
    ).toBe(join("C:\\Users\\op\\AppData\\Roaming", "Block", "goose", "config", "config.yaml"));
  });

  it("builds goose's own extension entry shape (cmd/args/env_keys/envs/type/timeout)", () => {
    expect(gooseServerEntry("/cfg.json")).toEqual({
      bundled: false,
      description: "obsidian-tc MCP server",
      enabled: true,
      name: "obsidian-tc",
      timeout: 300, // stall-ok: a config field of the fixture entry, not a test budget
      type: "stdio",
      cmd: "obsidian-tc",
      args: ["--config", "/cfg.json"],
      env_keys: [],
      envs: {},
    });
  });
});

describe("kiroMcpConfigPath / kiroServerEntry", () => {
  it("is always ~/.kiro/settings/mcp.json — no per-OS branching", () => {
    expect(kiroMcpConfigPath("/home/op")).toBe(join("/home/op", ".kiro", "settings", "mcp.json"));
  });

  it("builds command/args/env/disabled/autoApprove", () => {
    expect(kiroServerEntry("/cfg.json")).toEqual({
      command: "obsidian-tc",
      args: ["--config", "/cfg.json"],
      env: {},
      disabled: false,
      autoApprove: [],
    });
  });
});

describe("warpMcpConfigPath / warpServerEntry", () => {
  it("is always ~/.warp/.mcp.json", () => {
    expect(warpMcpConfigPath("/home/op")).toBe(join("/home/op", ".warp", ".mcp.json"));
  });

  it("builds a plain command/args/env entry (no wrapping key — root-level file)", () => {
    expect(warpServerEntry("/cfg.json")).toEqual({
      command: "obsidian-tc",
      args: ["--config", "/cfg.json"],
      env: {},
    });
  });
});

describe("augmentAddCommand", () => {
  it("uses auggie's documented `mcp add --command --args` shape, --args as ONE string token", () => {
    expect(augmentAddCommand("/cfg.json")).toEqual([
      "mcp",
      "add",
      "obsidian-tc",
      "--command",
      "obsidian-tc",
      "--args",
      "--config /cfg.json",
    ]);
  });
});

describe("amazonQInstructions / jetbrainsInstructions", () => {
  it("amazonQInstructions names both the current per-agent and legacy mechanisms", () => {
    const text = amazonQInstructions();
    expect(text).toContain("cli-agents");
    expect(text).toContain("mcp.json");
    expect(text).toContain("useLegacyMcpJson");
  });

  it("jetbrainsInstructions points at the Settings dialog, no path claimed", () => {
    const text = jetbrainsInstructions();
    expect(text).toMatch(/Settings.*AI Assistant/);
    expect(text).toContain("mcpServers");
  });
});

describe("AGENT_CLIENT_REGISTRY", () => {
  it("has exactly the nine agent client ids, each with a non-empty displayName and sourceNote", () => {
    const ids = [
      "cline",
      "roo",
      "continue",
      "goose",
      "amazonq",
      "kiro",
      "jetbrains",
      "warp",
      "augment",
    ];
    expect(Object.keys(AGENT_CLIENT_REGISTRY).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const entry = AGENT_CLIENT_REGISTRY[id as keyof typeof AGENT_CLIENT_REGISTRY];
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(entry.sourceNote.length).toBeGreaterThan(0);
    }
  });

  it("every id is present in the merged CLIENT_REGISTRY and INSTALL_CLIENTS", () => {
    for (const id of Object.keys(AGENT_CLIENT_REGISTRY)) {
      expect(CLIENT_REGISTRY[id as (typeof INSTALL_CLIENTS)[number]]).toBeDefined();
      expect(INSTALL_CLIENTS as readonly string[]).toContain(id);
    }
  });

  it("warp is the only json-merge entry with an empty (root-level) serversKey", () => {
    for (const client of INSTALL_CLIENTS) {
      const entry = CLIENT_REGISTRY[client];
      if (entry.kind !== "json-merge") continue;
      if (client === "warp") {
        expect(entry.serversKey).toBe("");
      } else {
        expect(entry.serversKey).not.toBe("");
      }
    }
  });

  it("continue is the only yaml-merge entry with an empty serversPath", () => {
    for (const client of INSTALL_CLIENTS) {
      const entry = CLIENT_REGISTRY[client];
      if (entry.kind !== "yaml-merge") continue;
      if (client === "continue") {
        expect(entry.serversPath).toEqual([]);
      } else {
        expect(entry.serversPath.length).toBeGreaterThan(0);
      }
    }
  });
});
