// THE-281 — query_base integration over a real-syntax .base fixture.
import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

const REAL_BASE = `filters: file.hasTag("project")
formulas:
  shout: note.status.upper()
views:
  - name: V
    type: table
`;

describe("query_base with the Bases DSL subset (THE-281)", () => {
  it("top-level string filters select the note set; string formulas compute columns", async () => {
    const v = makeM3Vault({
      files: {
        "real.base": REAL_BASE,
        "t1.md": "---\ntags: [project]\nstatus: active\n---\nx",
        "t2.md": "---\nstatus: idle\n---\ny",
      },
    });
    try {
      const q = await v.call("query_base", { vault: "test", path: "real.base" });
      expect(q.ok).toBe(true);
      if (q.ok) {
        const d = q.data as {
          items: Array<{ note_path: string; columns: Record<string, unknown> }>;
        };
        expect(d.items.map((i) => i.note_path)).toEqual(["t1.md"]);
        expect(d.items[0]?.columns.shout).toBe("ACTIVE");
      }
    } finally {
      v.cleanup();
    }
  });

  it("string override_filters narrow further; unsupported constructs refuse typed", async () => {
    const v = makeM3Vault({
      files: {
        "real.base": REAL_BASE,
        "t1.md": "---\ntags: [project]\nstatus: active\n---\nx",
        "t3.md": "---\ntags: [project]\nstatus: done\n---\nz",
      },
    });
    try {
      const q = await v.call("query_base", {
        vault: "test",
        path: "real.base",
        override_filters: 'note.status == "active"',
      });
      expect(q.ok).toBe(true);
      if (q.ok) {
        const d = q.data as { items: Array<{ note_path: string }> };
        expect(d.items.map((i) => i.note_path)).toEqual(["t1.md"]);
      }
      const bad = await v.call("query_base", {
        vault: "test",
        path: "real.base",
        override_filters: "aliases.map(value)",
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("unsupported_base_filter");
    } finally {
      v.cleanup();
    }
  });

  it("a mixed DSL/JSONLogic tree still refuses with the same typed code", async () => {
    const v = makeM3Vault({
      files: {
        "mixed.base":
          'filters:\n  and:\n    - status == "active"\n    - "==":\n        - var: status\n        - active\nviews:\n  - name: V\n    type: table\n',
        "t1.md": "---\nstatus: active\n---\nx",
      },
    });
    try {
      const q = await v.call("query_base", { vault: "test", path: "mixed.base" });
      expect(q.ok).toBe(false);
      if (!q.ok) expect(q.error.code).toBe("unsupported_base_filter");
    } finally {
      v.cleanup();
    }
  });
});
