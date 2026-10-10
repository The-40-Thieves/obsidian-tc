// Tool-name hygiene over EVERY advertised surface (flat, triad, domain, essentials, core): at most
// 40 chars, `^[a-z][a-z0-9_]*$`, no generic-vocabulary name that is not allowlisted with a reason,
// and a name shared by two surfaces must be the same tool. See scripts/docgen/check-tool-names.ts
// for the client limits behind each rule.
//
// The live-registry case is the gate; the synthetic cases are what prove the gate can fail. Each
// bad name is one a real client rejects or mangles, so a regression of the checker itself (a
// loosened regex, a skipped surface) turns this file red instead of passing vacuously.

import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import {
  CROSS_SURFACE_ALLOWLIST,
  checkToolNames,
  GENERIC_ALLOWLIST,
  MIN_NAMES_CHECKED,
  NAME_MAX_LENGTH,
} from "../scripts/docgen/check-tool-names";
import { advertisedSurfaces, nameCheckSurfaces } from "../scripts/docgen/tool-surface";

const surfaces = advertisedSurfaces(buildFullRegistry());

/** A clean synthetic baseline big enough to clear the floor, so a case isolates ONE violation. */
const NO_ALLOW = { generic: {}, crossSurface: {} };
const check = (s: Parameters<typeof checkToolNames>[0]) => checkToolNames(s, NO_ALLOW);

function baseline(extra: Array<{ name: string; description?: string }> = []) {
  const flat = Array.from({ length: MIN_NAMES_CHECKED + 5 }, (_, i) => ({
    name: `tool_${i}`,
    description: `d${i}`,
  }));
  return { flat: [...flat, ...extra] };
}

describe("tool-name hygiene: the live surfaces", () => {
  it("every advertised name passes (length, charset, generic names, cross-surface identity)", () => {
    expect(checkToolNames(nameCheckSurfaces(surfaces))).toEqual([]);
  });

  it("existence floor: the check saw every registered tool, the facade tools and the domain tools", () => {
    const names = new Set(Object.values(surfaces).flatMap((s) => s.map((t) => t.name)));
    expect(names.size).toBeGreaterThan(MIN_NAMES_CHECKED);
    for (const n of ["read_note", "find_capability", "describe_capability", "call_capability"])
      expect(names).toContain(n);
    expect(surfaces.domain.map((t) => t.name)).toContain("notes");
    expect(surfaces.essentials.length).toBeGreaterThan(10);
    expect(surfaces.core.length).toBeGreaterThan(50);
  });

  it("essentials and core re-advertise the flat tools verbatim (no description of their own)", () => {
    const flat = new Map(surfaces.flat.map((t) => [t.name, t]));
    for (const subset of [surfaces.essentials, surfaces.core])
      for (const t of subset) expect(t).toBe(flat.get(t.name));
  });

  it("the standard search/fetch pair keeps its exact names, on the allowlist with a reason", () => {
    const names = surfaces.flat.map((t) => t.name);
    expect(names).toContain("search");
    expect(names).toContain("fetch");
    for (const n of ["search", "fetch"]) expect(GENERIC_ALLOWLIST[n]?.length).toBeGreaterThan(40);
    expect(Object.keys(GENERIC_ALLOWLIST).sort()).toEqual(["fetch", "search"]);
    expect(Object.keys(CROSS_SURFACE_ALLOWLIST)).toEqual(["search"]);
  });

  it("the longest advertised name leaves room for the client prefix", () => {
    const longest = Math.max(
      ...Object.values(surfaces).flatMap((s) => s.map((t) => t.name.length)),
    );
    expect(longest).toBeLessThanOrEqual(NAME_MAX_LENGTH);
  });
});

describe("tool-name hygiene: the checker fails on a bad name (red cases)", () => {
  it("is clean on the synthetic baseline", () => {
    expect(check(baseline())).toEqual([]);
  });

  const bad: Array<[string, string, RegExp]> = [
    ["a name over the cap", "a".repeat(NAME_MAX_LENGTH + 1), /chars \(max 40/],
    ["an uppercase letter", "readNote", /does not match/],
    ["a dot (Grok drops it, Meta allows one)", "notes.read_note", /does not match/],
    ["a hyphen", "read-note", /does not match/],
    ["a leading digit", "1read_note", /does not match/],
    ["a leading underscore", "_read_note", /does not match/],
    ["a space", "read note", /does not match/],
    ["a generic name: read", "read", /generic name/],
    ["a generic name: write", "write", /generic name/],
    ["a generic name: list", "list", /generic name/],
    ["a generic name: get", "get", /generic name/],
    ["a generic name: query", "query", /generic name/],
    ["a generic name: run", "run", /generic name/],
    ["a generic name: execute", "execute", /generic name/],
  ];
  for (const [label, name, pattern] of bad) {
    it(`rejects ${label}: ${name.length > 20 ? `${name.slice(0, 12)}... (${name.length})` : name}`, () => {
      const problems = check(baseline([{ name, description: "x" }]));
      expect(problems.some((p) => pattern.test(p))).toBe(true);
    });
  }

  it("rejects a name advertised twice on one surface", () => {
    const problems = check(
      baseline([
        { name: "dup_tool", description: "x" },
        { name: "dup_tool", description: "x" },
      ]),
    );
    expect(problems.some((p) => /advertised twice/.test(p))).toBe(true);
  });

  it("rejects one name that means different tools on two surfaces", () => {
    const problems = check({
      ...baseline([{ name: "clash_tool", description: "the flat one" }]),
      domain: [{ name: "clash_tool", description: "the domain one" }],
    });
    expect(problems.some((p) => /distinct across surfaces/.test(p))).toBe(true);
  });

  it("accepts the same tool on two surfaces (identical advertised text)", () => {
    const shared = { name: "shared_tool", description: "same text" };
    expect(check({ ...baseline([shared]), triad: [shared], essentials: [shared] })).toEqual([]);
  });

  it("rejects an extractor that found too few names (the floor)", () => {
    const problems = check({ flat: [{ name: "read_note", description: "x" }] });
    expect(problems.some((p) => /floor:/.test(p))).toBe(true);
  });

  it("allowlisted names pass, and an allowlist row no advertised tool needs is itself a problem", () => {
    const allow = { generic: { read: "kept on purpose" }, crossSurface: { gone: "stale excuse" } };
    const problems = checkToolNames(baseline([{ name: "read", description: "x" }]), allow);
    expect(problems.some((p) => /generic name/.test(p))).toBe(false);
    expect(problems.some((p) => /cross-surface allowlist entry "gone"/.test(p))).toBe(true);
    const stale = checkToolNames(baseline(), { generic: { read: "kept" }, crossSurface: {} });
    expect(stale.some((p) => /generic allowlist entry "read"/.test(p))).toBe(true);
  });
});
