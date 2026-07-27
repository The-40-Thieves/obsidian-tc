// THE-602: branch-coverage headroom for notes-tools.ts. Every test here asserts real
// caller-visible behavior (a thrown error's code, a returned value, or bytes on disk) at a
// branch this module's existing suite (test/notes-tools.test.ts) does not exercise — no
// coverage theater. See that file for the calling convention and m1-helpers.ts for the fixture
// harness this file reuses verbatim.
import { chmodSync } from "node:fs";
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

describe("patch_note: patchByHeading zero-length section (removedSpan's empty branch)", () => {
  it("replace on a heading immediately followed by another heading removes 0 lines", async () => {
    const v = makeTestVault({ files: { "a.md": "# One\n# Two\nbody\n" } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        target_heading: "One",
        content: "X",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { lines_removed: number; bytes_removed: number };
        expect(d.lines_removed).toBe(0);
        expect(d.bytes_removed).toBe(0);
      }
      expect(v.read("a.md")).toBe("# One\nX\n# Two\nbody\n");
    } finally {
      v.cleanup();
    }
  });
});

describe("patch_note: block-anchor prepend/replace (patchByBlock op branches + backward scan)", () => {
  // No blank line between the two paragraphs: the backward scan from ^blk2 must step past
  // "para one ^blk1" (neither blank nor a heading -> continues) before hitting "# H" (a
  // heading -> stops). That exercises both outcomes of the scan's if in one call.
  const raw = "# H\npara one ^blk1\npara two ^blk2\n";

  it("prepend inserts right after the preceding heading", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "prepend",
        anchor: { type: "block", block_id: "blk1" },
        content: "BEFORE",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("# H\nBEFORE\npara one ^blk1\npara two ^blk2\n");
    } finally {
      v.cleanup();
    }
  });

  it("replace on the second block consumes both paragraph lines (scan walked past the first)", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        anchor: { type: "block", block_id: "blk2" },
        content: "REPLACED",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { lines_removed: number; bytes_removed: number };
        // the block backward-scan found no blank line, so it walked back through BOTH
        // paragraph lines before stopping at the heading -- the whole span is replaced.
        expect(d.lines_removed).toBe(2);
        expect(d.bytes_removed).toBe(Buffer.byteLength("para one ^blk1\npara two ^blk2", "utf8"));
      }
      expect(v.read("a.md")).toBe("# H\nREPLACED\n");
    } finally {
      v.cleanup();
    }
  });
});

describe("patch_note: preamble-anchor append/replace (patchByPreamble op branches)", () => {
  const raw = "---\nk: 1\n---\nintro line\n# One\nbody\n";

  it("append inserts just above the first heading", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        anchor: { type: "frontmatter" },
        content: "TAIL",
      });
      expect(r.ok).toBe(true);
      const out = v.read("a.md");
      expect(out).toContain("k: 1");
      expect(out).toContain("intro line\nTAIL\n# One");
    } finally {
      v.cleanup();
    }
  });

  it("replace discards the preamble body and reports what it removed", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        anchor: { type: "frontmatter" },
        content: "REPL",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { lines_removed: number };
        expect(d.lines_removed).toBe(1);
      }
      const out = v.read("a.md");
      expect(out).toContain("k: 1");
      expect(out).toContain("---\nREPL\n# One\nbody");
      expect(out).not.toContain("intro line");
    } finally {
      v.cleanup();
    }
  });
});

describe("patch_note: CRLF line endings are preserved through a patch", () => {
  it("preserves \\r\\n when the note already uses it", async () => {
    const raw = "# One\r\ncontent line\r\n# Two\r\nmore\r\n";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "One",
        content: "NEW",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("# One\r\ncontent line\r\nNEW\r\n# Two\r\nmore\r\n");
    } finally {
      v.cleanup();
    }
  });
});

describe("patch_note: missing note and stale prev_hash guards", () => {
  it("404s on a note that does not exist", async () => {
    const v = makeTestVault();
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "ghost.md",
        operation: "append",
        target_heading: "X",
        content: "y",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("stale prev_hash is concurrent_modification and leaves the note untouched", async () => {
    const raw = "# One\nbody\n";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "One",
        content: "y",
        prev_hash: "0".repeat(64),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
      expect(v.read("a.md")).toBe(raw);
    } finally {
      v.cleanup();
    }
  });
});

describe("write_note: folder target and overwrite-of-missing guards", () => {
  it("rejects writing to a path that is an existing folder", async () => {
    const v = makeTestVault({ files: { "dir/a.md": "x" } });
    try {
      const r = await v.call("write_note", { vault: "test", path: "dir", content: "y" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("mode:overwrite on a note that does not exist is note_not_found", async () => {
    const v = makeTestVault();
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "ghost.md",
        content: "y",
        mode: "overwrite",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });
});

describe("append_note: folder guard, stale prev_hash, and the no-separator path", () => {
  it("rejects appending to a path that is an existing folder", async () => {
    const v = makeTestVault({ files: { "dir/a.md": "x" } });
    try {
      const r = await v.call("append_note", { vault: "test", path: "dir", content: "y" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("stale prev_hash on an existing note is concurrent_modification", async () => {
    const v = makeTestVault({ files: { "a.md": "orig" } });
    try {
      const r = await v.call("append_note", {
        vault: "test",
        path: "a.md",
        content: "x",
        prev_hash: "0".repeat(64),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
      expect(v.read("a.md")).toBe("orig");
    } finally {
      v.cleanup();
    }
  });

  it("skips the newline separator when the note already ends in one", async () => {
    const v = makeTestVault({ files: { "a.md": "line1\n" } });
    try {
      const r = await v.call("append_note", { vault: "test", path: "a.md", content: "line2" });
      expect(r.ok).toBe(true);
      // no double newline -- the separator was correctly skipped, not just conditionally added
      expect(v.read("a.md")).toBe("line1\nline2");
    } finally {
      v.cleanup();
    }
  });
});

describe("delete_note: missing note, stale prev_hash, and snapshots-enabled (no skip signal)", () => {
  it("404s a missing note only after the destructive HITL gate is satisfied", async () => {
    const v = makeTestVault();
    try {
      const need = await v.call("delete_note", { vault: "test", path: "ghost.md" });
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = mint(v, "delete_note", hashOf(need));
      const r = await v.call(
        "delete_note",
        { vault: "test", path: "ghost.md" },
        { elicitToken: token },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("stale prev_hash is concurrent_modification and the note survives", async () => {
    const v = makeTestVault({ files: { "a.md": "content" } });
    try {
      const input = { vault: "test", path: "a.md", prev_hash: "0".repeat(64) };
      const need = await v.call("delete_note", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = mint(v, "delete_note", hashOf(need));
      const r = await v.call("delete_note", input, { elicitToken: token });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
      expect(v.exists("a.md")).toBe(true);
      expect(v.read("a.md")).toBe("content");
    } finally {
      v.cleanup();
    }
  });

  it("does not fire the snapshot-skip signal when snapshots are enabled", async () => {
    const skipped: Array<unknown> = [];
    const v = makeTestVault({
      files: { "a.md": "hello" },
      snapshots: { enabled: true, retention: 5 },
      onSnapshotSkipped: (...args) => skipped.push(args),
    });
    try {
      const need = await v.call("delete_note", { vault: "test", path: "a.md" });
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");
      const token = mint(v, "delete_note", hashOf(need));
      const r = await v.call(
        "delete_note",
        { vault: "test", path: "a.md" },
        { elicitToken: token },
      );
      expect(r.ok).toBe(true);
      expect(skipped).toEqual([]);
    } finally {
      v.cleanup();
    }
  });
});

describe("move_note: early guards and the update_backlinks:false opt-out", () => {
  it("rejects from === to before touching the filesystem", async () => {
    const v = makeTestVault({ files: { "a.md": "x" } });
    try {
      const r = await v.call("move_note", { vault: "test", from: "a.md", to: "a.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("404s a missing source note", async () => {
    const v = makeTestVault();
    try {
      const r = await v.call("move_note", { vault: "test", from: "ghost.md", to: "new.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("stale prev_hash is concurrent_modification for a same-folder rename (no confirmation reached)", async () => {
    const v = makeTestVault({ files: { "a.md": "data" } });
    try {
      const r = await v.call("move_note", {
        vault: "test",
        from: "a.md",
        to: "renamed.md",
        prev_hash: "0".repeat(64),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
      expect(v.exists("a.md")).toBe(true);
      expect(v.exists("renamed.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("update_backlinks:false leaves referencing notes untouched and reports zero updates", async () => {
    const v = makeTestVault({
      files: { "note.md": "x", "a.md": "see [[note]] here" },
    });
    try {
      const r = await v.call("move_note", {
        vault: "test",
        from: "note.md",
        to: "renamed.md",
        update_backlinks: false,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { backlinks_updated: { notes: number; links: number } };
        expect(d.backlinks_updated).toEqual({ notes: 0, links: 0 });
      }
      // the real behavioral guarantee: the caller's opt-out actually left the stale link alone.
      expect(v.read("a.md")).toBe("see [[note]] here");
    } finally {
      v.cleanup();
    }
  });

  it("an ambiguous destination basename rewrites via full path, and non-matching links/notes are left alone", async () => {
    const v = makeTestVault({
      files: {
        "target.md": "content",
        // pre-existing basename collision at the destination's eventual basename ("target").
        "other/target.md": "other content",
        "keep.md": "keep content",
        // one link that should rewrite (points at the moved note), one that should not.
        "a.md": "see [[target]] and [[keep]] here",
        // a note whose only link is unrelated -- rewriteLinks must report 0 matches for it.
        "b.md": "only [[keep]] here",
      },
    });
    try {
      const input = { vault: "test", from: "target.md", to: "renamed/target.md" };
      const need = await v.call("move_note", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = mint(v, "move_note", hashOf(need));
      const r = await v.call("move_note", input, { elicitToken: token });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { backlinks_updated: { notes: number; links: number } };
        // only a.md was rewritten (one matching link); b.md's unrelated link doesn't count.
        expect(d.backlinks_updated).toEqual({ notes: 1, links: 1 });
      }
      // basename "target" is now ambiguous (other/target.md vs renamed/target.md) -- the
      // rewrite must disambiguate with the full path, not the bare (now-ambiguous) basename.
      expect(v.read("a.md")).toBe("see [[renamed/target]] and [[keep]] here");
      // the unrelated link in b.md was never a candidate and must be untouched.
      expect(v.read("b.md")).toBe("only [[keep]] here");
    } finally {
      v.cleanup();
    }
  });
});

describe("copy_note: missing source guard", () => {
  it("404s a missing source note", async () => {
    const v = makeTestVault();
    try {
      const r = await v.call("copy_note", { vault: "test", from: "ghost.md", to: "new.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });
});

describe("list_notes: explicit folder argument and cursor-driven second page", () => {
  it("scopes results to the given folder", async () => {
    const v = makeTestVault({ files: { "sub/a.md": "1", "top.md": "2" } });
    try {
      const r = await v.call("list_notes", { vault: "test", folder: "sub" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { folder: string; notes: Array<{ path: string }> };
        expect(d.folder).toBe("sub");
        expect(d.notes.map((n) => n.path)).toEqual(["sub/a.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("a cursor from page one fetches page two", async () => {
    const v = makeTestVault({
      files: { "pub/a.md": "1", "pub/b.md": "2", "pub/c.md": "3" },
      acl: { readPaths: ["pub/**"] },
    });
    try {
      const page1 = await v.call("list_notes", { vault: "test", limit: 1 });
      expect(page1.ok).toBe(true);
      const cursor = page1.ok ? (page1.data as { next_cursor: string | null }).next_cursor : null;
      expect(cursor).toBe("pub/a.md");

      const page2 = await v.call("list_notes", {
        vault: "test",
        limit: 1,
        cursor: cursor as string,
      });
      expect(page2.ok).toBe(true);
      if (page2.ok) {
        const d = page2.data as { notes: Array<{ path: string }>; next_cursor: string | null };
        expect(d.notes.map((n) => n.path)).toEqual(["pub/b.md"]);
        expect(d.next_cursor).toBe("pub/b.md");
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("read_notes: a non-ObsidianTcError failure reports internal_error, not a swallowed crash", () => {
  // openSync raises a plain EACCES Error (not an ObsidianTcError) for a permission-denied
  // file; the handler's catch must fall through to "internal_error" rather than mis-typing it.
  // Skipped for root, which ignores file-mode permission bits entirely (chmod 000 wouldn't
  // deny anything), which would make this test meaningless rather than false-negative.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.skipIf(isRoot)(
    "a permission-denied file surfaces as internal_error alongside normal successes",
    async () => {
      const v = makeTestVault({ files: { "ok.md": "fine", "locked.md": "secret" } });
      try {
        chmodSync(`${v.root}/locked.md`, 0o000);
        const r = await v.call("read_notes", {
          vault: "test",
          paths: ["ok.md", "locked.md"],
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as {
            notes: Array<{ path: string }>;
            errors: Array<{ path: string; code: string }>;
          };
          expect(d.notes.map((n) => n.path)).toEqual(["ok.md"]);
          expect(d.errors).toEqual([
            { path: "locked.md", code: "internal_error", message: expect.any(String) },
          ]);
        }
      } finally {
        chmodSync(`${v.root}/locked.md`, 0o644);
        v.cleanup();
      }
    },
  );
});
