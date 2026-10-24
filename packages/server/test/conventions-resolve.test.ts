// Layer chain resolution: root -> nearest SCHEMA.md, nearest leaf wins, [] / null remove, inherit:false
// cuts the chain, a layer the caller may not read is absent for that caller, and parsed layers are
// cached on their stat signature (never on the ACL).
import { chmodSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import {
  conventionsLayerPaths,
  evictConventionsLayer,
  readConventionsLayer,
  resolveConventions,
} from "../src/conventions/resolve";
import { MAX_SCAN_WARNINGS } from "../src/tools/scan-warnings";
import { makeTestVault, type TestVault } from "./m1-helpers";

const ROOT_IS_ROOT = process.getuid?.() === 0;

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
    "a symlinked layer whose in-vault target the caller may not read is absent, with no warning",
    () => {
      v = makeTestVault({
        files: { "a/x.md": "x", "secret.md": layer("  frontmatter:\n    required: [TOPSECRET]") },
        acl: { readPaths: ["a/**"] },
      });
      symlinkSync("../secret.md", join(v.root, "a", "SCHEMA.md"));
      const eff = resolveConventions(scopeOf(v), "a/n.md");
      expect(eff.values).toEqual({});
      expect(eff.fileWarnings).toEqual([]);
      expect(JSON.stringify(eff)).not.toContain("TOPSECRET");
    },
  );

  it.skipIf(process.platform === "win32")(
    "a symlinked layer that escapes the vault is absent, and no warning names its target",
    () => {
      const outside = mkdtempSync(join(tmpdir(), "conv-outside-"));
      try {
        writeFileSync(
          join(outside, "SCHEMA.md"),
          layer("  frontmatter:\n    required: [TOPSECRET]"),
        );
        v = makeTestVault({ files: { "a/x.md": "x" }, acl: { readPaths: ["a/**"] } });
        symlinkSync(join(outside, "SCHEMA.md"), join(v.root, "a", "SCHEMA.md"));
        const eff = resolveConventions(scopeOf(v), "a/n.md");
        expect(eff.values).toEqual({});
        expect(JSON.stringify(eff)).not.toContain("TOPSECRET");
        expect(JSON.stringify(eff)).not.toContain(outside);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it("layers lists exactly the layers merged, root first, and none cut off by inherit:false", () => {
    v = makeTestVault({
      files: {
        "SCHEMA.md": layer("  version: 1\n  frontmatter:\n    required: [type]"),
        "a/SCHEMA.md": layer(
          "  version: 1\n  inherit: false\n  frontmatter:\n    values:\n      status: [draft]",
        ),
        "a/b/SCHEMA.md": layer(
          "  version: 1\n  frontmatter:\n    values:\n      status: [current]",
        ),
        "a/b/n.md": "x",
      },
    });
    const eff = resolveConventions(scopeOf(v), "a/b/n.md");
    expect(eff.layers).toEqual([
      { path: "a/SCHEMA.md", inherit: false, version: 1 },
      { path: "a/b/SCHEMA.md", inherit: true, version: 1 },
    ]);
  });

  it("a list whose entries are all dropped does not remove the inherited rule", () => {
    v = makeTestVault({
      files: {
        "SCHEMA.md": layer(
          "  frontmatter:\n    required: [type]\n    values:\n      status: [draft]",
        ),
        "a/SCHEMA.md": layer(
          '  frontmatter:\n    required: [""]\n    values:\n      status: ["  "]',
        ),
        "a/n.md": "x",
      },
    });
    const eff = resolveConventions(scopeOf(v), "a/n.md");
    expect(eff.required?.values).toEqual(["type"]);
    expect(eff.values.status?.values).toEqual(["draft"]);
    expect(eff.fileWarnings.map((w) => w.path)).toContain("a/SCHEMA.md");
  });

  it.skipIf(process.platform === "win32" || ROOT_IS_ROOT)(
    "a read error names at most an errno code, never the vault's absolute path",
    () => {
      v = makeTestVault({
        files: { "a/SCHEMA.md": layer("  frontmatter:\n    required: [type]"), "a/n.md": "x" },
      });
      const file = join(v.root, "a", "SCHEMA.md");
      chmodSync(file, 0o000);
      try {
        const eff = resolveConventions(scopeOf(v), "a/n.md");
        expect(eff.fileWarnings).toHaveLength(1);
        expect(eff.fileWarnings[0]?.message).toMatch(/^conventions not read: [A-Za-z_]+$/);
        expect(JSON.stringify(eff)).not.toContain(v.root);
      } finally {
        chmodSync(file, 0o644);
      }
    },
  );

  it("caps the file warnings of one resolve at the scan cap and counts the rest", () => {
    const files: Record<string, string> = {};
    for (let k = 0; k < 60; k++)
      files[`${"d/".repeat(k)}SCHEMA.md`] = layer(
        "  future: 1\n  frontmatter:\n    required: [type]",
      );
    v = makeTestVault({ files });
    const eff = resolveConventions(scopeOf(v), `${"d/".repeat(60)}n.md`);
    expect(eff.fileWarnings).toHaveLength(MAX_SCAN_WARNINGS);
    expect(eff.fileWarningsOmitted).toBe(60 - MAX_SCAN_WARNINGS);
  });

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

  it("misses after a same-size content edit that keeps the mtime", () => {
    v = makeTestVault({ files: { "SCHEMA.md": layer("  frontmatter:\n    required: [type]") } });
    const file = join(v.root, "SCHEMA.md");
    const when = new Date("2026-01-01T00:00:00Z");
    utimesSync(file, when, when);
    const first = readConventionsLayer(scopeOf(v), "SCHEMA.md");
    writeFileSync(file, layer("  frontmatter:\n    required: [kind]"));
    utimesSync(file, when, when);
    const after = readConventionsLayer(scopeOf(v), "SCHEMA.md");
    expect(after).not.toBe(first);
    expect(after?.layer?.required).toEqual(["kind"]);
  });

  it("evicts under the normalised path, so ./a/SCHEMA.md drops the cached layer", () => {
    v = makeTestVault({ files: { "a/SCHEMA.md": layer("  frontmatter:\n    required: [type]") } });
    const first = readConventionsLayer(scopeOf(v), "a/SCHEMA.md");
    evictConventionsLayer(v.id, "./a/SCHEMA.md");
    expect(readConventionsLayer(scopeOf(v), "a/SCHEMA.md")).not.toBe(first);
  });

  it("caps the warnings a cached layer keeps at the scan cap", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `      p${i}: [{}, {}]`).join("\n");
    v = makeTestVault({
      files: { "SCHEMA.md": `---\nconventions:\n  frontmatter:\n    values:\n${lines}\n---\n` },
    });
    const cached = readConventionsLayer(scopeOf(v), "SCHEMA.md");
    expect(cached?.warnings).toHaveLength(MAX_SCAN_WARNINGS);
    expect(cached?.warningsOmitted).toBeGreaterThan(0);
  });

  it("evicts the least recently used layer once more than 512 distinct layers are read", () => {
    const files: Record<string, string> = {};
    for (let k = 0; k <= 512; k++)
      files[`d${k}/SCHEMA.md`] = layer("  frontmatter:\n    required: [type]");
    v = makeTestVault({ files, vaultId: "lru-bound" });
    const scope = scopeOf(v);
    const first = readConventionsLayer(scope, "d0/SCHEMA.md");
    let last = null as ReturnType<typeof readConventionsLayer>;
    for (let k = 1; k <= 512; k++) last = readConventionsLayer(scope, `d${k}/SCHEMA.md`);
    expect(readConventionsLayer(scope, "d512/SCHEMA.md")).toBe(last);
    expect(readConventionsLayer(scope, "d0/SCHEMA.md")).not.toBe(first);
  });
});
