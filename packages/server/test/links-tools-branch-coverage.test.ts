// THE-602 wave 2 — genuine-behavior tests targeting branches left uncovered in
// links-tools.ts: missing-note guards, self/other-target exclusion in backlinks,
// truncation + double-break scanning loops, folder-scoped scans, code-block
// exclusion, heading/empty-target skips, embed filtering + literal-target
// fallback in rewrite_link, and prev_hash concurrency checks in prune_hub_links.
import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

describe("Domain 5: links branch coverage (THE-602 wave 2)", () => {
  it("get_outgoing_links errors when the note does not exist", async () => {
    const v = makeTestVault({ files: { "other.md": "x" } });
    try {
      const r = await v.call("get_outgoing_links", { vault: "test", path: "missing.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("get_outgoing_links drops embeds but keeps other links when include_embeds is false", async () => {
    const v = makeTestVault({
      files: { "Target.md": "t", "a.md": "![[Target]] and [[Target]]\n" },
    });
    try {
      const r = await v.call("get_outgoing_links", {
        vault: "test",
        path: "a.md",
        include_embeds: false,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { links: Array<{ kind: string }> };
        expect(d.links.map((l) => l.kind)).toEqual(["wikilink"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("get_backlinks errors when the note does not exist", async () => {
    const v = makeTestVault({ files: { "other.md": "x" } });
    try {
      const r = await v.call("get_backlinks", { vault: "test", path: "missing.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("get_backlinks excludes links resolving elsewhere and dangling links, and truncates + stops scanning early", async () => {
    const v = makeTestVault({
      files: {
        "note.md": "content",
        "other.md": "content2",
        // Each of these links to the target note ("note"); each also links to a
        // different resolvable note ("other") and a dangling one ("Dangling") —
        // both of which must be excluded from note.md's backlinks.
        "a.md": "[[note]] and [[other]] and [[Dangling]]",
        "b.md": "[[note]]",
        "c.md": "[[note]]",
      },
    });
    try {
      const r = await v.call("get_backlinks", { vault: "test", path: "note.md", limit: 2 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          total: number;
          truncated: boolean;
          backlinks: Array<{ source_path: string }>;
        };
        // Only "note" links count; "other" (resolves elsewhere) and "Dangling"
        // (unresolved) must never appear, and scanning stops the instant the
        // limit is hit rather than collecting the true total (3).
        expect(d.total).toBe(2);
        expect(d.truncated).toBe(true);
        expect(d.backlinks.every((b) => b.source_path !== "other.md")).toBe(true);
      }
    } finally {
      v.cleanup();
    }
  });

  it("find_orphans scopes to a folder and ignores links inside code blocks", async () => {
    const v = makeTestVault({
      files: {
        "sub/hub.md": "```\n[[Real]]\n```\n",
        "Real.md": "x",
        "other.md": "y",
      },
    });
    try {
      const scoped = await v.call("find_orphans", { vault: "test", folder: "sub" });
      expect(scoped.ok).toBe(true);
      if (scoped.ok) {
        const d = scoped.data as { total: number; orphans: string[] };
        // folder scoping: only the note under sub/ is a candidate.
        expect(d.orphans).toEqual(["sub/hub.md"]);
        expect(d.total).toBe(1);
      }

      // If the fenced-off [[Real]] link were NOT excluded, hub.md would count as
      // having an outgoing link and would drop out of this stricter orphan set.
      const strict = await v.call("find_orphans", {
        vault: "test",
        folder: "sub",
        require_no_outgoing: true,
      });
      expect(strict.ok).toBe(true);
      if (strict.ok) expect((strict.data as { orphans: string[] }).orphans).toEqual(["sub/hub.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("find_unresolved_links ignores links inside code blocks", async () => {
    const v = makeTestVault({ files: { "a.md": "```\n[[Dangling]]\n```\n" } });
    try {
      const r = await v.call("find_unresolved_links", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { total: number }).total).toBe(0);
    } finally {
      v.cleanup();
    }
  });

  it("find_unresolved_links skips empty and heading-only targets", async () => {
    const v = makeTestVault({
      files: { "a.md": "[text](#heading) and [[#Heading]] and real text\n" },
    });
    try {
      const r = await v.call("find_unresolved_links", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { total: number }).total).toBe(0);
    } finally {
      v.cleanup();
    }
  });

  it("find_unresolved_links scopes to a folder, truncates, and stops scanning early", async () => {
    const v = makeTestVault({
      files: { "sub/a.md": "[[D1]] and [[D2]] and [[D3]]", "outside.md": "[[D4]]" },
    });
    try {
      const r = await v.call("find_unresolved_links", { vault: "test", folder: "sub", limit: 2 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { total: number; truncated: boolean; unresolved: Array<unknown> };
        expect(d.total).toBe(2);
        expect(d.truncated).toBe(true);
        expect(d.unresolved).toHaveLength(2);
      }
    } finally {
      v.cleanup();
    }
  });

  it("rewrite_link scopes to a folder, drops embeds under include_embeds:false, and leaves non-matching targets untouched", async () => {
    const v = makeTestVault({
      files: {
        "old.md": "x",
        "keep.md": "y",
        "sub/a.md": "[[old]] and ![[old]] and [[keep]]",
      },
    });
    try {
      const r = await v.call("rewrite_link", {
        vault: "test",
        from_target: "old",
        to_target: "new",
        folder: "sub",
        include_embeds: false,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { notes_changed: number; links_rewritten: number };
        // Only the plain wikilink to "old" is rewritten: the embed is dropped by
        // include_embeds:false, and the "keep" link never matched from_target.
        expect(d).toMatchObject({ notes_changed: 1, links_rewritten: 1 });
      }
      // dry_run defaults true — nothing written yet.
      expect(v.read("sub/a.md")).toBe("[[old]] and ![[old]] and [[keep]]");
    } finally {
      v.cleanup();
    }
  });

  it("rewrite_link falls back to a literal target match when from_target does not resolve to any note", async () => {
    const v = makeTestVault({ files: { "a.md": "[[UnknownTarget]]" } });
    try {
      const r = await v.call("rewrite_link", {
        vault: "test",
        from_target: "UnknownTarget",
        to_target: "Renamed",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { notes_changed: number; links_rewritten: number };
        expect(d).toMatchObject({ notes_changed: 1, links_rewritten: 1 });
      }
    } finally {
      v.cleanup();
    }
  });

  it("prune_hub_links errors when the note does not exist", async () => {
    const v = makeTestVault({ files: { "other.md": "x" } });
    try {
      const r = await v.call("prune_hub_links", { vault: "test", path: "missing.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("prune_hub_links accepts a matching prev_hash and rejects a stale one", async () => {
    const v = makeTestVault({ files: { "Real.md": "x", "hub.md": "# Hub\n- [[Real]]\n" } });
    try {
      const first = await v.call("prune_hub_links", { vault: "test", path: "hub.md" });
      expect(first.ok).toBe(true);
      const hash = first.ok ? (first.data as { prev_hash: string }).prev_hash : "";
      expect(hash).not.toBe("");

      const matching = await v.call("prune_hub_links", {
        vault: "test",
        path: "hub.md",
        prev_hash: hash,
      });
      expect(matching.ok).toBe(true);

      const stale = await v.call("prune_hub_links", {
        vault: "test",
        path: "hub.md",
        prev_hash: "not-the-real-hash",
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe("concurrent_modification");
    } finally {
      v.cleanup();
    }
  });
});
