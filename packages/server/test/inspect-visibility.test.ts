// THE-645 item 2 — inspect_visibility.
//
// The tool's whole job is telling an operator WHICH rule hid a tool, so these tests assert the
// reason, not just the verdict: a test that only checked `visibility === "hidden"` would pass
// against a handler that returned a constant reason string.
//
// The scope gate is not tested here — it is generic dispatch behaviour covered by the registry
// suite. What IS tested here is the branch that makes the scope gate load-bearing: `unregistered`
// being reported distinctly from `hidden`.
import type { ToolVisibilityConfig } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import type { CallerContext, ToolDefinition } from "../src/mcp/registry";
import { buildAdminTools } from "../src/tools/m6/admin-tools";
import type { M6Deps, ToolSurfaceEntry } from "../src/tools/m6/shared";

const SURFACE: readonly ToolSurfaceEntry[] = [
  { name: "read_note", domain: "notes", tags: ["safe"], requiredScopes: ["read:notes"] },
  { name: "patch_note", domain: "notes", tags: ["safe"], requiredScopes: ["write:notes"] },
  { name: "secret_tool", domain: "admin", tags: ["internal"], requiredScopes: ["admin:vault"] },
  { name: "banned_tool", domain: "admin", tags: [], requiredScopes: ["admin:vault"] },
];

const ALLOW_ALL: ToolVisibilityConfig = {
  hidden: [],
  disabled: [],
  hiddenTags: [],
  disabledTags: [],
  requireReadOnly: false,
};

interface Entry {
  name: string;
  visibility: string;
  reason: string;
  matched_tag: string | null;
  missing_scopes: string[];
}
interface Out {
  evaluated_for: { scopes: string[]; read_only: boolean } | null;
  summary: Record<string, number>;
  tools: Entry[];
}

function tool(deps: Partial<M6Deps>): ToolDefinition {
  const full = { ...(deps as M6Deps) };
  const def = buildAdminTools(full).find((t) => t.name === "inspect_visibility");
  if (!def) throw new Error("inspect_visibility not registered by buildAdminTools");
  return def;
}

async function run(
  input: Record<string, unknown>,
  config: ToolVisibilityConfig = ALLOW_ALL,
  surface: readonly ToolSurfaceEntry[] = SURFACE,
): Promise<Out> {
  const def = tool({ toolSurface: () => ({ config, tools: surface }) });
  return (await def.handler(input, {} as CallerContext)) as Out;
}

describe("THE-645 item 2 — inspect_visibility", () => {
  it("is registered on the admin surface under admin:acl", () => {
    const def = tool({ toolSurface: () => ({ config: ALLOW_ALL, tools: SURFACE }) });
    expect(def.domain).toBe("admin");
    expect(def.requiredScopes).toEqual(["admin:acl"]);
    // Not mutating and not destructive: it must not acquire a HITL floor or a pathAcl obligation.
    expect(def.destructive ?? false).toBe(false);
  });

  it("lists everything under an empty config, with no caller", async () => {
    const out = await run({});
    expect(out.summary).toEqual({ listed: 4, hidden: 0, disabled: 0, scope_denied: 0 });
    expect(out.evaluated_for).toBeNull();
    expect(out.tools.every((t) => t.reason === "listed")).toBe(true);
  });

  it("reports WHICH rule hid a tool, per rule", async () => {
    const byName = await run({ tool: "secret_tool" }, { ...ALLOW_ALL, hidden: ["secret_tool"] });
    expect(byName.tools[0]).toMatchObject({ visibility: "hidden", reason: "hidden_name" });

    const byTag = await run({ tool: "secret_tool" }, { ...ALLOW_ALL, hiddenTags: ["internal"] });
    expect(byTag.tools[0]).toMatchObject({
      visibility: "hidden",
      reason: "hidden_tag",
      matched_tag: "internal",
    });

    const byAllow = await run({ tool: "secret_tool" }, { ...ALLOW_ALL, allowed: ["read_note"] });
    expect(byAllow.tools[0]).toMatchObject({
      visibility: "hidden",
      reason: "hidden_not_allowlisted",
    });

    const byReadOnly = await run({ tool: "patch_note" }, { ...ALLOW_ALL, requireReadOnly: true });
    expect(byReadOnly.tools[0]).toMatchObject({
      visibility: "hidden",
      reason: "hidden_require_read_only",
    });

    const disabled = await run(
      { tool: "banned_tool" },
      { ...ALLOW_ALL, disabled: ["banned_tool"] },
    );
    expect(disabled.tools[0]).toMatchObject({ visibility: "disabled", reason: "disabled_name" });
  });

  it("names the scopes a hypothetical caller is missing — the debugging question", async () => {
    const out = await run({ tool: "secret_tool", scopes: ["read:notes"] });
    expect(out.tools[0]).toMatchObject({
      visibility: "scope_denied",
      reason: "scope_denied_missing_scope",
      missing_scopes: ["admin:vault"],
    });
    expect(out.evaluated_for).toEqual({ scopes: ["read:notes"], read_only: false });
  });

  it("distinguishes read-only denial from a missing grant", async () => {
    const out = await run({ tool: "patch_note", scopes: ["write:notes"], read_only: true });
    expect(out.tools[0]).toMatchObject({
      visibility: "scope_denied",
      reason: "scope_denied_read_only",
      missing_scopes: [],
    });
  });

  it("reports an unknown tool as unregistered — the branch the admin scope exists for", async () => {
    const out = await run({ tool: "no_such_tool" });
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0]).toMatchObject({
      name: "no_such_tool",
      visibility: "unregistered",
      reason: "not_registered",
    });
  });

  it("hidden and unregistered are DIFFERENT answers for the same question", async () => {
    const hidden = await run({ tool: "secret_tool" }, { ...ALLOW_ALL, hidden: ["secret_tool"] });
    const missing = await run({ tool: "secret_tool" }, ALLOW_ALL, []);
    expect(hidden.tools[0]?.visibility).toBe("hidden");
    expect(missing.tools[0]?.visibility).toBe("unregistered");
  });

  it("summary covers the whole surface even when the list is filtered", async () => {
    const out = await run({ visibility: "hidden" }, { ...ALLOW_ALL, hidden: ["secret_tool"] });
    expect(out.tools.map((t) => t.name)).toEqual(["secret_tool"]);
    // The filter is a lens on the answer, not a change to it.
    expect(out.summary).toEqual({ listed: 3, hidden: 1, disabled: 0, scope_denied: 0 });
  });

  it("THROWS when the surface is unwired rather than reporting an empty one", () => {
    const def = tool({});
    // A silent `{ tools: [], summary: all-zero }` would read as a clean bill of health for a
    // deployment whose registry was never passed in — the THE-688 `dense: ready` shape.
    expect(() => def.handler({}, {} as CallerContext)).toThrow(/not wired/);
  });
});
