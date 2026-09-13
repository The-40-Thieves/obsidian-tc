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
