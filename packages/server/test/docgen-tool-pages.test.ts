// docgen per-tool reference pages: one page per registered tool, generated at docs build time from
// the same registry introspection the catalog uses. Pins the param table (required/default/enum/
// nested), the safety sections, and the invariant check that keeps pages and registry in step.
import { describe, expect, it } from "vitest";
import { checkToolPages } from "../scripts/docgen/check-tool-pages";
import { extractTools } from "../scripts/docgen/extract-tools";
import type { ToolDoc } from "../scripts/docgen/model";
import { renderToolPage, toolPageSlug } from "../scripts/docgen/render-tool-pages";
import { renderTools } from "../scripts/docgen/render-tools";

const tools = extractTools();
const byName = new Map(tools.map((t) => [t.name, t]));
const page = (name: string): string => {
  const t = byName.get(name);
  if (!t) throw new Error(`no such tool ${name}`);
  return renderToolPage(t, tools);
};

/** The table row for a parameter path, or "" when the page has none. */
const row = (md: string, param: string): string =>
  md.split("\n").find((l) => l.startsWith(`| \`${param}\` |`)) ?? "";

describe("renderToolPage: params from the live registry (write_note)", () => {
  const md = page("write_note");

  it("renders frontmatter, name, domain and scopes", () => {
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain('title: "write_note"');
    expect(md).toContain("editUrl: false");
    expect(md).toMatch(/\*\*Domain\*\*.*notes/);
    expect(md).toContain("`write:notes`");
  });

  it("marks required params and leaves optional ones unmarked", () => {
    expect(row(md, "path")).toMatch(/\| yes \|/);
    expect(row(md, "content")).toMatch(/\| yes \|/);
    expect(row(md, "prev_hash")).not.toMatch(/\| yes \|/);
  });

  it("renders enums with their values and the zod default", () => {
    const mode = row(md, "mode");
    expect(mode).toContain("`enum`");
    expect(mode).toContain('One of: `"create"`, `"overwrite"`, `"upsert"`');
    expect(mode).toContain('| `"create"` |');
  });

  it("flattens nested objects to dotted paths with their own defaults", () => {
    const opt = row(md, "options");
    expect(opt).toContain("`object`");
    expect(opt).toContain("`{}`");
    const nested = row(md, "options.create_dirs");
    expect(nested).toContain("`boolean`");
    expect(nested).toContain("`true`");
  });

  it("documents HITL, related tools and the way back to the catalog", () => {
    expect(md).toContain("## Confirmation");
    expect(md).toContain("[`read_note`](/tools/reference/read_note/)");
    expect(md).toContain("(/tools/tool-catalog/)");
  });

  it("summarises the output schema", () => {
    expect(md).toContain("## Output");
  });
});

describe("renderToolPage: unions, arrays and records", () => {
  const md = page("read_note");

  it("merges union object variants into dotted rows with the discriminator literals", () => {
    const type = row(md, "anchor.type");
    expect(type).toContain('"heading"');
    expect(type).toContain('"block"');
    expect(row(md, "anchor.heading")).not.toBe("");
  });
});

describe("renderToolPage: synthetic fixture", () => {
  const fixture: ToolDoc = {
    name: "fixture_tool",
    description: "Does a thing with <angle> brackets | and a pipe.",
    requiredScopes: ["read:notes"],
    tags: [],
    destructive: false,
    domain: "notes",
    annotations: { readOnly: true, destructive: false, idempotent: false },
    inputSchema: {
      type: "object",
      properties: {
        must: { type: "string", description: "needed" },
        level: { type: "string", enum: ["low", "high"], default: "low" },
        nested: {
          type: "object",
          properties: {
            deep: {
              type: "array",
              items: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
            },
          },
          required: ["deep"],
        },
      },
      required: ["must"],
    },
  };
  const md = renderToolPage(fixture, [fixture]);

  it("renders required, default, enum and array-of-object paths", () => {
    expect(row(md, "must")).toMatch(/\| yes \|/);
    expect(row(md, "level")).toContain('`"low"`');
    expect(row(md, "nested.deep")).toContain("`object[]`");
    expect(row(md, "nested.deep[].id")).toContain("`integer`");
  });

  it("marks a required child of an optional parent as conditional, not plain required", () => {
    expect(row(md, "nested.deep")).toContain("with parent");
  });

  it("escapes raw angle brackets and pipes in prose", () => {
    const body = md.slice(md.indexOf("---\n", 4));
    expect(body).not.toContain("<angle>");
    expect(body).toContain("&lt;angle>");
  });

  it("says so when a tool advertises no output schema", () => {
    expect(md).toContain("does not advertise an output schema");
  });
});

describe("toolPageSlug", () => {
  it("accepts snake_case names and rejects names that would not make a safe file/URL", () => {
    expect(toolPageSlug("read_note")).toBe("read_note");
    expect(() => toolPageSlug("a/b")).toThrow(/unsafe/);
    expect(() => toolPageSlug("../x")).toThrow(/unsafe/);
  });
});

describe("renderTools links each row to its page", () => {
  it("links with the given base and stays plain without one", () => {
    const linked = renderTools(tools, "/tools/reference/");
    expect(linked).toContain("| [`read_note`](/tools/reference/read_note/) |");
    expect(renderTools(tools)).toContain("| `read_note` |");
  });
});

describe("checkToolPages (the invariant)", () => {
  const files = tools.map((t) => `${toolPageSlug(t.name)}.md`);
  const catalog = renderTools(tools, "/tools/reference/");
  const contents = new Map(
    tools.map((t) => [`${toolPageSlug(t.name)}.md`, renderToolPage(t, tools)]),
  );
  const ok = { tools, files, contents, catalog };

  it("passes when pages, registry and catalog agree", () => {
    expect(checkToolPages(ok)).toEqual([]);
  });

  it("FAILS when a tool is added to the registry without its page", () => {
    const extra: ToolDoc = { ...tools[0], name: "brand_new_tool" };
    const problems = checkToolPages({ ...ok, tools: [...tools, extra] });
    expect(problems.join("\n")).toMatch(/page count \d+ != registry tool count \d+/);
    expect(problems.join("\n")).toContain("brand_new_tool.md");
  });

  it("FAILS on an orphan page for a tool no longer registered", () => {
    const problems = checkToolPages({ ...ok, files: [...files, "removed_tool.md"] });
    expect(problems.join("\n")).toContain("removed_tool.md");
  });

  it("FAILS when a catalog row links to a page that does not exist", () => {
    const gone = files.filter((f) => f !== "read_note.md");
    const problems = checkToolPages({ ...ok, files: gone });
    expect(problems.join("\n")).toContain("read_note");
  });

  it("FAILS when a catalog row carries no link", () => {
    const problems = checkToolPages({ ...ok, catalog: renderTools(tools) });
    expect(problems.join("\n")).toMatch(/no link/);
  });

  it("FAILS when a page is stale against a fresh render", () => {
    const stale = new Map(contents);
    stale.set("read_note.md", "old");
    expect(checkToolPages({ ...ok, contents: stale }).join("\n")).toContain("stale");
  });

  it("refuses a vacuous pass: an empty registry or an empty catalog is a broken scan", () => {
    expect(
      checkToolPages({ tools: [], files: [], contents: new Map(), catalog }).join("\n"),
    ).toMatch(/floor/);
    expect(checkToolPages({ ...ok, catalog: "| Tool |\n|---|" }).join("\n")).toMatch(
      /no catalog rows/,
    );
  });

  it("FAILS when built dist has a different page count", () => {
    const problems = checkToolPages({
      ...ok,
      dist: files.slice(1).map((f) => f.replace(/\.md$/, "")),
    });
    expect(problems.join("\n")).toMatch(/built site has \d+ tool pages, registry has \d+/);
  });
});
