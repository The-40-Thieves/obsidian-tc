// A client config written by a pre-2.0 `setup` has a server entry named "obsidian-tc". Re-running
// setup must not add a second, duplicate server beside it: the old entry counts as existing, and
// --force replaces it with the new one rather than leaving both.
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { mergeMcpServersEntry } from "../src/cli/setup/client-install-types";
import { mergeMcpServersEntryJsonc } from "../src/cli/setup/jsonc-merge";
import { mergeMcpServersEntryYaml } from "../src/cli/setup/yaml-merge";

const OLD = "obsidian-tc";
const NEW = "reliquary-tc";
const entry = { command: NEW, args: ["--config", "/c.json"] };

describe("setup and a pre-2.0 client entry", () => {
  it("json: counts the old entry as existing, and --force replaces it", () => {
    const raw = { mcpServers: { [OLD]: { command: OLD }, other: { command: "x" } } };
    expect(mergeMcpServersEntry(raw, "/c.json").alreadyExists).toBe(true);
    const forced = mergeMcpServersEntry(raw, "/c.json", { force: true }).merged;
    const servers = forced.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(["other", NEW]);
  });

  it("json, root-level servers map: same rule", () => {
    const raw = { [OLD]: { command: OLD } };
    expect(mergeMcpServersEntry(raw, "/c.json", {}, "").alreadyExists).toBe(true);
    const forced = mergeMcpServersEntry(raw, "/c.json", { force: true }, "").merged;
    expect(Object.keys(forced)).toEqual([NEW]);
  });

  it("jsonc: counts the old entry as existing, and --force replaces it", () => {
    const text = `{\n  // keep me\n  "mcpServers": { "${OLD}": { "command": "${OLD}" }, "other": {} }\n}\n`;
    expect(mergeMcpServersEntryJsonc(text, entry).alreadyExists).toBe(true);
    const forced = mergeMcpServersEntryJsonc(text, entry, { force: true }).text;
    expect(forced).toContain("// keep me");
    expect(Object.keys(parse(forced).mcpServers).sort()).toEqual(["other", NEW]);
  });

  it("yaml: counts the old entry as existing, and --force replaces it", () => {
    const text = `mcpServers:\n  ${OLD}:\n    command: ${OLD}\n  other:\n    command: x\n`;
    expect(mergeMcpServersEntryYaml(text, entry).alreadyExists).toBe(true);
    const forced = mergeMcpServersEntryYaml(text, entry, { force: true }).text;
    expect(Object.keys(YAML.parse(forced).mcpServers).sort()).toEqual(["other", NEW]);
  });
});
