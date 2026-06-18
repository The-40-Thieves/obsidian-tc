import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

describe("Domain 4: tags", () => {
  it("get_note_tags splits frontmatter and inline, ignoring code fences", async () => {
    const v = makeTestVault({
      files: {
        "a.md":
          "---\ntags: [book]\n---\nintro #alpha and #project/sub\n\n```\n#codefence\n```\nend\n",
      },
    });
    try {
      const r = await v.call("get_note_tags", { vault: "test", path: "a.md" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { frontmatter: string[]; inline: string[]; all: string[] };
        expect(d.frontmatter).toEqual(["book"]);
        expect(d.inline.sort()).toEqual(["alpha", "project/sub"]);
        expect(d.all).toEqual(["alpha", "book", "project/sub"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("list_tags aggregates counts across notes, read-ACL filtered", async () => {
    const v = makeTestVault({
      files: {
        "pub/a.md": "---\ntags: [x]\n---\n#shared",
        "pub/b.md": "#shared\n#y",
        "priv/c.md": "#secret",
      },
      acl: { readPaths: ["pub/**"] },
    });
    try {
      const r = await v.call("list_tags", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { notes_scanned: number; tags: Array<{ tag: string; count: number }> };
        expect(d.notes_scanned).toBe(2);
        expect(d.tags[0]).toEqual({ tag: "shared", count: 2 });
        expect(d.tags.some((t) => t.tag === "secret")).toBe(false);
      }
    } finally {
      v.cleanup();
    }
  });

  it("add_tag writes to the frontmatter list and is idempotent", async () => {
    const v = makeTestVault({ files: { "a.md": "---\ntags: [one]\n---\nbody" } });
    try {
      const first = await v.call("add_tag", { vault: "test", path: "a.md", tag: "two" });
      if (first.ok) expect((first.data as { added: boolean }).added).toBe(true);

      const tags = await v.call("get_note_tags", { vault: "test", path: "a.md" });
      if (tags.ok)
        expect((tags.data as { frontmatter: string[] }).frontmatter).toEqual(["one", "two"]);

      const again = await v.call("add_tag", { vault: "test", path: "a.md", tag: "two" });
      if (again.ok) expect((again.data as { added: boolean }).added).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("add_tag inline appends a hashtag to the body", async () => {
    const v = makeTestVault({ files: { "b.md": "hello" } });
    try {
      const r = await v.call("add_tag", {
        vault: "test",
        path: "b.md",
        tag: "flag",
        location: "inline",
      });
      expect(r.ok).toBe(true);
      expect(v.read("b.md")).toBe("hello\n#flag");
    } finally {
      v.cleanup();
    }
  });

  it("add_tag rejects an invalid tag and honours prev_hash CAS", async () => {
    const v = makeTestVault({ files: { "a.md": "body" } });
    try {
      const bad = await v.call("add_tag", { vault: "test", path: "a.md", tag: "!bad" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("invalid_input");

      const stale = await v.call("add_tag", {
        vault: "test",
        path: "a.md",
        tag: "ok",
        prev_hash: "0".repeat(64),
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe("concurrent_modification");
    } finally {
      v.cleanup();
    }
  });

  it("remove_tag removes from both locations, exact (not hierarchical)", async () => {
    const v = makeTestVault({
      files: { "a.md": "---\ntags: [keep, drop]\n---\nbody #drop and #keep/sub" },
    });
    try {
      const r = await v.call("remove_tag", { vault: "test", path: "a.md", tag: "drop" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { removed: number }).removed).toBe(2);

      const tags = await v.call("get_note_tags", { vault: "test", path: "a.md" });
      if (tags.ok) {
        const d = tags.data as { frontmatter: string[]; inline: string[] };
        expect(d.frontmatter).toEqual(["keep"]);
        expect(d.inline).toEqual(["keep/sub"]); // #keep/sub untouched by removing "drop"
      }
    } finally {
      v.cleanup();
    }
  });

  it("remove_tag is exact: removing a parent leaves child hashtags intact", async () => {
    const v = makeTestVault({ files: { "a.md": "#keep and #keep/sub here" } });
    try {
      const r = await v.call("remove_tag", {
        vault: "test",
        path: "a.md",
        tag: "keep",
        location: "inline",
      });
      if (r.ok) expect((r.data as { removed: number }).removed).toBe(1);
      expect(v.read("a.md")).toContain("#keep/sub");
      expect(v.read("a.md")).not.toMatch(/#keep\b(?!\/)/);
    } finally {
      v.cleanup();
    }
  });

  it("find_notes_by_tag matches hierarchically", async () => {
    const v = makeTestVault({
      files: {
        "a.md": "#project/active",
        "b.md": "---\ntags: [project]\n---\n",
        "c.md": "#other",
      },
    });
    try {
      const r = await v.call("find_notes_by_tag", { vault: "test", tag: "project" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { matches: Array<{ path: string; tags: string[] }> };
        expect(d.matches.map((m) => m.path)).toEqual(["a.md", "b.md"]);
        expect(d.matches[0]?.tags).toEqual(["project/active"]);
      }
    } finally {
      v.cleanup();
    }
  });
});
