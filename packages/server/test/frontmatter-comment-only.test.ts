// THE-1040 (GH #932 review origin): a frontmatter block containing only YAML comments
// parses to an empty mapping ({}), same as a genuinely blank block — before the fix,
// serializeNote read the empty MAPPING and dropped the block on every write that went
// through it, discarding the comments. Proven here at the tool level, through the
// actual write paths a caller uses, not just unit tests on frontmatter.ts's internals.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeTestVault } from "./m1-helpers";

// write_note overwriting a non-empty note requires HITL confirmation (THE-603) — mirrors the
// hashOf/mint pattern in notes-tools.test.ts.
function hashOf(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return String((r.error.details as { args_hash?: string }).args_hash);
}
function mint(v: ReturnType<typeof makeTestVault>, toolName: string, argsHash: string): string {
  return issueElicitToken(v.db, { vaultId: v.id, toolName, argsHash, caller: "test" });
}

// The exact repro from the ticket.
const TICKET_NOTE = "---\n# preserve me\n---\n## A\nold\n";
const BLOCK = "---\n# preserve me\n---\n";

describe("THE-1040: comment-only frontmatter block survives every write", () => {
  it("patch_note append keeps the block", async () => {
    const v = makeTestVault({ files: { "a.md": TICKET_NOTE } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        anchor: { type: "heading", heading: "A" },
        content: "new",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md").startsWith(BLOCK)).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("patch_note prepend keeps the block", async () => {
    const v = makeTestVault({ files: { "a.md": TICKET_NOTE } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "prepend",
        anchor: { type: "heading", heading: "A" },
        content: "new",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md").startsWith(BLOCK)).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("patch_note replace keeps the block", async () => {
    const v = makeTestVault({ files: { "a.md": TICKET_NOTE } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        anchor: { type: "heading", heading: "A" },
        content: "## A\nreplaced",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md").startsWith(BLOCK)).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("patch_note replace_text keeps the block", async () => {
    const v = makeTestVault({ files: { "a.md": TICKET_NOTE } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        anchor: { type: "heading", heading: "A" },
        old_string: "old",
        new_string: "new",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md").startsWith(BLOCK)).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("append_note keeps the block", async () => {
    const v = makeTestVault({ files: { "a.md": TICKET_NOTE } });
    try {
      const r = await v.call("append_note", { vault: "test", path: "a.md", content: "more" });
      expect(r.ok).toBe(true);
      expect(v.read("a.md").startsWith(BLOCK)).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  // write_note has no "update" WriteMode (WriteInput: create | overwrite | upsert) — upsert
  // on an existing note is the closest thing to one. Unlike patch_note/append_note, write_note
  // never parses the note back through serializeNote: input.content replaces the file verbatim,
  // so it was never the THE-1040 defect's path. Asserted here anyway (per the brief) to confirm
  // it stays a faithful pass-through: the comment-only block survives because the caller's
  // content string carries it, not because write_note preserves anything on its own.
  it("write_note mode:upsert keeps the block when the caller's content includes it", async () => {
    const v = makeTestVault({ files: { "a.md": TICKET_NOTE } });
    try {
      const input = {
        vault: "test",
        path: "a.md",
        content: `${TICKET_NOTE}more\n`,
        mode: "upsert" as const,
      };
      const need = await v.call("write_note", input);
      expect(need.ok).toBe(false);
      const token = mint(v, "write_note", hashOf(need));
      const r = await v.call("write_note", input, { elicitToken: token });
      expect(r.ok).toBe(true);
      expect(v.read("a.md").startsWith(BLOCK)).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});

// THE-1040 F1: update_frontmatter/remove_tag pass an explicit `null` frontmatter once the
// last real key is gone — that must not silently discard a comment the block still carries.
describe("THE-1040 F1: a surviving comment is kept when the last real key is removed", () => {
  it("update_frontmatter remove keeps the comment", async () => {
    const v = makeTestVault({ files: { "a.md": "---\n# keep me\nonly: 1\n---\nbody\n" } });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "remove",
        key: "only",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("---\n# keep me\n---\nbody\n");
    } finally {
      v.cleanup();
    }
  });

  it("remove_tag keeps the comment once the only tag is gone", async () => {
    const v = makeTestVault({ files: { "a.md": "---\n# keep me\ntags: [x]\n---\nbody\n" } });
    try {
      const r = await v.call("remove_tag", { vault: "test", path: "a.md", tag: "x" });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("---\n# keep me\n---\nbody\n");
    } finally {
      v.cleanup();
    }
  });
});

// THE-1040 O1 (fix round 2): an INLINE trailing comment belongs to its key and goes with
// it when the key is removed — only a full-line comment (or a blank line) can survive.
describe("THE-1040 O1: an inline comment does not orphan when its key is removed", () => {
  it("update_frontmatter remove drops the key's own inline comment but keeps a standalone one", async () => {
    const v = makeTestVault({
      files: { "a.md": "---\n# keep me\nonly: 1 # inline, goes with only\n---\nbody\n" },
    });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "remove",
        key: "only",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("---\n# keep me\n---\nbody\n");
    } finally {
      v.cleanup();
    }
  });
});

// THE-1040 C1: the delimiter EOL comes from the OPENING "---"'s own line break, captured
// at parse time — not inferred from the YAML content or the body, which can each carry a
// different (or no) line-break signal of their own.
describe("THE-1040 C1: delimiter EOL follows the note's own opening delimiter", () => {
  it("an LF frontmatter block keeps LF delimiters even when the body is CRLF", async () => {
    const raw = "---\ntitle: Test\nzip: 01234\n---\n## A\r\nold\r\n";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        anchor: { type: "heading", heading: "A" },
        content: "new",
      });
      expect(r.ok).toBe(true);
      const out = v.read("a.md");
      expect(out.startsWith("---\ntitle: Test\nzip: 01234\n---\n")).toBe(true);
      expect(out).not.toContain("---\r\n");
    } finally {
      v.cleanup();
    }
  });

  it("a single-line CRLF frontmatter block keeps CRLF delimiters (no body/YAML \\r\\n to fall back on)", async () => {
    const raw = "---\r\ntitle: Test\r\n---\r\nold";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        anchor: { type: "frontmatter" },
        old_string: "old",
        new_string: "new",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("---\r\ntitle: Test\r\n---\r\nnew");
    } finally {
      v.cleanup();
    }
  });
});

// THE-1040 S1 (fix round 3): an unchanged key's INLINE trailing comment must survive when
// a SIBLING key changes — emitFrontmatter used to splice an unchanged key back from just its
// own AST node range, which never included the comment.
describe("THE-1040 S1: an unchanged key's inline comment survives a sibling's change", () => {
  it("update_frontmatter set on one key keeps another key's inline comment", async () => {
    const v = makeTestVault({
      files: { "a.md": "---\na: 1\nb: 2 # keep this comment\n---\nbody\n" },
    });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "set",
        key: "a",
        value: 9,
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("---\na: 9\nb: 2 # keep this comment\n---\nbody\n");
    } finally {
      v.cleanup();
    }
  });
});
