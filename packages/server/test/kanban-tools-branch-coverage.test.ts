// THE-602 branch-coverage additions for src/tools/m3/kanban-tools.ts. Each test asserts real
// caller-visible behavior (a thrown error's code, a returned/re-read value, or a written file's
// bytes) rather than merely executing a branch. See PR/ticket for the branch-id map this file was
// built against.
import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

const BOARD =
  '---\nkanban-plugin: board\n---\n\n## To Do\n\n- [ ] Task A\n- [ ] Task B\n\n## Done\n\n- [x] Task C\n\n\n%% kanban:settings\n{"kanban-plugin":"board"}\n%%\n';

// Has an empty column ("Empty", zero cards -> exercises insertLine's heading-only fallback) and a
// "Notes" column mixing a non-list paragraph with a bare (checkbox-less) list item.
const RICH_BOARD =
  "---\nkanban-plugin: board\n---\n\n" +
  "## To Do\n\n- [ ] Task A\n\n" +
  "## Empty\n\n" +
  "## Notes\n\nJust a paragraph, not a card\n- bare item without checkbox\n\n" +
  '%% kanban:settings\n{"kanban-plugin":"board"}\n%%\n';

const CRLF_BOARD =
  '---\r\nkanban-plugin: board\r\n---\r\n\r\n## To Do\r\n\r\n- [ ] Task A\r\n\r\n## Done\r\n\r\n- [x] Task C\r\n\r\n%% kanban:settings\r\n{"kanban-plugin":"board"}\r\n%%\r\n';

describe("THE-602 kanban-tools branch coverage", () => {
  it("list_kanban_boards with a folder filter scopes results to that subfolder", async () => {
    const v = makeM3Vault({ files: { "sub/b.md": BOARD, "other.md": BOARD } });
    try {
      const r = await v.call("list_kanban_boards", { vault: "test", folder: "sub" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { total: number; boards: Array<{ path: string }> };
        expect(d.total).toBe(1);
        expect(d.boards[0]?.path).toBe("sub/b.md");
      }
    } finally {
      v.cleanup();
    }
  });

  it("read_kanban_board on a missing path throws note_not_found", async () => {
    const v = makeM3Vault({ files: {} });
    try {
      const r = await v.call("read_kanban_board", { vault: "test", path: "missing.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("read_kanban_board treats a bare list item without a checkbox as unchecked", async () => {
    const v = makeM3Vault({ files: { "b.md": RICH_BOARD } });
    try {
      const r = await v.call("read_kanban_board", { vault: "test", path: "b.md" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          columns: Array<{ name: string; cards: Array<{ text: string; checked: boolean }> }>;
        };
        const notes = d.columns.find((c) => c.name === "Notes");
        expect(notes?.cards.map((c) => c.text)).toEqual(["bare item without checkbox"]);
        expect(notes?.cards[0]?.checked).toBe(false);
      }
    } finally {
      v.cleanup();
    }
  });

  it("read_kanban_board ignores non-list paragraph text under a column", async () => {
    const v = makeM3Vault({ files: { "b.md": RICH_BOARD } });
    try {
      const r = await v.call("read_kanban_board", { vault: "test", path: "b.md" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          columns: Array<{ name: string; cards: Array<{ text: string }> }>;
        };
        const notes = d.columns.find((c) => c.name === "Notes");
        // Only the real (dash-prefixed) list item counts as a card; the free paragraph line
        // above it must not appear.
        expect(notes?.cards).toHaveLength(1);
        expect(notes?.cards.some((c) => c.text.includes("Just a paragraph"))).toBe(false);
      }
    } finally {
      v.cleanup();
    }
  });

  it("add_kanban_card on a missing path throws note_not_found", async () => {
    const v = makeM3Vault({ files: {} });
    try {
      const r = await v.call("add_kanban_card", {
        vault: "test",
        path: "missing.md",
        column: "To Do",
        text: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("add_kanban_card with a mismatched prev_hash throws concurrent_modification", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD } });
    try {
      const r = await v.call("add_kanban_card", {
        vault: "test",
        path: "b.md",
        column: "To Do",
        text: "x",
        prev_hash: "not-the-real-hash",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
      // And the file must be untouched.
      expect(v.read("b.md")).toBe(BOARD);
    } finally {
      v.cleanup();
    }
  });

  it("add_kanban_card with a matching prev_hash succeeds", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD } });
    try {
      const before = await v.call("read_kanban_board", { vault: "test", path: "b.md" });
      expect(before.ok).toBe(true);
      const hash = before.ok ? (before.data as { content_hash: string }).content_hash : "";
      const r = await v.call("add_kanban_card", {
        vault: "test",
        path: "b.md",
        column: "To Do",
        text: "Task Z",
        prev_hash: hash,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { added: string }).added).toBe("Task Z");
    } finally {
      v.cleanup();
    }
  });

  it("add_kanban_card on a non-board note throws invalid_input", async () => {
    const v = makeM3Vault({ files: { "plain.md": "# not a board\n" } });
    try {
      const r = await v.call("add_kanban_card", {
        vault: "test",
        path: "plain.md",
        column: "To Do",
        text: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("add_kanban_card preserves CRLF line endings when the board uses them", async () => {
    const v = makeM3Vault({ files: { "b.md": CRLF_BOARD } });
    try {
      const r = await v.call("add_kanban_card", {
        vault: "test",
        path: "b.md",
        column: "To Do",
        text: "Task Z",
      });
      expect(r.ok).toBe(true);
      const content = v.read("b.md");
      expect(content).toMatch(/\r\n- \[ \] Task Z\r\n/);
    } finally {
      v.cleanup();
    }
  });

  it("add_kanban_card to an unknown column throws invalid_input", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD } });
    try {
      const r = await v.call("add_kanban_card", {
        vault: "test",
        path: "b.md",
        column: "Nope",
        text: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("add_kanban_card with checked: true writes a checked checkbox", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD } });
    try {
      const r = await v.call("add_kanban_card", {
        vault: "test",
        path: "b.md",
        column: "To Do",
        text: "Task Z",
        checked: true,
      });
      expect(r.ok).toBe(true);
      expect(v.read("b.md")).toContain("- [x] Task Z");
      const read = await v.call("read_kanban_board", { vault: "test", path: "b.md" });
      if (read.ok) {
        const d = read.data as {
          columns: Array<{ cards: Array<{ text: string; checked: boolean }> }>;
        };
        const card = d.columns[0]?.cards.find((c) => c.text === "Task Z");
        expect(card?.checked).toBe(true);
      }
    } finally {
      v.cleanup();
    }
  });

  it("add_kanban_card into an empty column inserts right after the heading", async () => {
    const v = makeM3Vault({ files: { "b.md": RICH_BOARD } });
    try {
      const r = await v.call("add_kanban_card", {
        vault: "test",
        path: "b.md",
        column: "Empty",
        text: "First one",
      });
      expect(r.ok).toBe(true);
      const read = await v.call("read_kanban_board", { vault: "test", path: "b.md" });
      expect(read.ok).toBe(true);
      if (read.ok) {
        const d = read.data as { columns: Array<{ name: string; cards: Array<{ text: string }> }> };
        const empty = d.columns.find((c) => c.name === "Empty");
        expect(empty?.cards.map((c) => c.text)).toEqual(["First one"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("move_kanban_card on a missing path throws note_not_found", async () => {
    const v = makeM3Vault({ files: {} });
    try {
      const r = await v.call("move_kanban_card", {
        vault: "test",
        path: "missing.md",
        from_column: "To Do",
        to_column: "Done",
        card_text: "Task A",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("move_kanban_card with a mismatched prev_hash throws concurrent_modification", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD } });
    try {
      const r = await v.call("move_kanban_card", {
        vault: "test",
        path: "b.md",
        from_column: "To Do",
        to_column: "Done",
        card_text: "Task A",
        prev_hash: "not-the-real-hash",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
      expect(v.read("b.md")).toBe(BOARD);
    } finally {
      v.cleanup();
    }
  });

  it("move_kanban_card with a matching prev_hash succeeds", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD } });
    try {
      const before = await v.call("read_kanban_board", { vault: "test", path: "b.md" });
      const hash = before.ok ? (before.data as { content_hash: string }).content_hash : "";
      const r = await v.call("move_kanban_card", {
        vault: "test",
        path: "b.md",
        from_column: "To Do",
        to_column: "Done",
        card_text: "Task A",
        prev_hash: hash,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { moved: string }).moved).toBe("Task A");
    } finally {
      v.cleanup();
    }
  });

  it("move_kanban_card on a non-board note throws invalid_input", async () => {
    const v = makeM3Vault({ files: { "plain.md": "# not a board\n" } });
    try {
      const r = await v.call("move_kanban_card", {
        vault: "test",
        path: "plain.md",
        from_column: "To Do",
        to_column: "Done",
        card_text: "Task A",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("move_kanban_card preserves CRLF line endings when the board uses them", async () => {
    const v = makeM3Vault({ files: { "b.md": CRLF_BOARD } });
    try {
      const r = await v.call("move_kanban_card", {
        vault: "test",
        path: "b.md",
        from_column: "To Do",
        to_column: "Done",
        card_text: "Task A",
      });
      expect(r.ok).toBe(true);
      const content = v.read("b.md");
      expect(content).toMatch(/\r\n- \[ \] Task A\r\n/);
    } finally {
      v.cleanup();
    }
  });

  it("move_kanban_card with an unknown from_column throws invalid_input", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD } });
    try {
      const r = await v.call("move_kanban_card", {
        vault: "test",
        path: "b.md",
        from_column: "Nope",
        to_column: "Done",
        card_text: "Task A",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("move_kanban_card with a card not present in from_column throws invalid_input", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD } });
    try {
      const r = await v.call("move_kanban_card", {
        vault: "test",
        path: "b.md",
        from_column: "To Do",
        to_column: "Done",
        card_text: "No Such Task",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("move_kanban_card with an unknown to_column throws invalid_input", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD } });
    try {
      const r = await v.call("move_kanban_card", {
        vault: "test",
        path: "b.md",
        from_column: "To Do",
        to_column: "Nope",
        card_text: "Task A",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});
