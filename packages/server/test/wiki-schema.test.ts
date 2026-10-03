// SCHEMA.md: parsing is forgiving (a malformed file is a warning, never an error), checking a page
// against it returns problems for the caller to fix, and `vaults[].wiki.folder` reaches the registry.

import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { VaultConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import type { FolderAcl } from "../src/acl";
import {
  checkFrontmatter,
  loadWikiSchema,
  parseWikiSchema,
  SCHEMA_LIMITS,
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

describe("property names that are also Object.prototype members", () => {
  const ready = parseWikiSchema(VALID, "S.md").schema;
  // Reproduced against the unfixed code: each of these threw a TypeError (an inherited function
  // read as the allowed-values list), or was wrongly treated as declared.
  for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    it(`a page property named ${key} is an unknown property, not a crash`, () => {
      const fm = JSON.parse(`{"type":"person","summary":"x","${key}":"v"}`) as Record<
        string,
        unknown
      >;
      const codes = checkFrontmatter(ready, fm).map((p) => `${p.code}:${p.field}`);
      expect(codes).toEqual([`unknown_property:${key}`]);
    });

    it(`a SCHEMA.md that declares ${key} reads it as an ordinary property`, () => {
      const raw = `---\nproperties:\n  "${key}": [a, b]\n  type:\n---\n`;
      const schema = parseWikiSchema(raw, "S.md").schema;
      expect(Object.hasOwn(schema?.vocabulary ?? {}, key)).toBe(true);
      const fm = JSON.parse(`{"${key}":"a"}`) as Record<string, unknown>;
      expect(checkFrontmatter(schema, fm)).toEqual([]);
      const bad = JSON.parse(`{"${key}":"z"}`) as Record<string, unknown>;
      expect(checkFrontmatter(schema, bad).map((p) => p.code)).toEqual(["bad_value"]);
    });
  }

  it("a required field named toString is not satisfied by the inherited method", () => {
    const schema = parseWikiSchema(
      "---\ntypes:\n  x:\n    required: [toString]\n---\n",
      "S.md",
    ).schema;
    expect(checkFrontmatter(schema, { type: "x" }).map((p) => p.code)).toEqual([
      "missing_required",
    ]);
  });
});

describe("SCHEMA.md size and structure limits", () => {
  it("a file over the byte cap is not parsed, with a warning", () => {
    const big = `---\ntypes:\n  a:\n    description: ${"x".repeat(SCHEMA_LIMITS.fileBytes)}\n---\n`;
    const r = parseWikiSchema(big, "S.md");
    expect(r.schema).toBeNull();
    expect(r.warnings.join(" ")).toContain("larger than");
  });

  it("is checked on the file size before the file is read", () => {
    v = makeTestVault({
      files: { "wiki/SCHEMA.md": `---\ntypes: {}\n---\n${"x".repeat(SCHEMA_LIMITS.fileBytes)}` },
    });
    const r = loadWikiSchema({ root: v.root, acl: v.acl, grantedScopes: ["*"] }, "wiki");
    expect(r).toMatchObject({ found: true, schema: null });
    expect(r.warnings.join(" ")).toContain("larger than");
  });

  it("the byte cap is on what is read: exactly the cap is parsed, one byte over is not", () => {
    const head = "---\ntypes: {}\n---\n";
    const at = head + "x".repeat(SCHEMA_LIMITS.fileBytes - head.length);
    v = makeTestVault({ files: { "wiki/SCHEMA.md": at } });
    const scope = { root: v.root, acl: v.acl, grantedScopes: ["*"] };
    expect(loadWikiSchema(scope, "wiki").warnings.join(" ")).not.toContain("larger than");
    v.write("wiki/SCHEMA.md", `${at}x`);
    expect(loadWikiSchema(scope, "wiki").warnings.join(" ")).toContain("larger than");
  });

  it("cuts types, fields, properties and values at their caps, with a warning each", () => {
    const types = Object.fromEntries(
      Array.from({ length: SCHEMA_LIMITS.types + 5 }, (_, i) => [`t${i}`, { required: ["a"] }]),
    );
    const fields = Array.from({ length: SCHEMA_LIMITS.fieldsPerType + 5 }, (_, i) => `f${i}`);
    const props = Object.fromEntries(
      Array.from({ length: SCHEMA_LIMITS.properties + 5 }, (_, i) => [`p${i}`, null]),
    );
    const vals = Array.from({ length: SCHEMA_LIMITS.valuesPerProperty + 5 }, (_, i) => `v${i}`);
    const yaml = (o: unknown): string => JSON.stringify(o);
    const raw = `---\ntypes: ${yaml({ ...types, wide: { required: fields } })}\nproperties: ${yaml({ ...props, many: vals })}\n---\n`;
    const r = parseWikiSchema(raw, "S.md");
    expect(r.schema?.types.length).toBe(SCHEMA_LIMITS.types);
    expect(Object.keys(r.schema?.vocabulary ?? {}).length).toBe(SCHEMA_LIMITS.properties);
    expect(r.warnings.filter((w) => w.includes("only the first")).length).toBeGreaterThanOrEqual(2);
  });

  it("drops an over-long name or value instead of echoing it back", () => {
    const long = "y".repeat(SCHEMA_LIMITS.textChars + 1);
    const raw = `---\ntypes:\n  ${long}:\n    required: [a]\n  ok:\n    required: ["${long}", b]\n---\n`;
    const r = parseWikiSchema(raw, "S.md");
    expect(r.schema?.types.map((t) => t.name)).toEqual(["ok"]);
    expect(r.schema?.types[0]?.required).toEqual(["b"]);
    expect(r.warnings.join(" ")).toContain("longer than");
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

  // The ACL is checked on the REAL path: a readable alias must not carry a read-denied note out
  // (the JS fallback follows the link; run with OBSIDIAN_TC_FORCE_JS_FALLBACK=1 to cover it).
  it.skipIf(process.platform === "win32")(
    "a SCHEMA.md symlinked to a read-denied note counts as missing and leaks nothing",
    () => {
      v = makeTestVault({
        files: {
          "wiki/a.md": "x",
          "secret.md": "---\ntypes:\n  SECRET_TYPE:\n    description: TOPSECRET\n---\n",
        },
        acl: { readPaths: ["wiki/**"] },
      });
      symlinkSync("../secret.md", join(v.root, "wiki", "SCHEMA.md"));
      const r = loadWikiSchema(scope(v), "wiki");
      expect(r).toMatchObject({ found: false, schema: null });
      expect(JSON.stringify(r)).not.toMatch(/SECRET_TYPE|TOPSECRET/);
    },
  );

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
    expect(
      VaultConfigSchema.parse({ id: "a", path: "/x", wiki: { folder: "notes/wiki" } }).wiki,
    ).toEqual({ folder: "notes/wiki" });
  });

  // Rejected, never reinterpreted: each of these used to become "no folder" or "the whole vault".
  for (const folder of [
    "",
    ".",
    "/",
    "..",
    "./",
    "/wiki",
    "wiki/",
    "wiki//sub",
    "a/../b",
    "../wiki",
    "wiki/./x",
    "C:\\wiki",
    "C:/wiki",
    "wiki\\sub",
    "wiki\0",
    "wiki.",
    "wiki ",
  ]) {
    it(`the schema rejects wiki.folder ${JSON.stringify(folder)}`, () => {
      expect(VaultConfigSchema.safeParse({ id: "a", path: "/x", wiki: { folder } }).success).toBe(
        false,
      );
    });
    it(`the registry refuses ${JSON.stringify(folder)} instead of reinterpreting it`, () => {
      expect(() => new VaultRegistry([{ id: "a", path: "/tmp", wiki: { folder } }])).toThrow(
        /wiki\.folder/,
      );
    });
  }

  for (const rawFolder of ["raw.", "raw "]) {
    it(`the schema rejects wiki.rawFolder ${JSON.stringify(rawFolder)} with the Windows-safe rule`, () => {
      const parsed = VaultConfigSchema.safeParse({
        id: "a",
        path: "/x",
        wiki: { folder: "wiki", rawFolder },
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(
          parsed.error.issues.find((issue) => issue.path.at(-1) === "rawFolder")?.message,
        ).toMatch(/space or dot/);
    });
  }

  it("reaches the registry exactly as written; a vault without one has none", () => {
    const wf = (folder: string) =>
      new VaultRegistry([{ id: "a", path: "/tmp", wiki: { folder } }]).resolve("a").wikiFolder;
    expect(wf("wiki")).toBe("wiki");
    expect(wf("notes/wiki")).toBe("notes/wiki");
    expect(new VaultRegistry([{ id: "a", path: "/tmp" }]).resolve("a").wikiFolder).toBeUndefined();
  });
});
