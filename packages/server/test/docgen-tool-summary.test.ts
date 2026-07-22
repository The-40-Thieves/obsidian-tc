// THE-473/THE-469: README and ARCHITECTURE need a GENERATED capability summary, not the full
// catalog. The full tool reference is ~30KB / 165 lines — injecting it into a 260-line README
// would bury the narrative it is meant to support.
//
// THE-469's root cause was discoverability: README mentions none of the write tools (grep count 0),
// so two external reviews concluded the write surface was "thin" and had "no atomic heading edits"
// when patch_note has done heading- and block-anchored edits since THE-198. The summary must
// therefore make the WRITE surface visible specifically, not just print a total.
import { describe, expect, it } from "vitest";
import type { ToolDoc } from "../scripts/docgen/model";
import { renderToolSummary } from "../scripts/docgen/render-tools";

const tool = (name: string, scopes: string[], description = "x".repeat(30)): ToolDoc => ({
  name,
  description,
  requiredScopes: scopes,
  tags: [],
  destructive: false,
  inputSchema: {},
});

describe("renderToolSummary (THE-473)", () => {
  it("reports the real total so the summary cannot silently drift from the surface", () => {
    const md = renderToolSummary([
      tool("read_note", ["read:notes"]),
      tool("write_note", ["write:notes"]),
      tool("search_vault", ["read:notes"]),
    ]);

    expect(md).toMatch(/\b3\b/);
  });

  it("names the write/edit tools — the capability THE-469 found invisible in README", () => {
    const md = renderToolSummary([
      tool("read_note", ["read:notes"]),
      tool("patch_note", ["write:notes"]),
      tool("write_note", ["write:notes"]),
      tool("append_note", ["write:notes"]),
    ]);

    for (const name of ["patch_note", "write_note", "append_note"]) {
      expect(md).toContain(name);
    }
  });

  it("groups by scope family rather than emitting one row per tool", () => {
    const many = Array.from({ length: 40 }, (_, i) => tool(`read_thing_${i}`, ["read:notes"]));

    const md = renderToolSummary(many);

    // A summary, not a catalog: 40 read tools must not produce 40 rows.
    expect(md.split("\n").length).toBeLessThan(15);
  });

  // REGRESSION GUARD. The first implementation showed only the 6 alphabetically-first names per
  // family. Against the real surface (41 write tools) that silently omitted patch_note and
  // write_note — the exact tools THE-469 says README makes invisible. The unit fixture was small
  // enough that truncation never fired, so the test passed while the generated README failed the
  // ticket. Every name must appear, at realistic scale.
  it("names EVERY tool even in a large family (no alphabetical truncation)", () => {
    const writes = [
      ...Array.from({ length: 30 }, (_, i) => tool(`aaa_early_${i}`, ["write:notes"])),
      tool("patch_note", ["write:notes"]),
      tool("write_note", ["write:notes"]),
      tool("update_frontmatter", ["write:notes"]),
    ];

    const md = renderToolSummary(writes);

    for (const name of ["patch_note", "write_note", "update_frontmatter"]) {
      expect(md).toContain(name);
    }
  });

  it("separates write from read so the write surface is countable at a glance", () => {
    const md = renderToolSummary([
      tool("read_note", ["read:notes"]),
      tool("write_note", ["write:notes"]),
      tool("delete_note", ["delete:notes"]),
      tool("run_command", ["execute:command"]),
    ]);

    expect(md).toMatch(/read/i);
    expect(md).toMatch(/write/i);
    expect(md).toMatch(/delete/i);
    expect(md).toMatch(/execute/i);
  });

  it("is deterministic — the drift gate compares byte-for-byte", () => {
    const tools = [
      tool("write_note", ["write:notes"]),
      tool("read_note", ["read:notes"]),
      tool("append_note", ["write:notes"]),
    ];

    expect(renderToolSummary(tools)).toBe(renderToolSummary([...tools].reverse()));
  });

  it("emits no trailing whitespace (the injector round-trips exact bytes)", () => {
    const md = renderToolSummary([tool("read_note", ["read:notes"])]);

    for (const line of md.split("\n")) expect(line).toBe(line.trimEnd());
  });
});
