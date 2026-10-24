// Layer chain resolution: root -> nearest SCHEMA.md, nearest leaf wins, [] / null remove, inherit:false
// cuts the chain, a layer the caller may not read is absent for that caller, and parsed layers are
// cached on their stat signature (never on the ACL).
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import {
  conventionsLayerPaths,
  evictConventionsLayer,
  readConventionsLayer,
  resolveConventions,
} from "../src/conventions/resolve";
import { makeTestVault, type TestVault } from "./m1-helpers";

let v: TestVault | undefined;
afterEach(() => {
  v?.cleanup();
  v = undefined;
});

const layer = (body: string): string => `---\nconventions:\n${body}\n---\n# rules\n`;
const scopeOf = (t: TestVault, acl = t.acl) => ({
  vaultId: t.id,
  root: t.root,
  acl,
  grantedScopes: ["*"],
});

describe("conventionsLayerPaths", () => {
  it("lists the ancestor SCHEMA.md paths root first, nearest last", () => {
    expect(conventionsLayerPaths("a/b/c.md")).toEqual([
      "SCHEMA.md",
      "a/SCHEMA.md",
      "a/b/SCHEMA.md",
    ]);
    expect(conventionsLayerPaths("c.md")).toEqual(["SCHEMA.md"]);
  });
});

describe("resolveConventions", () => {
  it("merges root and nested layers, recording the source of each entry", () => {
    v = makeTestVault({
      files: {
        "SCHEMA.md": layer(
          "  frontmatter:\n    required: [type]\n    values:\n      status: [draft, current]",
        ),
        "a/SCHEMA.md": layer("  frontmatter:\n    values:\n      status: [draft]"),
      },
    });
    const eff = resolveConventions(scopeOf(v), "a/b/c.md");
    expect(eff.required).toEqual({ values: ["type"], source: "SCHEMA.md" });
    expect(eff.values.status).toEqual({ values: ["draft"], source: "a/SCHEMA.md" });
  });

  it("the nearest layer wins per leaf, so a sibling leaf from the root survives", () => {
    v = makeTestVault({
      files: {
        "SCHEMA.md": layer("  frontmatter:\n    values:\n      status: [draft]\n      tags: [x]"),
        "a/SCHEMA.md": layer("  frontmatter:\n    values:\n      status: [current]"),
      },
    });
    const eff = resolveConventions(scopeOf(v), "a/n.md");
    expect(eff.values.status?.values).toEqual(["current"]);
    expect(eff.values.tags).toEqual({ values: ["x"], source: "SCHEMA.md" });
  });

  it("an explicit [] or null in a nearer layer removes the inherited rule", () => {
    v = makeTestVault({
      files: {
        "SCHEMA.md": layer(
          "  frontmatter:\n    required: [type]\n    values:\n      status: [draft]\n      tags: [x]",
        ),
        "a/SCHEMA.md": layer(
          "  frontmatter:\n    required: []\n    values:\n      status:\n      tags: [x]",
        ),
      },
    });
    const eff = resolveConventions(scopeOf(v), "a/n.md");
    expect(eff.required).toBeUndefined();
    expect(eff.values.status).toBeUndefined();
    expect(eff.values.tags?.values).toEqual(["x"]);
  });

  it("inherit:false drops every ancestor layer", () => {
    v = makeTestVault({
      files: {
        "SCHEMA.md": layer("  frontmatter:\n    required: [type]"),
        "a/SCHEMA.md": layer(
          "  inherit: false\n  frontmatter:\n    values:\n      status: [draft]",
        ),
      },
    });
    const eff = resolveConventions(scopeOf(v), "a/b/n.md");
    expect(eff.required).toBeUndefined();
    expect(eff.values.status?.values).toEqual(["draft"]);
  });

  it("a layer the caller may not read is absent for that caller and present for another", () => {
    v = makeTestVault({
      files: {
        "SCHEMA.md": layer("  frontmatter:\n    required: [type]"),
        "a/SCHEMA.md": layer("  frontmatter:\n    values:\n      status: [draft]"),
      },
    });
    const narrow = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["a/**"],
    });
    const granted = resolveConventions({ ...scopeOf(v), acl: narrow }, "a/n.md");
    expect(granted.required).toBeUndefined();
    expect(granted.values.status?.values).toEqual(["draft"]);
    const full = resolveConventions(scopeOf(v), "a/n.md");
    expect(full.required?.values).toEqual(["type"]);
  });

  it.skipIf(process.platform === "win32")(
    "a symlinked layer that escapes the vault is absent",
    () => {
      v = makeTestVault({
        files: { "a/x.md": "x", "secret.md": layer("  frontmatter:\n    required: [TOPSECRET]") },
        acl: { readPaths: ["a/**"] },
      });
      symlinkSync("../secret.md", join(v.root, "a", "SCHEMA.md"));
      const eff = resolveConventions(scopeOf(v), "a/n.md");
      expect(eff.values).toEqual({});
      expect(JSON.stringify(eff)).not.toContain("TOPSECRET");
    },
  );

  it("records a file warning for a legacy-only SCHEMA.md outside the wiki folder", () => {
    v = makeTestVault({
      files: {
        "notes/SCHEMA.md": "---\ntypes:\n  concept:\n    required: [summary]\n---\n",
        "notes/n.md": "x",
      },
    });
    const eff = resolveConventions(scopeOf(v), "notes/n.md");
    expect(eff.fileWarnings).toEqual([
      expect.objectContaining({
        path: "notes/SCHEMA.md",
        message: expect.stringContaining("conventions:"),
      }),
    ]);
  });

  it("a legacy-only SCHEMA.md inside the wiki folder gets no hint", () => {
    v = makeTestVault({
      files: {
        "wiki/SCHEMA.md": "---\ntypes:\n  concept:\n    required: [summary]\n---\n",
        "wiki/n.md": "x",
      },
      wikiFolder: "wiki",
    });
    const eff = resolveConventions({ ...scopeOf(v), wikiFolders: ["wiki"] }, "wiki/n.md");
    expect(eff.fileWarnings).toEqual([]);
  });
});

describe("layer cache", () => {
  it("returns the same parsed object while the stat signature is unchanged", () => {
    v = makeTestVault({ files: { "SCHEMA.md": layer("  frontmatter:\n    required: [type]") } });
    const first = readConventionsLayer(scopeOf(v), "SCHEMA.md");
    const second = readConventionsLayer(scopeOf(v), "SCHEMA.md");
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("misses after the file changes size or mtime", () => {
    v = makeTestVault({ files: { "SCHEMA.md": layer("  frontmatter:\n    required: [type]") } });
    const first = readConventionsLayer(scopeOf(v), "SCHEMA.md");
    v.write("SCHEMA.md", layer("  frontmatter:\n    required: [type, summary]"));
    const after = readConventionsLayer(scopeOf(v), "SCHEMA.md");
    expect(after).not.toBe(first);
    expect(after?.layer?.required).toEqual(["type", "summary"]);
  });

  it("misses after an explicit evict", () => {
    v = makeTestVault({ files: { "SCHEMA.md": layer("  frontmatter:\n    required: [type]") } });
    const first = readConventionsLayer(scopeOf(v), "SCHEMA.md");
    evictConventionsLayer(v.id, "SCHEMA.md");
    expect(readConventionsLayer(scopeOf(v), "SCHEMA.md")).not.toBe(first);
  });

  it("an ACL-denied layer is never returned from the cache", () => {
    v = makeTestVault({ files: { "SCHEMA.md": layer("  frontmatter:\n    required: [type]") } });
    readConventionsLayer(scopeOf(v), "SCHEMA.md");
    const denied = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["other/**"],
    });
    expect(readConventionsLayer({ ...scopeOf(v), acl: denied }, "SCHEMA.md")).toBeNull();
  });
});
