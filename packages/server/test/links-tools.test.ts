import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeTestVault } from "./m1-helpers";

function hashOf(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return String((r.error.details as { args_hash?: string }).args_hash);
}
function mint(v: ReturnType<typeof makeTestVault>, toolName: string, argsHash: string): string {
  return issueElicitToken(v.db, { vaultId: v.id, toolName, argsHash, caller: "test" });
}

describe("Domain 5: links / backlinks / graph", () => {
  it("get_outgoing_links resolves links and ignores code, counting external separately", async () => {
    const v = makeTestVault({
      files: {
        "Target.md": "t",
        "a.md":
          "intro [[Target]] and [md](Target.md)\nhas `[[InCode]]` inline\n```\n[[Fenced]]\n```\next [e](https://x.com) and [[Missing]]\n",
      },
    });
    try {
      const r = await v.call("get_outgoing_links", { vault: "test", path: "a.md" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          links: Array<{ target: string }>;
          counts: { total: number; resolved: number; unresolved: number };
        };
        expect(d.links.map((l) => l.target).sort()).toEqual([
          "Missing",
          "Target",
          "Target.md",
          "https://x.com",
        ]);
        expect(d.counts).toEqual({ total: 4, resolved: 2, unresolved: 1 });
      }
    } finally {
      v.cleanup();
    }
  });

  it("get_backlinks finds linking notes and ignores code-block links", async () => {
    const v = makeTestVault({
      files: {
        "note.md": "content",
        "a.md": "see [[note]]",
        "b.md": "also [n](note.md) and [[note]]",
        "c.md": "`[[note]]` only in code",
      },
    });
    try {
      const r = await v.call("get_backlinks", { vault: "test", path: "note.md" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { total: number; backlinks: Array<{ source_path: string }> };
        expect(d.total).toBe(3);
        expect([...new Set(d.backlinks.map((b) => b.source_path))].sort()).toEqual([
          "a.md",
          "b.md",
        ]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("find_orphans reports notes with no incoming links", async () => {
    const v = makeTestVault({
      files: { "hub.md": "[[child]]", "child.md": "content", "lonely.md": "nothing" },
    });
    try {
      const all = await v.call("find_orphans", { vault: "test" });
      if (all.ok)
        expect((all.data as { orphans: string[] }).orphans.sort()).toEqual(["hub.md", "lonely.md"]);

      const isolated = await v.call("find_orphans", { vault: "test", require_no_outgoing: true });
      if (isolated.ok)
        expect((isolated.data as { orphans: string[] }).orphans).toEqual(["lonely.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("find_unresolved_links reports dangling internal links only", async () => {
    const v = makeTestVault({
      files: { "Real.md": "x", "a.md": "[[Real]] and [[Dangling]] and [e](https://x.com)" },
    });
    try {
      const r = await v.call("find_unresolved_links", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { total: number; unresolved: Array<{ target: string }> };
        expect(d.total).toBe(1);
        expect(d.unresolved[0]?.target).toBe("Dangling");
      }
    } finally {
      v.cleanup();
    }
  });

  it("rewrite_link previews under dry_run, then writes after confirmation", async () => {
    const v = makeTestVault({
      files: { "old.md": "x", "a.md": "see [[old]] here", "b.md": "ref [o](old.md)" },
    });
    try {
      const preview = await v.call("rewrite_link", {
        vault: "test",
        from_target: "old",
        to_target: "new",
      });
      expect(preview.ok).toBe(true);
      if (preview.ok) {
        const d = preview.data as { notes_changed: number; links_rewritten: number };
        expect(d).toMatchObject({ notes_changed: 2, links_rewritten: 2 });
      }
      expect(v.read("a.md")).toBe("see [[old]] here"); // dry-run did not write

      const input = { vault: "test", from_target: "old", to_target: "new", dry_run: false };
      const need = await v.call("rewrite_link", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = mint(v, "rewrite_link", hashOf(need));
      const ok = await v.call("rewrite_link", input, { elicitToken: token });
      expect(ok.ok).toBe(true);
      expect(v.read("a.md")).toBe("see [[new]] here");
      expect(v.read("b.md")).toBe("ref [o](new)");
    } finally {
      v.cleanup();
    }
  });

  it("rewrite_link real run enforces write ACL before confirmation", async () => {
    const v = makeTestVault({
      files: { "notes/target.md": "x", "docs/ref.md": "[[target]]" },
      acl: { writePaths: ["notes/**"] },
    });
    try {
      const denied = await v.call("rewrite_link", {
        vault: "test",
        from_target: "target",
        to_target: "renamed",
        dry_run: false,
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
    } finally {
      v.cleanup();
    }
  });

  it("prune_hub_links removes dangling and duplicate links after confirmation", async () => {
    const v = makeTestVault({
      files: { "Real.md": "x", "hub.md": "# Hub\n- [[Real]]\n- [[Dangling]]\n- [[Real]]\n" },
    });
    try {
      const preview = await v.call("prune_hub_links", { vault: "test", path: "hub.md" });
      expect(preview.ok).toBe(true);
      if (preview.ok) expect((preview.data as { removed_count: number }).removed_count).toBe(2);
      expect(v.read("hub.md")).toContain("[[Dangling]]"); // dry-run did not write

      const input = { vault: "test", path: "hub.md", dry_run: false };
      const need = await v.call("prune_hub_links", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = mint(v, "prune_hub_links", hashOf(need));
      const ok = await v.call("prune_hub_links", input, { elicitToken: token });
      expect(ok.ok).toBe(true);
      expect(v.read("hub.md")).toBe("# Hub\n- [[Real]]\n");
    } finally {
      v.cleanup();
    }
  });
});
