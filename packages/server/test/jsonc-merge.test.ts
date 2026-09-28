// PR B follow-up (VS Code/opencode/Windsurf/Zed/Gemini CLI/Devin/Aider): pure unit tests for
// cli/setup/jsonc-merge.ts — no filesystem. See test/setup-install-client-e2e.test.ts for the I/O
// glue (opencode/Zed's own `jsonc-merge` branch in `runInstallClient`).
import { describe, expect, it } from "vitest";
import { mergeMcpServersEntryJsonc } from "../src/cli/setup/jsonc-merge";

describe("mergeMcpServersEntryJsonc", () => {
  it("creates the key from scratch when no existing file", () => {
    const { alreadyExists, text } = mergeMcpServersEntryJsonc(undefined, {
      command: "obsidian-tc",
    });
    expect(alreadyExists).toBe(false);
    expect(JSON.parse(text)).toEqual({ mcpServers: { "obsidian-tc": { command: "obsidian-tc" } } });
  });

  it("PRESERVES a comment and every other server already present", () => {
    const existing = [
      "{",
      "  // do not touch this server",
      '  "mcpServers": {',
      '    "github": { "command": "gh-mcp", "args": [] }',
      "  },",
      '  "otherTopKey": 1',
      "}",
    ].join("\n");
    const { alreadyExists, text } = mergeMcpServersEntryJsonc(existing, { command: "obsidian-tc" });
    expect(alreadyExists).toBe(false);
    expect(text).toContain("// do not touch this server");
    const parsed = JSON.parse(text.replace(/\/\/.*$/gm, ""));
    expect(parsed.mcpServers.github).toEqual({ command: "gh-mcp", args: [] });
    expect(parsed.mcpServers["obsidian-tc"]).toEqual({ command: "obsidian-tc" });
    expect(parsed.otherTopKey).toBe(1);
  });

  it("merges under a non-default serversKey (Zed's context_servers, opencode's mcp)", () => {
    const { text } = mergeMcpServersEntryJsonc(
      undefined,
      { command: "obsidian-tc" },
      {},
      "context_servers",
    );
    expect(JSON.parse(text)).toEqual({
      context_servers: { "obsidian-tc": { command: "obsidian-tc" } },
    });
  });

  it("refuses a duplicate obsidian-tc entry without force — text is unchanged, comments intact", () => {
    const existing = '{\n  // keep me\n  "mcpServers": { "obsidian-tc": { "command": "old" } }\n}';
    const { alreadyExists, text } = mergeMcpServersEntryJsonc(existing, { command: "new" });
    expect(alreadyExists).toBe(true);
    expect(text).toBe(existing);
  });

  it("overwrites a duplicate obsidian-tc entry with force, preserving unrelated comments", () => {
    const existing = '{\n  // keep me\n  "mcpServers": { "obsidian-tc": { "command": "old" } }\n}';
    const { alreadyExists, text } = mergeMcpServersEntryJsonc(
      existing,
      { command: "new" },
      {
        force: true,
      },
    );
    expect(alreadyExists).toBe(false);
    expect(text).toContain("// keep me");
    expect(JSON.parse(text.replace(/\/\/.*$/gm, "")).mcpServers["obsidian-tc"]).toEqual({
      command: "new",
    });
  });

  it("refuses (never silently replaces) a serversKey that is an array, not an object", () => {
    const existing = '{ "mcpServers": [1, 2, 3] }';
    expect(() => mergeMcpServersEntryJsonc(existing, { command: "obsidian-tc" })).toThrow(
      /mcpServers.*not a JSON object/,
    );
  });

  it("refuses a non-object, non-array serversKey (a string) the same way", () => {
    const existing = '{ "mcpServers": "not-an-object" }';
    expect(() => mergeMcpServersEntryJsonc(existing, { command: "obsidian-tc" })).toThrow(
      /mcpServers.*not a JSON object/,
    );
  });

  it("refuses malformed JSON/JSONC rather than silently overwriting it", () => {
    const existing = '{ "mcpServers": ';
    expect(() => mergeMcpServersEntryJsonc(existing, { command: "obsidian-tc" })).toThrow(
      /not valid JSON\/JSONC/,
    );
  });

  it("builds a multi-token array command entry (opencode's own local-server shape)", () => {
    const { text } = mergeMcpServersEntryJsonc(
      undefined,
      {
        type: "local",
        command: ["obsidian-tc", "--config", "/cfg.json"],
        enabled: true,
        environment: {},
      },
      {},
      "mcp",
    );
    expect(JSON.parse(text)).toEqual({
      mcp: {
        "obsidian-tc": {
          type: "local",
          command: ["obsidian-tc", "--config", "/cfg.json"],
          enabled: true,
          environment: {},
        },
      },
    });
  });
});
