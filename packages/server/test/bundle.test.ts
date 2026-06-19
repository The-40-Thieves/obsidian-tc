// Domain 16 — Smart Context bundling. Filesystem-only, pure: aggregate notes into a
// single markdown/XML blob, ACL-filtered, with file-count + byte budgets surfaced via
// an explicit truncated flag and missing_paths.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

const FILES = {
  "Notes/a.md": "# A\nalpha\n",
  "Notes/b.md": "# B\nbeta\n",
  "Notes/c.md": "---\nx: 1\n---\n# C\ngamma\n",
};

function data(res: ToolResult): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
  return res.data as Record<string, unknown>;
}

describe("bundle_folder", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("aggregates all notes under a folder into a markdown bundle", async () => {
    v = makeM4Vault({ files: FILES });
    const res = await v.call("bundle_folder", { vault: "test", root: "Notes" });
    const d = data(res);
    expect(d.file_count).toBe(3);
    expect(d.truncated).toBe(false);
    expect(String(d.bundle)).toContain("## Notes/a.md");
    expect(String(d.bundle)).toContain("alpha");
    expect((d.files as unknown[]).length).toBe(3);
  });

  it("strips frontmatter when include_frontmatter is false", async () => {
    v = makeM4Vault({ files: FILES });
    const res = await v.call("bundle_folder", {
      vault: "test",
      root: "Notes",
      include_frontmatter: false,
    });
    const bundle = String(data(res).bundle);
    expect(bundle).not.toContain("x: 1");
    expect(bundle).toContain("gamma");
  });

  it("caps at max_files and flags truncation", async () => {
    v = makeM4Vault({ files: FILES });
    const res = await v.call("bundle_folder", { vault: "test", root: "Notes", max_files: 2 });
    const d = data(res);
    expect(d.file_count).toBe(2);
    expect(d.truncated).toBe(true);
  });
});

describe("bundle_files", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("bundles an explicit list as XML", async () => {
    v = makeM4Vault({ files: FILES });
    const res = await v.call("bundle_files", {
      vault: "test",
      paths: ["Notes/a.md", "Notes/b.md"],
      format: "xml",
    });
    const d = data(res);
    expect(d.file_count).toBe(2);
    expect(String(d.bundle)).toContain('<document path="Notes/a.md">');
  });

  it("reports missing_paths for files that do not exist", async () => {
    v = makeM4Vault({ files: FILES });
    const res = await v.call("bundle_files", {
      vault: "test",
      paths: ["Notes/a.md", "Notes/missing.md"],
    });
    const d = data(res);
    expect(d.file_count).toBe(1);
    expect(d.missing_paths).toEqual(["Notes/missing.md"]);
  });

  it("enforces the read ACL on each path", async () => {
    v = makeM4Vault({ files: FILES, acl: { readPaths: ["Notes/**"] } });
    const res = await v.call("bundle_files", {
      vault: "test",
      paths: ["Notes/a.md", "Other/x.md"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("acl_denied");
  });
});
