import {
  grantsAll,
  grantsScope,
  scopeClassOf,
  scopeRequiresHitl,
} from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";

describe("scope matching", () => {
  it("honors exact, family-wildcard and global-wildcard grants", () => {
    expect(grantsScope(["read:notes"], "read:notes")).toBe(true);
    expect(grantsScope(["read:*"], "read:notes")).toBe(true);
    expect(grantsScope(["*"], "delete:notes")).toBe(true);
    expect(grantsScope(["read:*"], "write:notes")).toBe(false);
    expect(grantsScope(["read:meta"], "read:notes")).toBe(false);
  });
  it("ANDs across all required scopes", () => {
    expect(grantsAll(["read:notes", "write:notes"], ["read:notes", "write:notes"])).toBe(true);
    expect(grantsAll(["read:notes"], ["read:notes", "write:notes"])).toBe(false);
    expect(grantsAll(["*"], ["read:notes", "delete:notes"])).toBe(true);
  });
  it("flags HITL floor scopes", () => {
    expect(scopeRequiresHitl("execute:dataview")).toBe(true);
    expect(scopeRequiresHitl("bulk:create_notes")).toBe(true);
    expect(scopeRequiresHitl("write:templater")).toBe(true);
    expect(scopeRequiresHitl("admin:auth")).toBe(true);
    expect(scopeRequiresHitl("read:notes")).toBe(false);
    expect(scopeRequiresHitl("write:notes")).toBe(false);
  });
});

describe("scopeClassOf precedence (THE-210 / THE-212)", () => {
  it("maps a delete-only tool to the delete class", () => {
    expect(scopeClassOf(["delete:notes"])).toBe("delete");
  });
  it("ranks bulk and execute above delete", () => {
    expect(scopeClassOf(["delete:notes", "bulk:notes"])).toBe("bulk");
    expect(scopeClassOf(["execute:dataview", "delete:notes"])).toBe("execute");
  });
  it("ranks admin above delete", () => {
    expect(scopeClassOf(["admin:server", "delete:notes"])).toBe("admin");
  });
  it("ranks delete above write and read", () => {
    expect(scopeClassOf(["write:notes", "delete:notes"])).toBe("delete");
    expect(scopeClassOf(["read:notes", "delete:notes"])).toBe("delete");
  });
  it("returns unknown for an empty scope list", () => {
    expect(scopeClassOf([])).toBe("unknown");
  });
});
