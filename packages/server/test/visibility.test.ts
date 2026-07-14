import { ToolVisibilityConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { ALLOW_ALL, isDisabled, isListed, visibilityOf } from "../src/mcp/visibility";
import { openMemoryDb } from "./helpers";

// Build a full ToolVisibilityConfig from a partial, exercising the schema defaults so the
// tests run against exactly the shape the loaded config produces.
const cfg = (over: Record<string, unknown>) => ToolVisibilityConfigSchema.parse(over);

const target = (
  name: string,
  over: Partial<{ tags: string[]; requiredScopes: string[] }> = {},
) => ({
  name,
  requiredScopes: over.requiredScopes ?? [],
  ...(over.tags ? { tags: over.tags } : {}),
});

describe("visibilityOf precedence", () => {
  it("defaults to listed when no config is given (ALLOW_ALL)", () => {
    const t = target("read_note");
    expect(visibilityOf(t)).toBe("listed");
    expect(visibilityOf(t, ALLOW_ALL)).toBe("listed");
    expect(isListed(t)).toBe(true);
    expect(isDisabled(t)).toBe(false);
  });

  it("hidden by name de-lists but does not disable", () => {
    const t = target("read_note");
    expect(visibilityOf(t, cfg({ hidden: ["read_note"] }))).toBe("hidden");
    expect(isListed(t, cfg({ hidden: ["read_note"] }))).toBe(false);
    expect(isDisabled(t, cfg({ hidden: ["read_note"] }))).toBe(false);
  });

  it("disabled by name removes the tool from the surface", () => {
    const t = target("delete_note");
    expect(visibilityOf(t, cfg({ disabled: ["delete_note"] }))).toBe("disabled");
    expect(isDisabled(t, cfg({ disabled: ["delete_note"] }))).toBe(true);
  });

  it("disabled outranks hidden for the same tool (disabled > hidden)", () => {
    const t = target("delete_note");
    const both = cfg({ hidden: ["delete_note"], disabled: ["delete_note"] });
    expect(visibilityOf(t, both)).toBe("disabled");
  });
});

describe("visibilityOf tag matching", () => {
  it("hiddenTags hides any tool carrying a matched tag", () => {
    const t = target("search_dql", { tags: ["beta", "search"] });
    expect(visibilityOf(t, cfg({ hiddenTags: ["beta"] }))).toBe("hidden");
  });

  it("disabledTags disables a tool carrying a matched tag", () => {
    const t = target("execute_command", { tags: ["danger"] });
    expect(visibilityOf(t, cfg({ disabledTags: ["danger"] }))).toBe("disabled");
  });

  it("disabledTags outranks a hidden-name match (precedence holds across rule kinds)", () => {
    const t = target("execute_command", { tags: ["danger"] });
    const c = cfg({ hidden: ["execute_command"], disabledTags: ["danger"] });
    expect(visibilityOf(t, c)).toBe("disabled");
  });

  it("a tool with no tags is untouched by tag rules", () => {
    const t = target("read_note");
    expect(visibilityOf(t, cfg({ hiddenTags: ["beta"], disabledTags: ["danger"] }))).toBe("listed");
  });
});

describe("visibilityOf requireReadOnly", () => {
  it("hides a mutating tool, deriving mutation from required scopes", () => {
    const writer = target("write_note", { requiredScopes: ["write:note"] });
    const reader = target("read_note", { requiredScopes: ["read:note"] });
    expect(visibilityOf(writer, cfg({ requireReadOnly: true }))).toBe("hidden");
    expect(visibilityOf(reader, cfg({ requireReadOnly: true }))).toBe("listed");
  });

  it("only hides — a requireReadOnly-hidden tool is not disabled (stays callable)", () => {
    const writer = target("write_note", { requiredScopes: ["write:note"] });
    expect(isDisabled(writer, cfg({ requireReadOnly: true }))).toBe(false);
    expect(isListed(writer, cfg({ requireReadOnly: true }))).toBe(false);
  });
});

describe("visibilityOf allowed allowlist", () => {
  it("lists only allowlisted tools; everything else is hidden", () => {
    const c = cfg({ allowed: ["read_note"] });
    expect(visibilityOf(target("read_note"), c)).toBe("listed");
    expect(visibilityOf(target("write_note"), c)).toBe("hidden");
  });

  it("an empty allowed array hides every tool", () => {
    expect(visibilityOf(target("read_note"), cfg({ allowed: [] }))).toBe("hidden");
  });

  it("an absent allowed array lists every tool", () => {
    expect(cfg({}).allowed).toBeUndefined();
    expect(visibilityOf(target("read_note"), cfg({}))).toBe("listed");
  });
});

describe("ToolVisibilityConfigSchema", () => {
  it("parses an empty block to the ALLOW_ALL defaults", () => {
    expect(ToolVisibilityConfigSchema.parse({})).toEqual({
      hidden: [],
      disabled: [],
      hiddenTags: [],
      disabledTags: [],
      requireReadOnly: false,
    });
  });
});

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function ctx(db: Database, over: Partial<CallerContext> = {}): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db,
    ...over,
  };
}

function registerEcho(reg: ToolRegistry, name: string): void {
  reg.register({
    name,
    description: name,
    inputSchema: z.object({}),
    requiredScopes: [],
    handler: () => ({ name }),
  });
}

describe("registry visibility integration", () => {
  it("listVisible() omits hidden + disabled tools while list() keeps the full set", () => {
    const reg = new ToolRegistry({
      toolVisibility: cfg({ hidden: ["hideme"], disabled: ["killme"] }),
    });
    registerEcho(reg, "keep");
    registerEcho(reg, "hideme");
    registerEcho(reg, "killme");
    expect(
      reg
        .list()
        .map((d) => d.name)
        .sort(),
    ).toEqual(["hideme", "keep", "killme"]);
    expect(reg.listVisible().map((d) => d.name)).toEqual(["keep"]);
  });

  it("dispatch rejects a disabled tool as not_found, but allows it without the disable", async () => {
    const disabledReg = new ToolRegistry({ toolVisibility: cfg({ disabled: ["killme"] }) });
    registerEcho(disabledReg, "killme");
    const denied = await disabledReg.dispatch("killme", {}, ctx(freshDb()));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("not_found");

    // The same registered tool dispatches fine once it is not disabled — proving the
    // guard, not a missing registration, is what rejected it above.
    const openReg = new ToolRegistry();
    registerEcho(openReg, "killme");
    const ok = await openReg.dispatch("killme", {}, ctx(freshDb()));
    expect(ok.ok).toBe(true);
  });

  it("dispatch still runs a merely hidden tool (hidden is not disabled)", async () => {
    const reg = new ToolRegistry({ toolVisibility: cfg({ hidden: ["hideme"] }) });
    registerEcho(reg, "hideme");
    const r = await reg.dispatch("hideme", {}, ctx(freshDb()));
    expect(r.ok).toBe(true);
  });
});

describe("visibilityOf per-caller scopes (THE-250)", () => {
  const writer = target("write_note", { requiredScopes: ["write:notes"] });
  const reader = target("read_note", { requiredScopes: ["read:notes"] });

  it("a full * grant lists everything (non-breaking)", () => {
    const caller = { grantedScopes: new Set(["*"]) };
    expect(visibilityOf(writer, ALLOW_ALL, caller)).toBe("listed");
    expect(visibilityOf(reader, ALLOW_ALL, caller)).toBe("listed");
  });

  it("scope_denied when the caller lacks a required scope", () => {
    const caller = { grantedScopes: new Set(["read:notes"]) };
    expect(visibilityOf(writer, ALLOW_ALL, caller)).toBe("scope_denied");
    expect(isListed(writer, ALLOW_ALL, caller)).toBe(false);
    expect(visibilityOf(reader, ALLOW_ALL, caller)).toBe("listed");
  });

  it("a read-only caller sees no mutating tools, even with the scope", () => {
    const caller = { grantedScopes: new Set(["*"]), readOnly: true };
    expect(visibilityOf(writer, ALLOW_ALL, caller)).toBe("scope_denied");
    expect(visibilityOf(reader, ALLOW_ALL, caller)).toBe("listed");
  });

  it("precedence: disabled and hidden win over scope_denied", () => {
    const caller = { grantedScopes: new Set(["read:notes"]) }; // would deny the writer
    expect(visibilityOf(writer, cfg({ disabled: ["write_note"] }), caller)).toBe("disabled");
    expect(visibilityOf(writer, cfg({ hidden: ["write_note"] }), caller)).toBe("hidden");
  });

  it("an absent caller skips the scope gate (static layer only)", () => {
    expect(visibilityOf(writer, ALLOW_ALL)).toBe("listed");
  });
});

describe("registry listVisible per-caller (THE-250)", () => {
  const withScope = (reg: ToolRegistry, name: string, scope: string): void => {
    reg.register({
      name,
      description: name,
      inputSchema: z.object({}),
      requiredScopes: [scope],
      handler: () => ({ name }),
    });
  };

  it("drops tools the caller cannot dispatch; a full grant / no caller keeps all", () => {
    const reg = new ToolRegistry();
    withScope(reg, "rd", "read:notes");
    withScope(reg, "wr", "write:notes");
    expect(reg.listVisible({ grantedScopes: new Set(["read:notes"]) }).map((d) => d.name)).toEqual([
      "rd",
    ]);
    expect(
      reg
        .listVisible({ grantedScopes: new Set(["*"]) })
        .map((d) => d.name)
        .sort(),
    ).toEqual(["rd", "wr"]);
    expect(
      reg
        .listVisible()
        .map((d) => d.name)
        .sort(),
    ).toEqual(["rd", "wr"]);
  });
});
