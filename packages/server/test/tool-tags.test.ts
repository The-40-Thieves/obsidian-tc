// The tool-tag vocabulary (mcp/tool-tags.ts): derivation from metadata a tool already declares, the
// registration guard for hand-declared tags, and the facts the derivation must reproduce on the
// real registry. The CI audit over the assembled registry is check-tool-tags.test.ts.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { TOOL_DOMAINS, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { VERDICT_TOOL_TAG } from "../src/mcp/registry/types";
import {
  deriveToolTags,
  effectiveToolTags,
  TOOL_TAG_VOCABULARY,
  TOOL_TAGS,
} from "../src/mcp/tool-tags";

function def(over: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: "fixture",
    inputSchema: z.object({}).strict(),
    requiredScopes: [],
    handler: () => ({}),
    ...over,
  } as unknown as ToolDefinition;
}

function tagsOf(r: ToolRegistry, name: string): string[] | undefined {
  return r.list().find((t) => t.name === name)?.tags;
}

describe("vocabulary", () => {
  it("has a derived domain:* tag for every facade domain, and keeps the verdict tag dispatch reads", () => {
    for (const d of TOOL_DOMAINS)
      expect(TOOL_TAG_VOCABULARY[`domain:${d}`]?.source).toBe("derived");
    expect(TOOL_TAGS.has(VERDICT_TOOL_TAG)).toBe(true);
  });

  it("documents every tag, and splits derived from declared", () => {
    for (const [tag, spec] of Object.entries(TOOL_TAG_VOCABULARY)) {
      expect(spec.description.length, tag).toBeGreaterThan(10);
      expect(["derived", "declared", "both"]).toContain(spec.source);
    }
    expect(TOOL_TAG_VOCABULARY["external-network"]?.source).toBe("declared");
    expect(TOOL_TAG_VOCABULARY["plugin-bridge"]?.source).toBe("both");
    expect(TOOL_TAG_VOCABULARY.destructive?.source).toBe("derived");
  });
});

describe("deriveToolTags", () => {
  it("a tool with no scopes is read-only", () => {
    expect(deriveToolTags(def({ name: "t" }))).toEqual(["read-only"]);
  });

  it("read scope + domain", () => {
    expect(
      deriveToolTags(def({ name: "t", requiredScopes: ["read:notes"], domain: "notes" })),
    ).toEqual(["read-only", "domain:notes"]);
  });

  it("a write scope writes; destructive adds destructive + hitl", () => {
    expect(deriveToolTags(def({ name: "t", requiredScopes: ["write:notes"] }))).toEqual(["writes"]);
    const tags = deriveToolTags(
      def({ name: "t", requiredScopes: ["delete:notes"], destructive: true }),
    );
    expect(tags).toEqual(["writes", "destructive", "hitl"]);
  });

  it("conditionally destructive advertises destructive but is hitl-gated only through its own signal", () => {
    const tags = deriveToolTags(
      def({ name: "t", requiredScopes: ["write:notes"], conditionallyDestructive: true }),
    );
    expect(tags).toContain("destructive");
    expect(tags).toContain("hitl");
  });

  it("a bulk scope derives bulk and hitl (the bulk family is a HITL floor)", () => {
    const tags = deriveToolTags(def({ name: "t", requiredScopes: ["write:notes", "bulk:notes"] }));
    expect(tags).toEqual(["writes", "hitl", "bulk"]);
  });

  it("an admin scope derives admin without writes (admin is not a mutating family)", () => {
    expect(deriveToolTags(def({ name: "t", requiredScopes: ["admin:acl"] }))).toEqual([
      "read-only",
      "admin",
    ]);
  });

  it("a scope that names a companion plugin derives plugin-bridge", () => {
    expect(
      deriveToolTags(def({ name: "t", requiredScopes: ["read:dataview"], domain: "automation" })),
    ).toEqual(["read-only", "plugin-bridge", "domain:automation"]);
  });
});

describe("registration guard", () => {
  it("registers a bare fixture with its derived tags, never an empty set", () => {
    const r = new ToolRegistry();
    r.register(def({ name: "bare" }));
    expect(tagsOf(r, "bare")).toEqual(["read-only"]);
  });

  it("stores derived tags first, then the declared remainder, and does not mutate the definition", () => {
    const d = def({
      name: "t",
      requiredScopes: ["read:notes"],
      tags: ["external-network", "search"],
    });
    const r = new ToolRegistry();
    r.register(d);
    expect(tagsOf(r, "t")).toEqual(["read-only", "external-network", "search"]);
    expect(d.tags).toEqual(["external-network", "search"]);
  });

  it("the same definition registers into two registries", () => {
    const d = def({ name: "t", tags: ["graph"] });
    new ToolRegistry().register(d);
    expect(() => new ToolRegistry().register(d)).not.toThrow();
  });

  it("throws on a tag outside the vocabulary, naming the tool, the tag and the vocabulary", () => {
    const r = new ToolRegistry();
    expect(() => r.register(def({ name: "typo", tags: ["destrutive"] }))).toThrow(
      /tool typo declares unknown tag "destrutive".*known: .*destructive/,
    );
  });

  it("throws on a derived-only tag written by hand", () => {
    expect(() => new ToolRegistry().register(def({ name: "t", tags: ["destructive"] }))).toThrow(
      /declares tag "destructive", which is computed/,
    );
    expect(() => new ToolRegistry().register(def({ name: "t", tags: ["domain:notes"] }))).toThrow(
      /which is computed/,
    );
  });

  it("throws on a both-source tag the derivation already makes, allows it otherwise", () => {
    expect(() =>
      new ToolRegistry().register(
        def({ name: "t", requiredScopes: ["read:dataview"], tags: ["plugin-bridge"] }),
      ),
    ).toThrow(/declares tag "plugin-bridge", which is already derived/);
    const r = new ToolRegistry();
    r.register(def({ name: "t", requiredScopes: ["read:notes"], tags: ["plugin-bridge"] }));
    expect(tagsOf(r, "t")).toEqual(["read-only", "plugin-bridge"]);
  });

  it("a duplicate declaration is collapsed, not an error", () => {
    expect(effectiveToolTags(def({ name: "t", tags: ["graph", "graph"] }))).toEqual([
      "read-only",
      "graph",
    ]);
  });
});

describe("derivation reproduces the wire annotations on the real registry", () => {
  const tools = buildFullRegistry().list();

  it("read-only / destructive agree with describe_capability's annotations for all tools", async () => {
    const { describeCapability } = await import("../src/mcp/facade");
    for (const t of tools) {
      const a = (
        describeCapability(t) as { annotations: { read_only: boolean; destructive: boolean } }
      ).annotations;
      expect(t.tags?.includes("read-only"), `${t.name} read-only`).toBe(a.read_only);
      expect(t.tags?.includes("writes"), `${t.name} writes`).toBe(!a.read_only);
      expect(t.tags?.includes("destructive"), `${t.name} destructive`).toBe(a.destructive);
    }
  });

  it("describe_capability returns the tags", async () => {
    const { describeCapability } = await import("../src/mcp/facade");
    const t = tools.find((x) => x.name === "delete_note");
    if (!t) throw new Error("delete_note missing");
    expect(describeCapability(t).tags).toEqual(["writes", "destructive", "hitl", "domain:notes"]);
  });

  it("hand-written tags that pre-date the vocabulary are preserved on the tools that carried them", () => {
    const tags = (n: string) => tools.find((t) => t.name === n)?.tags ?? [];
    expect(tags("work_result")).toEqual(expect.arrayContaining(["experiential", VERDICT_TOOL_TAG]));
    expect(tags("graph_centrality")).toEqual(expect.arrayContaining(["links", "graph"]));
  });
});
