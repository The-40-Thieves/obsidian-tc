import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeTestVault } from "./m1-helpers";

// Pull the args_hash an elicit_required error carries, so tests confirm against
// exactly what the handler (or dispatch) computed — independent of whether the
// hash is over raw or parsed input.
function hashOf(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return String((r.error.details as { args_hash?: string }).args_hash);
}
function mint(v: ReturnType<typeof makeTestVault>, toolName: string, argsHash: string): string {
  return issueElicitToken(v.db, { vaultId: v.id, toolName, argsHash, caller: "test" });
}

describe("Domain 2: file/note CRUD", () => {
  it("write_note creates, read_note round-trips, and the call is audited", async () => {
    const v = makeTestVault();
    try {
      const w = await v.call("write_note", {
        vault: "test",
        path: "notes/hello.md",
        content: "---\ntitle: Hi\n---\nbody text\n",
      });
      expect(w.ok).toBe(true);
      if (w.ok) {
        const d = w.data as { created: boolean; mode_used: string; content_hash: string };
        expect(d.created).toBe(true);
        expect(d.mode_used).toBe("create");
        expect(d.content_hash).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(v.exists("notes/hello.md")).toBe(true);

      const r = await v.call("read_note", { vault: "test", path: "notes/hello.md" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          frontmatter: Record<string, unknown> | null;
          body: string;
          has_frontmatter: boolean;
        };
        expect(d.frontmatter).toEqual({ title: "Hi" });
        expect(d.body).toBe("body text\n");
        expect(d.has_frontmatter).toBe(true);
      }

      const ev = v.events();
      expect(ev.some((e) => e.tool_name === "write_note" && e.status === "ok")).toBe(true);
      expect(ev.some((e) => e.tool_name === "read_note" && e.status === "ok")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("write_note create rejects an existing note with note_exists", async () => {
    const v = makeTestVault({ files: { "a.md": "x" } });
    try {
      const r = await v.call("write_note", { vault: "test", path: "a.md", content: "y" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_exists");
    } finally {
      v.cleanup();
    }
  });

  it("read_note 404s a missing note", async () => {
    const v = makeTestVault();
    try {
      const r = await v.call("read_note", { vault: "test", path: "nope.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("write_note overwrite of a non-empty note runs the HITL cycle", async () => {
    const v = makeTestVault({ files: { "a.md": "old" } });
    try {
      const input = { vault: "test", path: "a.md", content: "new", mode: "overwrite" as const };
      const need = await v.call("write_note", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = mint(v, "write_note", hashOf(need));
      const ok = await v.call("write_note", input, { elicitToken: token });
      expect(ok.ok).toBe(true);
      expect(v.read("a.md")).toBe("new");

      // the consumed token cannot be replayed
      const reuse = await v.call("write_note", input, { elicitToken: token });
      expect(reuse.ok).toBe(false);
      if (!reuse.ok) expect(reuse.error.code).toBe("elicit_required");
    } finally {
      v.cleanup();
    }
  });

  it("write_note overwrite with a stale prev_hash is concurrent_modification", async () => {
    const v = makeTestVault({ files: { "a.md": "current" } });
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "a.md",
        content: "new",
        mode: "overwrite",
        prev_hash: "0".repeat(64),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
    } finally {
      v.cleanup();
    }
  });

  it("append_note appends with a separator and can create when missing", async () => {
    const v = makeTestVault({ files: { "a.md": "line1" } });
    try {
      const a = await v.call("append_note", { vault: "test", path: "a.md", content: "line2" });
      expect(a.ok).toBe(true);
      expect(v.read("a.md")).toBe("line1\nline2");

      const miss = await v.call("append_note", { vault: "test", path: "b.md", content: "x" });
      expect(miss.ok).toBe(false);
      if (!miss.ok) expect(miss.error.code).toBe("note_not_found");

      const made = await v.call("append_note", {
        vault: "test",
        path: "b.md",
        content: "x",
        create_if_missing: true,
      });
      expect(made.ok).toBe(true);
      expect(v.read("b.md")).toBe("x");
    } finally {
      v.cleanup();
    }
  });

  it("patch_note inserts under a heading and preserves frontmatter", async () => {
    const v = makeTestVault({
      files: { "a.md": "---\nk: 1\n---\n# One\nalpha\n# Two\nbeta\n" },
    });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "One",
        content: "gamma",
      });
      expect(r.ok).toBe(true);
      const out = v.read("a.md");
      expect(out).toContain("k: 1");
      expect(out).toContain("alpha\ngamma\n# Two");

      const missing = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "Nope",
        content: "z",
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("note_exists reports files, folders, and absence", async () => {
    const v = makeTestVault({ files: { "dir/a.md": "x" } });
    try {
      const f = await v.call("note_exists", { vault: "test", path: "dir/a.md" });
      if (f.ok) expect(f.data).toMatchObject({ exists: true, type: "file" });
      const d = await v.call("note_exists", { vault: "test", path: "dir" });
      if (d.ok) expect(d.data).toMatchObject({ exists: true, type: "folder" });
      const n = await v.call("note_exists", { vault: "test", path: "ghost.md" });
      if (n.ok) expect(n.data).toMatchObject({ exists: false, type: null });
    } finally {
      v.cleanup();
    }
  });

  it("list_notes filters by read ACL and paginates", async () => {
    const v = makeTestVault({
      files: { "pub/a.md": "1", "pub/b.md": "2", "priv/c.md": "3" },
      acl: { readPaths: ["pub/**"] },
    });
    try {
      const r = await v.call("list_notes", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { notes: Array<{ path: string }> };
        expect(d.notes.map((n) => n.path)).toEqual(["pub/a.md", "pub/b.md"]);
      }
      const page = await v.call("list_notes", { vault: "test", limit: 1 });
      if (page.ok) {
        const d = page.data as { notes: Array<{ path: string }>; next_cursor: string | null };
        expect(d.notes).toHaveLength(1);
        expect(d.next_cursor).toBe("pub/a.md");
      }
    } finally {
      v.cleanup();
    }
  });

  it("delete_note is destructive: gates on HITL, then trashes (or hard-deletes)", async () => {
    const v = makeTestVault({ files: { "a.md": "x", "b.md": "y" } });
    try {
      const need = await v.call("delete_note", { vault: "test", path: "a.md" });
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = mint(v, "delete_note", hashOf(need));
      const ok = await v.call(
        "delete_note",
        { vault: "test", path: "a.md" },
        { elicitToken: token },
      );
      expect(ok.ok).toBe(true);
      if (ok.ok) expect((ok.data as { trashed_to: string }).trashed_to).toBe(".trash/a.md");
      expect(v.exists("a.md")).toBe(false);
      expect(v.exists(".trash/a.md")).toBe(true);

      const perm = await v.call("delete_note", { vault: "test", path: "b.md", permanent: true });
      const ptoken = mint(v, "delete_note", hashOf(perm));
      const pok = await v.call(
        "delete_note",
        { vault: "test", path: "b.md", permanent: true },
        { elicitToken: ptoken },
      );
      expect(pok.ok).toBe(true);
      expect(v.exists("b.md")).toBe(false);
      expect(v.exists(".trash/b.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("move_note within a folder needs no confirmation and rewrites backlinks", async () => {
    const v = makeTestVault({ files: { "target.md": "body", "a.md": "see [[target]] here" } });
    try {
      const r = await v.call("move_note", { vault: "test", from: "target.md", to: "renamed.md" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { backlinks_updated: { notes: number; links: number } };
        expect(d.backlinks_updated).toEqual({ notes: 1, links: 1 });
      }
      expect(v.exists("target.md")).toBe(false);
      expect(v.exists("renamed.md")).toBe(true);
      expect(v.read("a.md")).toBe("see [[renamed]] here");
    } finally {
      v.cleanup();
    }
  });

  it("move_note across a folder boundary requires confirmation", async () => {
    const v = makeTestVault({ files: { "note.md": "x" } });
    try {
      const input = { vault: "test", from: "note.md", to: "archive/note.md" };
      const need = await v.call("move_note", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = mint(v, "move_note", hashOf(need));
      const ok = await v.call("move_note", input, { elicitToken: token });
      expect(ok.ok).toBe(true);
      expect(v.exists("archive/note.md")).toBe(true);
      expect(v.exists("note.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("move_note same-folder overwrite requires confirmation and trashes the clobbered note", async () => {
    const v = makeTestVault({ files: { "a.md": "A", "b.md": "B" } });
    try {
      const input = { vault: "test", from: "a.md", to: "b.md", overwrite: true };
      const need = await v.call("move_note", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = mint(v, "move_note", hashOf(need));
      const ok = await v.call("move_note", input, { elicitToken: token });
      expect(ok.ok).toBe(true);
      expect(v.read("b.md")).toBe("A");
      expect(v.exists("a.md")).toBe(false);
      expect(v.read(".trash/b.md")).toBe("B");
      if (ok.ok)
        expect((ok.data as { trashed_dest_to: string }).trashed_dest_to).toBe(".trash/b.md");
    } finally {
      v.cleanup();
    }
  });

  it("move_note refuses a folder destination instead of trashing it (review #4)", async () => {
    const v = makeTestVault({ files: { "a.md": "A", "Documents/keep.md": "K" } });
    try {
      const r = await v.call("move_note", {
        vault: "test",
        from: "a.md",
        to: "Documents",
        overwrite: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
      expect(v.exists("Documents/keep.md")).toBe(true);
      expect(v.exists("a.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("move_note to an existing destination without overwrite still refuses (note_exists)", async () => {
    const v = makeTestVault({ files: { "a.md": "A", "b.md": "B" } });
    try {
      const r = await v.call("move_note", { vault: "test", from: "a.md", to: "b.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_exists");
      expect(v.read("b.md")).toBe("B");
    } finally {
      v.cleanup();
    }
  });

  it("move_note pure rename creates no trash entry and reports trashed_dest_to null", async () => {
    const v = makeTestVault({ files: { "a.md": "A" } });
    try {
      const r = await v.call("move_note", { vault: "test", from: "a.md", to: "renamed.md" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { trashed_dest_to: string | null }).trashed_dest_to).toBeNull();
      expect(v.exists(".trash/renamed.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("copy_note duplicates content, gates overwrite behind HITL, and trashes the clobbered dest", async () => {
    const v = makeTestVault({ files: { "a.md": "data", "b.md": "other" } });
    try {
      const c = await v.call("copy_note", { vault: "test", from: "a.md", to: "c.md" });
      expect(c.ok).toBe(true);
      expect(v.read("c.md")).toBe("data");
      if (c.ok) expect((c.data as { trashed_dest_to: string | null }).trashed_dest_to).toBeNull();

      const clash = await v.call("copy_note", { vault: "test", from: "a.md", to: "b.md" });
      expect(clash.ok).toBe(false);
      if (!clash.ok) expect(clash.error.code).toBe("note_exists");

      // Overwriting a non-empty destination now runs the HITL cycle and preserves the clobbered
      // note in .trash (previously copy_note --overwrite destroyed it with no token).
      const input = { vault: "test", from: "a.md", to: "b.md", overwrite: true };
      const need = await v.call("copy_note", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = mint(v, "copy_note", hashOf(need));
      const force = await v.call("copy_note", input, { elicitToken: token });
      expect(force.ok).toBe(true);
      expect(v.read("b.md")).toBe("data");
      expect(v.read(".trash/b.md")).toBe("other");
      if (force.ok)
        expect((force.data as { trashed_dest_to: string }).trashed_dest_to).toBe(".trash/b.md");
    } finally {
      v.cleanup();
    }
  });

  it("a write outside the write whitelist is acl_denied", async () => {
    const v = makeTestVault({ acl: { writePaths: ["notes/**"] } });
    try {
      const denied = await v.call("write_note", {
        vault: "test",
        path: "other/x.md",
        content: "z",
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");

      const allowed = await v.call("write_note", {
        vault: "test",
        path: "notes/x.md",
        content: "z",
      });
      expect(allowed.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("read_notes returns successes and a per-path error list", async () => {
    const v = makeTestVault({ files: { "a.md": "A", "b.md": "B" } });
    try {
      const r = await v.call("read_notes", { vault: "test", paths: ["a.md", "gone.md", "b.md"] });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          notes: Array<{ path: string }>;
          errors: Array<{ path: string; code: string }>;
        };
        expect(d.notes.map((n) => n.path)).toEqual(["a.md", "b.md"]);
        expect(d.errors).toEqual([
          { path: "gone.md", code: "note_not_found", message: expect.any(String) },
        ]);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("THE-198 patch_note block + preamble anchors", () => {
  it("patches relative to a block reference (^id)", async () => {
    const v = makeTestVault({ files: { "a.md": "# H\npara one ^blk1\npara two ^blk2\n" } });
    try {
      const app = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        anchor: { type: "block", block_id: "blk1" },
        content: "AFTER",
      });
      expect(app.ok).toBe(true);
      expect(v.read("a.md")).toContain("para one ^blk1\nAFTER\npara two ^blk2");

      const miss = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        anchor: { type: "block", block_id: "ghost" },
        content: "x",
      });
      expect(miss.ok).toBe(false);
      if (!miss.ok) expect(miss.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("patches the preamble above the first heading (anchor frontmatter)", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nk: 1\n---\nintro line\n# One\nbody\n" } });
    try {
      const pre = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "prepend",
        anchor: { type: "frontmatter" },
        content: "TOP",
      });
      expect(pre.ok).toBe(true);
      const out = v.read("a.md");
      expect(out).toContain("k: 1");
      expect(out).toContain("---\nTOP\nintro line\n# One");
    } finally {
      v.cleanup();
    }
  });

  it("rejects a patch with neither anchor nor target_heading", async () => {
    const v = makeTestVault({ files: { "a.md": "# One\nx\n" } });
    try {
      const bad = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        content: "y",
      });
      expect(bad.ok).toBe(false);
      // the refine rejection is a schema-shape violation -> validation_error (not handler invalid_input)
      if (!bad.ok) expect(bad.error.code).toBe("validation_error");
    } finally {
      v.cleanup();
    }
  });
});

describe("THE-252 writes.requireCas (config-gated strict CAS)", () => {
  it("requires prev_hash on overwrite + append-to-existing when enabled", async () => {
    const v = makeTestVault({ files: { "a.md": "old" }, requireCas: true });
    try {
      const ow = await v.call("write_note", {
        vault: "test",
        path: "a.md",
        content: "new",
        mode: "overwrite",
      });
      expect(ow.ok).toBe(false);
      if (!ow.ok) expect(ow.error.code).toBe("invalid_input");

      const ap = await v.call("append_note", { vault: "test", path: "a.md", content: "x" });
      expect(ap.ok).toBe(false);
      if (!ap.ok) expect(ap.error.code).toBe("invalid_input");

      // with the correct prev_hash it passes the CAS gate and reaches the HITL floor (non-empty overwrite)
      const cur = await v.call("read_note", { vault: "test", path: "a.md" });
      const prev_hash = cur.ok ? (cur.data as { content_hash: string }).content_hash : "";
      const okHash = await v.call("write_note", {
        vault: "test",
        path: "a.md",
        content: "new",
        mode: "overwrite",
        prev_hash,
      });
      expect(okHash.ok).toBe(false);
      if (!okHash.ok) expect(okHash.error.code).toBe("elicit_required");
    } finally {
      v.cleanup();
    }
  });

  it("requires prev_hash on upsert of an existing note (no CAS bypass via upsert)", async () => {
    const v = makeTestVault({ files: { "a.md": "old" }, requireCas: true });
    try {
      // upsert on an EXISTING note takes the same clobber path as overwrite, so requireCas applies.
      const up = await v.call("write_note", {
        vault: "test",
        path: "a.md",
        content: "new",
        mode: "upsert",
      });
      expect(up.ok).toBe(false);
      if (!up.ok) expect(up.error.code).toBe("invalid_input");

      // upsert of a NEW note is a create — no prev_hash required, so it succeeds.
      const created = await v.call("write_note", {
        vault: "test",
        path: "fresh.md",
        content: "hi",
        mode: "upsert",
      });
      expect(created.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("default (requireCas off) still allows overwrite/append without prev_hash", async () => {
    const v = makeTestVault({ files: { "a.md": "line1" } });
    try {
      const ap = await v.call("append_note", { vault: "test", path: "a.md", content: "line2" });
      expect(ap.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});
