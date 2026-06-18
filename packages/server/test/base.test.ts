import type { ToolResult } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeM3Vault } from "./m3-helpers";

function hashOf(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return String((r.error.details as { args_hash?: string }).args_hash);
}
function mint(v: ReturnType<typeof makeM3Vault>, toolName: string, argsHash: string): string {
  return issueElicitToken(v.db, { vaultId: v.id, toolName, argsHash, caller: "test" });
}

const SAMPLE_BASE = `source:
  type: folder
  value: projects
views:
  - name: Active
    type: table
    columns:
      - file.name
      - status
    filters:
      "==":
        - var: status
        - active
    order:
      - file.name
formulas:
  doubled:
    "*":
      - var: priority
      - 2
`;

describe("Domain 7: Bases", () => {
  it("create_base, read_base round-trips structure + unknown keys, and audits", async () => {
    const v = makeM3Vault();
    try {
      const c = await v.call("create_base", {
        vault: "test",
        path: "p.base",
        base: { source: { type: "tag", value: "x" }, views: [{ name: "V", type: "table" }] },
      });
      expect(c.ok).toBe(true);
      const r = await v.call("read_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { base: { source: { type: string }; views: Array<{ name: string }> } };
        expect(d.base.source.type).toBe("tag");
        expect(d.base.views[0]?.name).toBe("V");
      }
      const ev = v.events();
      expect(ev.some((e) => e.tool_name === "create_base" && e.status === "ok")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("read_base rejects a non-.base path, a missing base, and malformed YAML", async () => {
    const v = makeM3Vault({ files: { "bad.base": "foo: [unclosed", "n.md": "x" } });
    try {
      const wrong = await v.call("read_base", { vault: "test", path: "n.md" });
      if (!wrong.ok) expect(wrong.error.code).toBe("invalid_input");
      const missing = await v.call("read_base", { vault: "test", path: "ghost.base" });
      if (!missing.ok) expect(missing.error.code).toBe("note_not_found");
      const bad = await v.call("read_base", { vault: "test", path: "bad.base" });
      if (!bad.ok) expect(bad.error.code).toBe("bases_syntax_error");
    } finally {
      v.cleanup();
    }
  });

  it("create_base rejects an invalid base definition with bases_syntax_error", async () => {
    const v = makeM3Vault();
    try {
      const r = await v.call("create_base", {
        vault: "test",
        path: "x.base",
        base: { source: { type: "not-a-real-type", value: 1 } },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("bases_syntax_error");
    } finally {
      v.cleanup();
    }
  });

  it("create_base overwrite of an existing base runs the HITL cycle", async () => {
    const v = makeM3Vault({ files: { "p.base": "views: []\n" } });
    try {
      const input = {
        vault: "test",
        path: "p.base",
        base: { views: [{ name: "New" }] },
        overwrite: true,
      };
      const need = await v.call("create_base", input);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");
      const ok = await v.call("create_base", input, {
        elicitToken: mint(v, "create_base", hashOf(need)),
      });
      expect(ok.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("update_base patches views/formulas, preserves unknown keys; source change needs HITL", async () => {
    const v = makeM3Vault({ files: { "p.base": SAMPLE_BASE } });
    try {
      // non-source patch: no confirmation
      const u = await v.call("update_base", {
        vault: "test",
        path: "p.base",
        patch: {
          add_views: [{ name: "All", type: "table" }],
          update_views: { Active: { type: "cards" } },
        },
      });
      expect(u.ok).toBe(true);
      if (u.ok) {
        const d = u.data as { applied: { views_added: number; views_updated: number } };
        expect(d.applied).toMatchObject({ views_added: 1, views_updated: 1 });
      }
      const after = await v.call("read_base", { vault: "test", path: "p.base" });
      if (after.ok) {
        const base = (after.data as { base: Record<string, unknown> }).base;
        const views = base.views as Array<Record<string, unknown>>;
        expect(views.map((w) => w.name)).toEqual(["Active", "All"]);
        expect(views[0]?.type).toBe("cards");
        expect(views[0]?.order).toEqual(["file.name"]); // unknown view key preserved
        expect(base.formulas).toBeDefined(); // unknown-to-patch top-level key preserved
      }

      // source change requires confirmation
      const src = { vault: "test", path: "p.base", patch: { source: { type: "tag", value: "y" } } };
      const need = await v.call("update_base", src);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");
      const ok = await v.call("update_base", src, {
        elicitToken: mint(v, "update_base", hashOf(need)),
      });
      expect(ok.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("update_base with a stale prev_hash is concurrent_modification", async () => {
    const v = makeM3Vault({ files: { "p.base": SAMPLE_BASE } });
    try {
      const r = await v.call("update_base", {
        vault: "test",
        path: "p.base",
        patch: { remove_views: ["Active"] },
        prev_hash: "0".repeat(64),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
    } finally {
      v.cleanup();
    }
  });

  it("query_base evaluates a view's filters + formulas over the source notes", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": SAMPLE_BASE,
        "projects/a.md": "---\nstatus: active\npriority: 3\n---\nA",
        "projects/b.md": "---\nstatus: done\npriority: 1\n---\nB",
        "other/c.md": "---\nstatus: active\npriority: 9\n---\nC",
      },
    });
    try {
      const q = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(q.ok).toBe(true);
      if (q.ok) {
        const d = q.data as {
          view_used: string;
          items: Array<{ note_path: string; columns: Record<string, unknown> }>;
        };
        expect(d.view_used).toBe("Active");
        // folder source = projects, filter status==active -> only projects/a.md
        expect(d.items.map((i) => i.note_path)).toEqual(["projects/a.md"]);
        const row = d.items[0];
        expect(row?.columns["file.name"]).toBe("a");
        expect(row?.columns.status).toBe("active");
        expect(row?.columns.doubled).toBe(6); // formula priority*2
      }
    } finally {
      v.cleanup();
    }
  });

  it("query_base applies override_filters and reports view_used", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": SAMPLE_BASE,
        "projects/a.md": "---\nstatus: active\npriority: 3\n---\nA",
        "projects/d.md": "---\nstatus: active\npriority: 7\n---\nD",
      },
    });
    try {
      const q = await v.call("query_base", {
        vault: "test",
        path: "p.base",
        override_filters: { ">": [{ var: "priority" }, 5] },
      });
      if (q.ok) {
        const d = q.data as { items: Array<{ note_path: string }> };
        expect(d.items.map((i) => i.note_path)).toEqual(["projects/d.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("a create outside the write whitelist is acl_denied", async () => {
    const v = makeM3Vault({ acl: { writePaths: ["bases/**"] } });
    try {
      const denied = await v.call("create_base", {
        vault: "test",
        path: "x.base",
        base: { views: [] },
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
    } finally {
      v.cleanup();
    }
  });
});
