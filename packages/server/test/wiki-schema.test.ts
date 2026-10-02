// SCHEMA.md: parsing is forgiving (a malformed file is a warning, never an error), checking a page
// against it returns problems for the caller to fix, and `vaults[].wiki.folder` reaches the registry.
import { VaultConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import type { FolderAcl } from "../src/acl";
import {
  checkFrontmatter,
  loadWikiSchema,
  parseWikiSchema,
} from "../src/tools/m7/knowledge/wiki-schema";
import { VaultRegistry } from "../src/vault/registry";
import { makeTestVault, type TestVault } from "./m1-helpers";

const VALID = `---
types:
  concept:
    description: An idea or term
    required: [type, summary, sources]
    folder: concepts
  person:
    required: [type, summary]
properties:
  type: [concept, person]
  summary:
  sources:
  status: [draft, stable]
---
# Wiki schema

Human-readable notes live here and are never parsed.
`;

describe("parseWikiSchema", () => {
  it("reads types, required fields, subfolders and the property vocabulary", () => {
    const r = parseWikiSchema(VALID, "wiki/SCHEMA.md");
    expect(r.warnings).toEqual([]);
    expect(r.schema?.types).toEqual([
      {
        name: "concept",
        description: "An idea or term",
        required: ["type", "summary", "sources"],
        folder: "concepts",
      },
      { name: "person", required: ["type", "summary"] },
    ]);
    expect(r.schema?.vocabulary).toEqual({
      type: ["concept", "person"],
      summary: null,
      sources: null,
      status: ["draft", "stable"],
    });
  });

  it("accepts a plain list of property names", () => {
    const r = parseWikiSchema("---\nproperties: [type, summary]\n---\n", "S.md");
    expect(r.schema?.vocabulary).toEqual({ type: null, summary: null });
  });

  it("invalid YAML frontmatter is a warning and a null schema, never a throw", () => {
    const r = parseWikiSchema("---\ntypes: [unclosed\n  bad: : :\n---\nbody\n", "wiki/SCHEMA.md");
    expect(r.schema).toBeNull();
    expect(r.found).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("wiki/SCHEMA.md was not read");
  });

  it("a file with no frontmatter declares nothing and says so", () => {
    const r = parseWikiSchema("# Schema\n\nconcept pages need a summary\n", "wiki/SCHEMA.md");
    expect(r.schema).toBeNull();
    expect(r.warnings[0]).toContain("no frontmatter block");
  });

  it("a malformed section is skipped with a warning and the rest is kept", () => {
    const r = parseWikiSchema(
      "---\ntypes: [concept, person]\nproperties:\n  summary:\n  tags: [a, b]\n---\n",
      "S.md",
    );
    expect(r.schema?.types).toEqual([]);
    expect(r.schema?.vocabulary).toEqual({ summary: null, tags: ["a", "b"] });
    expect(r.warnings.join(" ")).toContain("`types` must be a map");
  });

  it("drops a required entry that is not text and keeps the others", () => {
    const r = parseWikiSchema(
      "---\ntypes:\n  concept:\n    required: [summary, {a: 1}, sources]\n---\n",
      "S.md",
    );
    expect(r.schema?.types[0]?.required).toEqual(["summary", "sources"]);
    expect(r.warnings.join(" ")).toContain('type "concept" required');
  });

  it("an empty declaration warns that nothing is enforced", () => {
    const r = parseWikiSchema("---\nowner: me\n---\n", "S.md");
    expect(r.schema).toEqual({ types: [], vocabulary: null });
    expect(r.warnings[0]).toContain("nothing is enforced");
  });
});

describe("checkFrontmatter", () => {
  const schema = parseWikiSchema(VALID, "S.md").schema;

  it("a conforming page has no problems", () => {
    expect(
      checkFrontmatter(schema, {
        type: "concept",
        summary: "x",
        sources: ["[[A]]"],
        status: "draft",
        tags: ["t"],
      }),
    ).toEqual([]);
  });

  it("reports a missing required field, an unknown type, an unknown property and a bad value", () => {
    const codes = (fm: Record<string, unknown>, type?: string) =>
      checkFrontmatter(schema, fm, type).map((p) => `${p.code}:${p.field}`);
    expect(codes({ type: "concept", summary: "x" })).toEqual(["missing_required:sources"]);
    expect(codes({ type: "recipe" })).toContain("unknown_type:type");
    expect(codes({ summary: "x" })).toEqual(["missing_type:type"]);
    expect(codes({ type: "person", summary: "x", Summary: "y" })).toEqual([
      "unknown_property:Summary",
    ]);
    expect(codes({ type: "person", summary: "x", status: "done" })).toEqual(["bad_value:status"]);
  });

  it("names the declared spelling for a near-miss property", () => {
    const [p] = checkFrontmatter(schema, { type: "person", summary: "x", Status: "draft" });
    expect(p?.message).toContain("uses `status`");
  });

  it("an explicit type argument overrides the page's own type property", () => {
    // `person` needs only type + summary, so `concept`'s missing `sources` is not reported.
    expect(checkFrontmatter(schema, { type: "concept", summary: "x" }, "person")).toEqual([]);
  });

  it("no schema, no problems", () => {
    expect(checkFrontmatter(null, { anything: 1 })).toEqual([]);
  });
});

let v: TestVault;
afterEach(() => v?.cleanup());

describe("loadWikiSchema", () => {
  const scope = (t: TestVault, acl?: FolderAcl) => ({
    root: t.root,
    acl: acl ?? t.acl,
    grantedScopes: ["*"],
  });

  it("reads <folder>/SCHEMA.md", () => {
    v = makeTestVault({ files: { "wiki/SCHEMA.md": VALID } });
    const r = loadWikiSchema(scope(v), "wiki");
    expect(r.found).toBe(true);
    expect(r.schema?.types.map((t) => t.name)).toEqual(["concept", "person"]);
  });

  it("a missing SCHEMA.md or no wiki folder is not found, with no warning", () => {
    v = makeTestVault({ files: { "wiki/a.md": "x" } });
    expect(loadWikiSchema(scope(v), "wiki")).toMatchObject({ found: false, schema: null });
    expect(loadWikiSchema(scope(v), undefined)).toMatchObject({ found: false, warnings: [] });
  });

  it("a SCHEMA.md the caller may not read counts as missing", () => {
    v = makeTestVault({
      files: { "wiki/SCHEMA.md": VALID },
      acl: { readPaths: ["other/**"] },
    });
    expect(loadWikiSchema(scope(v), "wiki").found).toBe(false);
  });

  it("a SCHEMA.md that is a directory is not found and does not throw", () => {
    v = makeTestVault({ files: { "wiki/SCHEMA.md/inner.md": "x" } });
    expect(loadWikiSchema(scope(v), "wiki").found).toBe(false);
  });
});

describe("wiki.folder config", () => {
  it("is an optional vault setting", () => {
    expect(VaultConfigSchema.parse({ id: "a", path: "/x" }).wiki).toBeUndefined();
    expect(VaultConfigSchema.parse({ id: "a", path: "/x", wiki: { folder: "wiki" } }).wiki).toEqual(
      {
        folder: "wiki",
      },
    );
    expect(VaultConfigSchema.safeParse({ id: "a", path: "/x", wiki: { folder: "" } }).success).toBe(
      false,
    );
  });

  it("reaches the registry normalized, and a folder that climbs out of the vault is dropped", () => {
    const wf = (folder: string) =>
      new VaultRegistry([{ id: "a", path: "/tmp", wiki: { folder } }]).resolve("a").wikiFolder;
    expect(wf("wiki")).toBe("wiki");
    expect(wf("/wiki//sub/")).toBe("wiki/sub");
    expect(wf("..")).toBeUndefined();
    expect(wf("a/../b")).toBeUndefined();
    expect(new VaultRegistry([{ id: "a", path: "/tmp" }]).resolve("a").wikiFolder).toBeUndefined();
  });
});
