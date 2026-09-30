// The CI audit over the assembled registry (scripts/docgen/check-tool-tags.ts): clean on the real
// registry, and each failure shape it exists to catch, including the floor and the canaries that
// keep a scan that found nothing from reporting clean.
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { checkToolTags, MIN_TOOLS } from "../scripts/docgen/check-tool-tags";
import type { ToolDefinition } from "../src/mcp/registry";

const real = buildFullRegistry().list();

function withTags(name: string, tags: string[] | undefined): ToolDefinition[] {
  return real.map((t) => (t.name === name ? ({ ...t, tags } as ToolDefinition) : t));
}

describe("check-tool-tags", () => {
  it("is clean on the real registry, which is above the floor", () => {
    expect(real.length).toBeGreaterThanOrEqual(MIN_TOOLS);
    expect(checkToolTags(real)).toEqual([]);
  });

  it("flags a tool that carries no tags", () => {
    expect(checkToolTags(withTags("list_notes", undefined))).toEqual(
      expect.arrayContaining(["tool list_notes has no tags"]),
    );
  });

  it("flags an unknown tag", () => {
    const tags = [...(real.find((t) => t.name === "list_notes")?.tags ?? []), "bogus"];
    expect(checkToolTags(withTags("list_notes", tags))).toContain(
      'tool list_notes carries unknown tag "bogus"',
    );
  });

  it("flags a tool with no access tag or no domain tag", () => {
    const problems = checkToolTags(withTags("list_notes", ["graph"]));
    expect(problems.join("\n")).toMatch(/list_notes must carry exactly one of read-only\/writes/);
    expect(problems.join("\n")).toMatch(/list_notes has no domain:\* tag/);
  });

  it("flags a vocabulary tag no tool carries", () => {
    const stripped = real.map(
      (t) =>
        ({ ...t, tags: (t.tags ?? []).filter((x) => x !== "external-network") }) as ToolDefinition,
    );
    expect(checkToolTags(stripped)).toContain(
      'vocabulary tag "external-network" is carried by no tool',
    );
  });

  it("refuses to report on a registry below the floor", () => {
    const problems = checkToolTags(real.slice(0, 10));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/registry floor/);
  });

  it("flags a missing canary and a canary whose tags disagree", () => {
    const without = real.filter((t) => t.name !== "delete_note");
    expect(checkToolTags(without)).toContain(
      "canary delete_note is not registered — the scan is not armed",
    );
    const problems = checkToolTags(
      real.map((t) =>
        t.name === "delete_note"
          ? ({ ...t, tags: ["writes", "domain:notes"] } as ToolDefinition)
          : t,
      ),
    );
    expect(problems).toContain("canary delete_note lacks expected tag(s) destructive, hitl");
  });
});
