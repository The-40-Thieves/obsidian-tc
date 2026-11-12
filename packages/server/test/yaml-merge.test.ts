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
      { type: "stdio", cmd: "reliquary-tc" },
      {},
      ["extensions"],
    );
    expect(alreadyExists).toBe(false);
    expect(parseYaml(text)).toEqual({
      extensions: { "reliquary-tc": { type: "stdio", cmd: "reliquary-tc" } },
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
      { type: "stdio", cmd: "reliquary-tc" },
      {},
      ["extensions"],
    );
    expect(alreadyExists).toBe(false);
    expect(text).toContain("# my goose config");
    expect(text).toContain("filesystem ext");
    const parsed = parseYaml(text);
    expect(parsed.extensions.fs).toEqual({ type: "stdio", cmd: "npx" });
    expect(parsed.extensions["reliquary-tc"]).toEqual({ type: "stdio", cmd: "reliquary-tc" });
    expect(parsed.other_key).toBe("value");
  });

  it("refuses a duplicate reliquary-tc entry without force — text is unchanged", () => {
    const existing = "extensions:\n  reliquary-tc:\n    cmd: old\n";
    const { alreadyExists, text } = mergeMcpServersEntryYaml(existing, { cmd: "new" }, {}, [
      "extensions",
    ]);
    expect(alreadyExists).toBe(true);
    expect(text).toBe(existing);
  });

  it("overwrites a duplicate reliquary-tc entry with force", () => {
    const existing = "# keep me\nextensions:\n  reliquary-tc:\n    cmd: old\n";
    const { alreadyExists, text } = mergeMcpServersEntryYaml(
      existing,
      { cmd: "new" },
      { force: true },
      ["extensions"],
    );
    expect(alreadyExists).toBe(false);
    expect(text).toContain("# keep me");
    expect(parseYaml(text).extensions["reliquary-tc"]).toEqual({ cmd: "new" });
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
        name: "reliquary-tc",
        version: "0.0.1",
        schema: "v1",
        mcpServers: [{ name: "reliquary-tc" }],
      },
      {},
      [],
    );
    expect(alreadyExists).toBe(false);
    expect(parseYaml(text)).toEqual({
      name: "reliquary-tc",
      version: "0.0.1",
      schema: "v1",
      mcpServers: [{ name: "reliquary-tc" }],
    });
  });

  it("treats ANY existing non-empty content as already-installed, refusing without force", () => {
    const existing = "name: reliquary-tc\nversion: 0.0.1\n";
    const { alreadyExists, text } = mergeMcpServersEntryYaml(
      existing,
      { name: "reliquary-tc" },
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
      { name: "reliquary-tc" },
      { force: true },
      [],
    );
    expect(alreadyExists).toBe(false);
    expect(parseYaml(text)).toEqual({ name: "reliquary-tc" });
  });
});
