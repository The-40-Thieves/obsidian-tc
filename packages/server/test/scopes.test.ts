import { describe, it, expect } from "vitest";
import { grantsScope, grantsAll, scopeRequiresHitl } from "@obsidian-tc/shared";

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
