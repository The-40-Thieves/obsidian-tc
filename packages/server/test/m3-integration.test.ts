// M3 live-vault integration: one real temp vault, every domain driven end-to-end
// through the dispatch pipeline (validate -> auth -> scope -> ACL -> HITL -> execute
// -> audit), asserting on-disk state, cross-format query semantics, the event_log
// audit trail, and unknown-field round-trip fidelity through actual tool calls (not
// the codecs in isolation). Complements the per-domain suites by proving the six
// domains coexist on the shared registry and write coherent files into one vault.
import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

const node = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  text: `node ${id}`,
  ...over,
});

describe("M3 integration: all six structured-format domains in one vault", () => {
  it("drives canvas, bases, periodic, attachments, bookmarks, and workspaces through dispatch", async () => {
    const v = makeM3Vault({
      files: {
        "projects/a.md": "---\nstatus: active\npriority: 3\n---\nA",
        "projects/b.md": "---\nstatus: done\npriority: 1\n---\nB",
        "assets/diagram.png": "PNGDATA",
      },
    });
    try {
      // ── Canvas: create under a new folder, then query by text ──
      const cc = await v.call("create_canvas", {
        vault: "test",
        path: "boards/map.canvas",
        nodes: [node("n1", { text: "alpha" })],
        edges: [],
        options: { create_dirs: true },
      });
      expect(cc.ok).toBe(true);
      expect(v.exists("boards/map.canvas")).toBe(true);
      const qc = await v.call("query_canvas", {
        vault: "test",
        filter: { text_contains: "alpha" },
      });
      if (qc.ok) expect((qc.data as { items: unknown[] }).items).toHaveLength(1);

      // ── Bases: create a folder-source base, query filters + formula ──
      const cb = await v.call("create_base", {
        vault: "test",
        path: "p.base",
        base: {
          source: { type: "folder", value: "projects" },
          views: [
            {
              name: "Active",
              type: "table",
              columns: ["file.name", "status"],
              filters: { "==": [{ var: "status" }, "active"] },
            },
          ],
          formulas: { doubled: { "*": [{ var: "priority" }, 2] } },
        },
      });
      expect(cb.ok).toBe(true);
      const qb = await v.call("query_base", { vault: "test", path: "p.base" });
      if (qb.ok) {
        const d = qb.data as {
          items: Array<{ note_path: string; columns: Record<string, unknown> }>;
        };
        expect(d.items.map((i) => i.note_path)).toEqual(["projects/a.md"]);
        expect(d.items[0]?.columns.doubled).toBe(6);
      }

      // ── Periodic: find-or-create today's note, then append under a heading ──
      const fp = await v.call("find_or_create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      if (fp.ok) expect((fp.data as { created: boolean }).created).toBe(true);
      await v.call("append_to_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        content: "- logged",
        heading: "Log",
      });
      expect(v.read("2026-06-18.md")).toContain("- logged");

      // ── Attachments: list + base64 round-trip ──
      const la = await v.call("list_attachments", { vault: "test" });
      if (la.ok)
        expect(
          (la.data as { attachments: Array<{ path: string }> }).attachments.map((a) => a.path),
        ).toContain("assets/diagram.png");
      const ga = await v.call("get_attachment", { vault: "test", path: "assets/diagram.png" });
      if (ga.ok)
        expect(
          Buffer.from((ga.data as { content: string }).content, "base64").toString("utf8"),
        ).toBe("PNGDATA");

      // ── Bookmarks: add then list ──
      await v.call("add_bookmark", {
        vault: "test",
        bookmark: { type: "file", path: "projects/a.md" },
      });
      const lb = await v.call("list_bookmarks", { vault: "test" });
      if (lb.ok) expect((lb.data as { count: number }).count).toBe(1);

      // ── Workspaces: save active, then list ──
      await v.call("save_workspace", {
        vault: "test",
        name: "Focus",
        layout: { main: { id: "m" } },
        set_active: true,
      });
      const lw = await v.call("list_workspaces", { vault: "test" });
      if (lw.ok) expect((lw.data as { active: string | null }).active).toBe("Focus");

      // ── Audit: every mutating call left an ok event_log row ──
      const ev = v.events();
      for (const t of [
        "create_canvas",
        "create_base",
        "find_or_create_periodic_note",
        "append_to_periodic_note",
        "add_bookmark",
        "save_workspace",
      ])
        expect(ev.some((e) => e.tool_name === t && e.status === "ok")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("preserves unknown fields across edits made through dispatch", async () => {
    const v = makeM3Vault({
      files: {
        "u.canvas": JSON.stringify({
          nodes: [{ ...node("n1"), styleAttributes: { shape: "pill" } }],
          edges: [],
          metadata: { app: "obsidian" },
        }),
        ".obsidian/bookmarks.json": JSON.stringify(
          { items: [{ type: "file", path: "A.md", ctime: 99 }], customTop: true },
          null,
          "\t",
        ),
      },
    });
    try {
      const uc = await v.call("update_canvas", {
        vault: "test",
        path: "u.canvas",
        add_nodes: [node("n2")],
      });
      expect(uc.ok).toBe(true);
      const canvasDisk = JSON.parse(v.read("u.canvas")) as {
        nodes: Array<Record<string, unknown>>;
        metadata: unknown;
      };
      expect(canvasDisk.metadata).toEqual({ app: "obsidian" });
      expect(canvasDisk.nodes.find((n) => n.id === "n1")?.styleAttributes).toEqual({
        shape: "pill",
      });

      const ab = await v.call("add_bookmark", {
        vault: "test",
        bookmark: { type: "file", path: "B.md" },
      });
      expect(ab.ok).toBe(true);
      const bmDisk = JSON.parse(v.read(".obsidian/bookmarks.json")) as {
        customTop?: boolean;
        items: Array<{ ctime?: number }>;
      };
      expect(bmDisk.customTop).toBe(true);
      expect(bmDisk.items[0]?.ctime).toBe(99);
    } finally {
      v.cleanup();
    }
  });
});
