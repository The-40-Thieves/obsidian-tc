// Domain 16 — Smart Context bundling. Filesystem-only, pure: aggregate notes into a
// single markdown/XML blob, ACL-filtered, with file-count + byte budgets surfaced via
// an explicit truncated flag and missing_paths.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
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

// Each of these four notes renders to exactly 50 bundle bytes ("## Notes/x.md\n\n" +
// a 33-char body + "\n\n"), verified with bun -e before writing these tests — so a
// max_bytes budget in multiples of 50 truncates at an exact, predictable file count.
const PAGE_BODY = "x".repeat(33);
const PAGE_FILES = {
  "Notes/a.md": PAGE_BODY,
  "Notes/b.md": PAGE_BODY,
  "Notes/c.md": PAGE_BODY,
  "Notes/d.md": PAGE_BODY,
};

function paths(files: unknown): string[] {
  return (files as { path: string }[]).map((f) => f.path);
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

  it("returns a cursor set to the last emitted path when max_bytes truncates", async () => {
    v = makeM4Vault({ files: PAGE_FILES });
    // 2 files fit (100 bytes); the 3rd would push the running total to 150 > 120.
    const res = await v.call("bundle_folder", {
      vault: "test",
      root: "Notes",
      max_bytes: 120,
    });
    const d = data(res);
    expect(d.truncated).toBe(true);
    expect(d.file_count).toBe(2);
    expect(paths(d.files)).toEqual(["Notes/a.md", "Notes/b.md"]);
    expect(d.cursor).toBe("Notes/b.md");
  });

  it("resumes from a cursor with exactly the remainder, no duplicates, no gaps", async () => {
    v = makeM4Vault({ files: PAGE_FILES });
    const page1 = data(
      await v.call("bundle_folder", { vault: "test", root: "Notes", max_bytes: 120 }),
    );
    expect(page1.truncated).toBe(true);
    expect(page1.cursor).toBe("Notes/b.md");

    const page2 = data(
      await v.call("bundle_folder", {
        vault: "test",
        root: "Notes",
        max_bytes: 120,
        cursor: page1.cursor as string,
      }),
    );
    expect(page2.truncated).toBe(false);
    expect(page2.cursor).toBeUndefined();
    expect(paths(page2.files)).toEqual(["Notes/c.md", "Notes/d.md"]);

    const whole = data(
      await v.call("bundle_folder", { vault: "test", root: "Notes", max_bytes: 1_000_000 }),
    );
    expect(paths(page1.files).concat(paths(page2.files))).toEqual(paths(whole.files));
  });

  it("returns an empty, non-truncated page with no cursor when the cursor is past the end", async () => {
    v = makeM4Vault({ files: PAGE_FILES });
    const res = await v.call("bundle_folder", {
      vault: "test",
      root: "Notes",
      cursor: "Notes/zzz.md",
    });
    const d = data(res);
    expect(d.truncated).toBe(false);
    expect(d.file_count).toBe(0);
    expect(paths(d.files)).toEqual([]);
    expect(d.cursor).toBeUndefined();
  });

  it("resumes correctly past a cursor naming a path deleted since it was issued", async () => {
    v = makeM4Vault({ files: PAGE_FILES });
    const page1 = data(
      await v.call("bundle_folder", { vault: "test", root: "Notes", max_bytes: 120 }),
    );
    expect(page1.cursor).toBe("Notes/b.md");

    unlinkSync(join(v.root, "Notes/b.md"));

    const page2 = data(
      await v.call("bundle_folder", {
        vault: "test",
        root: "Notes",
        max_bytes: 1_000_000,
        cursor: page1.cursor as string,
      }),
    );
    expect(paths(page2.files)).toEqual(["Notes/c.md", "Notes/d.md"]);
  });

  it("yields a cursor when max_files truncates, not just max_bytes", async () => {
    v = makeM4Vault({ files: PAGE_FILES });
    const res = await v.call("bundle_folder", {
      vault: "test",
      root: "Notes",
      max_files: 2,
      max_bytes: 1_000_000,
    });
    const d = data(res);
    expect(d.truncated).toBe(true);
    expect(d.file_count).toBe(2);
    expect(d.cursor).toBe("Notes/b.md");
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
