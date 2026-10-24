// get_conventions: the caller-readable SCHEMA.md layers, the merged rules with a source per entry,
// concise form, the no-layer hint, folder inheritance, path rejection and legacy-only layers.
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { makeTestVault, type TestVault } from "./m1-helpers";

const layer = (body: string): string => `---\nconventions:\n${body}\n---\n# rules\n`;

const FILES = {
  "SCHEMA.md": layer(
    "  version: 1\n  frontmatter:\n    required: [type]\n    values:\n      status: [draft, current]",
  ),
  "a/SCHEMA.md": layer("  version: 1\n  frontmatter:\n    values:\n      status: [draft]"),
  "a/b/c.md": "---\ntype: note\n---\nbody",
};

async function getConventions(
  v: TestVault,
  input: Record<string, unknown>,
  over?: Parameters<TestVault["call"]>[2],
): Promise<Record<string, unknown>> {
  const r = await v.call("get_conventions", { vault: "test", ...input }, over);
  if (!r.ok) throw new Error(`get_conventions failed: ${JSON.stringify(r)}`);
  return r.data as Record<string, unknown>;
}

describe("get_conventions", () => {
  it("merges root and nested layers, with a source per effective entry; concise drops layers and source", async () => {
    const v = makeTestVault({ files: FILES });
    try {
      const d = await getConventions(v, { path: "a/b/c.md" });
      expect(d.layers).toEqual([
        { path: "SCHEMA.md", inherit: true, version: 1 },
        { path: "a/SCHEMA.md", inherit: true, version: 1 },
      ]);
      expect(d.effective).toEqual({
        type_key: { value: "type", source: "a/SCHEMA.md" },
        required: { values: ["type"], source: "SCHEMA.md" },
        values: { status: { values: ["draft"], source: "a/SCHEMA.md" } },
        types: {},
      });

      const c = await getConventions(v, { path: "a/b/c.md", response_format: "concise" });
      expect(c).not.toHaveProperty("layers");
      expect(c.effective).toEqual({
        type_key: { value: "type" },
        required: { values: ["type"] },
        values: { status: { values: ["draft"] } },
        types: {},
      });
      expect(JSON.stringify(c)).not.toContain('"source"');
    } finally {
      v.cleanup();
    }
  });

  it("omits a layer the caller cannot read, while a caller with access sees it", async () => {
    const v = makeTestVault({ files: FILES });
    try {
      const narrow = new FolderAcl({
        readOnly: false,
        defaultScopes: [],
        rules: [],
        readPaths: ["a/**"],
      });
      const limited = await getConventions(v, { path: "a/b/c.md" }, { acl: narrow });
      expect(limited.layers).toEqual([{ path: "a/SCHEMA.md", inherit: true, version: 1 }]);
      expect(JSON.stringify(limited)).not.toContain('"required"');

      const full = await getConventions(v, { path: "a/b/c.md" });
      expect(full.layers).toHaveLength(2);
    } finally {
      v.cleanup();
    }
  });

  it("with no layers returns empty effective plus a hint", async () => {
    const v = makeTestVault({ files: { "a/b/c.md": "x" } });
    try {
      const d = await getConventions(v, { path: "a/b/c.md" });
      expect(d.layers).toEqual([]);
      expect(d.effective).toEqual({ values: {}, types: {} });
      expect(String(d.hint)).toContain("conventions:");
    } finally {
      v.cleanup();
    }
  });

  it("a folder without a SCHEMA.md inherits its ancestors' layers", async () => {
    const v = makeTestVault({ files: FILES });
    try {
      const d = await getConventions(v, { path: "a/b" });
      expect(d.layers).toEqual([
        { path: "SCHEMA.md", inherit: true, version: 1 },
        { path: "a/SCHEMA.md", inherit: true, version: 1 },
      ]);
      const root = await getConventions(v, {});
      expect(root.path).toBe("");
      expect(root.layers).toEqual([{ path: "SCHEMA.md", inherit: true, version: 1 }]);
    } finally {
      v.cleanup();
    }
  });

  it("rejects traversal and absolute paths the way other tools do", async () => {
    const v = makeTestVault({ files: FILES });
    try {
      for (const path of ["../outside", "a/../../outside", "/etc/passwd"]) {
        const r = await v.call("get_conventions", { vault: "test", path });
        expect(r.ok, path).toBe(false);
      }
    } finally {
      v.cleanup();
    }
  });

  it("a legacy-only SCHEMA.md (types, no conventions key) is no layer and carries a file warning", async () => {
    const v = makeTestVault({
      files: { "SCHEMA.md": "---\ntypes:\n  meeting: {}\n---\n# legacy\n", "n.md": "x" },
    });
    try {
      const d = await getConventions(v, { path: "n.md" });
      expect(d.layers).toEqual([]);
      const warnings = d.file_warnings as Array<{ path: string; message: string }>;
      expect(warnings).toEqual([
        expect.objectContaining({
          path: "SCHEMA.md",
          message: expect.stringContaining("conventions:"),
        }),
      ]);
    } finally {
      v.cleanup();
    }
  });
});
