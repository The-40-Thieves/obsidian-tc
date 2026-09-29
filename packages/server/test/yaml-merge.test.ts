// PR C follow-up (Continue, Goose): pure unit tests for cli/setup/yaml-merge.ts — no filesystem.
// See test/setup-install-client-e2e.test.ts for the I/O glue (Continue/Goose's own `yaml-merge`
// branch in `runInstallClient`).

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { mergeMcpServersEntryYaml } from "../src/cli/setup/yaml-merge";

describe("mergeMcpServersEntryYaml — nested serversPath (Goose's extensions)", () => {
  it("creates the key from scratch when no existing file", () => {
    const { alreadyExists, text } = mergeMcpServersEntryYaml(
      undefined,
      { type: "stdio", cmd: "obsidian-tc" },
      {},
      ["extensions"],
    );
    expect(alreadyExists).toBe(false);
    expect(parseYaml(text)).toEqual({
      extensions: { "obsidian-tc": { type: "stdio", cmd: "obsidian-tc" } },
    });
  });

  it("PRESERVES a comment and every other extension already present", () => {
    const existing = [
      "# my goose config",
      "extensions:",
      "  fs: # filesystem ext",
      "    type: stdio",
      "    cmd: npx",
      "other_key: value",
      "",
    ].join("\n");
    const { alreadyExists, text } = mergeMcpServersEntryYaml(
      existing,
      { type: "stdio", cmd: "obsidian-tc" },
      {},
      ["extensions"],
    );
    expect(alreadyExists).toBe(false);
    expect(text).toContain("# my goose config");
    expect(text).toContain("filesystem ext");
    const parsed = parseYaml(text);
    expect(parsed.extensions.fs).toEqual({ type: "stdio", cmd: "npx" });
    expect(parsed.extensions["obsidian-tc"]).toEqual({ type: "stdio", cmd: "obsidian-tc" });
    expect(parsed.other_key).toBe("value");
  });

  it("refuses a duplicate obsidian-tc entry without force — text is unchanged", () => {
    const existing = "extensions:\n  obsidian-tc:\n    cmd: old\n";
    const { alreadyExists, text } = mergeMcpServersEntryYaml(existing, { cmd: "new" }, {}, [
      "extensions",
    ]);
    expect(alreadyExists).toBe(true);
    expect(text).toBe(existing);
  });

  it("overwrites a duplicate obsidian-tc entry with force", () => {
    const existing = "# keep me\nextensions:\n  obsidian-tc:\n    cmd: old\n";
    const { alreadyExists, text } = mergeMcpServersEntryYaml(
      existing,
      { cmd: "new" },
      { force: true },
      ["extensions"],
    );
    expect(alreadyExists).toBe(false);
    expect(text).toContain("# keep me");
    expect(parseYaml(text).extensions["obsidian-tc"]).toEqual({ cmd: "new" });
  });

  it("refuses (never silently replaces) a path segment that is not a mapping", () => {
    const existing = "extensions: notamap\n";
    expect(() => mergeMcpServersEntryYaml(existing, { cmd: "x" }, {}, ["extensions"])).toThrow(
      /extensions.*not a YAML mapping/,
    );
  });

  it("refuses malformed YAML rather than silently overwriting it", () => {
    const existing = "extensions:\n  - not: valid: yaml: here:\n";
    expect(() => mergeMcpServersEntryYaml(existing, { cmd: "x" }, {}, ["extensions"])).toThrow(
      /not valid YAML/,
    );
  });
});

describe("mergeMcpServersEntryYaml — empty serversPath (Continue's per-server file)", () => {
  it("writes the whole entry as a fresh document when the file does not exist", () => {
    const { alreadyExists, text } = mergeMcpServersEntryYaml(
      undefined,
      {
        name: "obsidian-tc",
        version: "0.0.1",
        schema: "v1",
        mcpServers: [{ name: "obsidian-tc" }],
      },
      {},
      [],
    );
    expect(alreadyExists).toBe(false);
    expect(parseYaml(text)).toEqual({
      name: "obsidian-tc",
      version: "0.0.1",
      schema: "v1",
      mcpServers: [{ name: "obsidian-tc" }],
    });
  });

  it("treats ANY existing non-empty content as already-installed, refusing without force", () => {
    const existing = "name: obsidian-tc\nversion: 0.0.1\n";
    const { alreadyExists, text } = mergeMcpServersEntryYaml(
      existing,
      { name: "obsidian-tc" },
      {},
      [],
    );
    expect(alreadyExists).toBe(true);
    expect(text).toBe(existing);
  });

  it("force overwrites the whole file", () => {
    const existing = "name: stale\n";
    const { alreadyExists, text } = mergeMcpServersEntryYaml(
      existing,
      { name: "obsidian-tc" },
      { force: true },
      [],
    );
    expect(alreadyExists).toBe(false);
    expect(parseYaml(text)).toEqual({ name: "obsidian-tc" });
  });
});
