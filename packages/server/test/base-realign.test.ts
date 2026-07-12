// THE-280 — real Bases view keys honored; aliases deprecated.
import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

const REAL_BASE = `filters: file.hasTag("t")
formulas:
  shout: note.status.upper()
views:
  - name: V
    type: table
    order:
      - file.name
      - note.status
      - formula.shout
    sort:
      - property: note.status
        direction: DESC
    limit: 2
    groupBy:
      property: note.status
      direction: DESC
`;

const FILES = {
  "real.base": REAL_BASE,
  "a.md": "---\ntags: [t]\nstatus: alpha\n---\nx",
  "b.md": "---\ntags: [t]\nstatus: zeta\n---\ny",
  "c.md": "---\ntags: [t]\nstatus: mid\n---\nz",
  "skip.md": "---\nstatus: zeta\n---\nq",
};

describe("query_base honors real Bases view keys (THE-280)", () => {
  it("order projects namespaced ids, sort DESC orders, limit caps, groupBy attaches group", async () => {
    const v = makeM3Vault({ files: FILES });
    try {
      const q = await v.call("query_base", { vault: "test", path: "real.base" });
      expect(q.ok).toBe(true);
      if (q.ok) {
        const d = q.data as {
          total: number;
          items: Array<{ note_path: string; columns: Record<string, unknown>; group?: unknown }>;
        };
        // limit: 2 caps the result set (3 tagged notes).
        expect(d.total).toBe(2);
        // sort note.status DESC -> zeta, mid (alpha dropped by the limit).
        expect(d.items.map((i) => i.note_path)).toEqual(["b.md", "c.md"]);
        // order projection resolves namespaced ids, incl. formula.*.
        expect(d.items[0]?.columns["file.name"]).toBe("b");
        expect(d.items[0]?.columns["note.status"]).toBe("zeta");
        expect(d.items[0]?.columns["formula.shout"]).toBe("ZETA");
        // groupBy attaches the additive group key.
        expect(d.items[0]?.group).toBe("zeta");
      }
    } finally {
      v.cleanup();
    }
  });

  it("the deprecated columns alias wins over order in v1.x", async () => {
    const v = makeM3Vault({
      files: {
        "both.base":
          'filters: file.hasTag("t")\nviews:\n  - name: V\n    type: table\n    columns:\n      - status\n    order:\n      - file.name\n',
        "a.md": "---\ntags: [t]\nstatus: alpha\n---\nx",
      },
    });
    try {
      const q = await v.call("query_base", { vault: "test", path: "both.base" });
      expect(q.ok).toBe(true);
      if (q.ok) {
        const d = q.data as { items: Array<{ columns: Record<string, unknown> }> };
        expect(Object.keys(d.items[0]?.columns ?? {})).toEqual(["status"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("update_base patch.filters is applied and HITL-gated; create_base surfaces deprecations", async () => {
    const v = makeM3Vault({ files: { "e.base": "views:\n  - name: V\n    type: table\n" } });
    try {
      const input = {
        vault: "test",
        path: "e.base",
        patch: { filters: 'file.hasTag("x")' },
      };
      const denied = await v.call("update_base", input);
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("elicit_required");
      const ok = await v.callConfirmed("update_base", input);
      expect(ok.ok).toBe(true);
      const r = await v.call("read_base", { vault: "test", path: "e.base" });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect((r.data as { base: { filters?: unknown } }).base.filters).toBe('file.hasTag("x")');

      const c = await v.call("create_base", {
        vault: "test",
        path: "legacy.base",
        base: {
          source: { type: "tag", value: "x" },
          views: [{ name: "V", type: "table", columns: ["status"], group: "status" }],
        },
      });
      expect(c.ok).toBe(true);
      if (c.ok) {
        const deps = (c.data as { deprecations?: string[] }).deprecations ?? [];
        expect(deps.length).toBe(3);
        expect(deps.join(" ")).toContain("v2.0");
      }
    } finally {
      v.cleanup();
    }
  });
});
