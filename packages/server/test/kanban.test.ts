import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

const BOARD =
  '---\nkanban-plugin: board\n---\n\n## To Do\n\n- [ ] Task A\n- [ ] Task B\n\n## Done\n\n- [x] Task C\n\n\n%% kanban:settings\n{"kanban-plugin":"board"}\n%%\n';

describe("THE-379 Kanban board tools", () => {
  it("read_kanban_board parses columns + cards; non-board errors", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD, "plain.md": "# not a board" } });
    try {
      const r = await v.call("read_kanban_board", { vault: "test", path: "b.md" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          columns: Array<{ name: string; cards: Array<{ text: string; checked: boolean }> }>;
        };
        expect(d.columns.map((c) => c.name)).toEqual(["To Do", "Done"]);
        expect(d.columns[0]?.cards.map((c) => c.text)).toEqual(["Task A", "Task B"]);
        expect(d.columns[1]?.cards[0]?.checked).toBe(true);
      }
      const bad = await v.call("read_kanban_board", { vault: "test", path: "plain.md" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("list_kanban_boards finds boards with counts", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD, "plain.md": "# nope" } });
    try {
      const r = await v.call("list_kanban_boards", { vault: "test" });
      if (r.ok) {
        const d = r.data as {
          total: number;
          boards: Array<{ path: string; columns: number; cards: number }>;
        };
        expect(d.total).toBe(1);
        expect(d.boards[0]?.columns).toBe(2);
        expect(d.boards[0]?.cards).toBe(3);
      }
    } finally {
      v.cleanup();
    }
  });

  it("add_kanban_card appends under the named column", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD } });
    try {
      const r = await v.call("add_kanban_card", {
        vault: "test",
        path: "b.md",
        column: "To Do",
        text: "Task D",
      });
      expect(r.ok).toBe(true);
      const read = await v.call("read_kanban_board", { vault: "test", path: "b.md" });
      if (read.ok) {
        const d = read.data as { columns: Array<{ name: string; cards: Array<{ text: string }> }> };
        expect(d.columns[0]?.cards.map((c) => c.text)).toContain("Task D");
      }
    } finally {
      v.cleanup();
    }
  });

  it("move_kanban_card moves a card between columns preserving order", async () => {
    const v = makeM3Vault({ files: { "b.md": BOARD } });
    try {
      const r = await v.call("move_kanban_card", {
        vault: "test",
        path: "b.md",
        from_column: "To Do",
        to_column: "Done",
        card_text: "Task A",
      });
      expect(r.ok).toBe(true);
      const read = await v.call("read_kanban_board", { vault: "test", path: "b.md" });
      if (read.ok) {
        const d = read.data as { columns: Array<{ name: string; cards: Array<{ text: string }> }> };
        expect(d.columns[0]?.cards.map((c) => c.text)).toEqual(["Task B"]);
        expect(d.columns[1]?.cards.map((c) => c.text)).toContain("Task A");
      }
    } finally {
      v.cleanup();
    }
  });
});
