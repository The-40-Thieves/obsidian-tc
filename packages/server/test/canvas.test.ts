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

describe("Domain 8: Canvas", () => {
  it("create_canvas creates, read_canvas round-trips, and the call is audited", async () => {
    const v = makeM3Vault();
    try {
      const c = await v.call("create_canvas", {
        vault: "test",
        path: "board.canvas",
        nodes: [node("n1")],
        edges: [{ id: "e1", fromNode: "n1", toNode: "n1" }],
      });
      expect(c.ok).toBe(true);
      if (c.ok) {
        const d = c.data as { created: boolean; node_count: number; content_hash: string };
        expect(d.created).toBe(true);
        expect(d.node_count).toBe(1);
        expect(d.content_hash).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(v.exists("board.canvas")).toBe(true);

      const r = await v.call("read_canvas", { vault: "test", path: "board.canvas" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { nodes: Array<{ id: string }>; edges: Array<{ id: string }> };
        expect(d.nodes[0]?.id).toBe("n1");
        expect(d.edges[0]?.id).toBe("e1");
      }

      const ev = v.events();
      expect(ev.some((e) => e.tool_name === "create_canvas" && e.status === "ok")).toBe(true);
      expect(ev.some((e) => e.tool_name === "read_canvas" && e.status === "ok")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("create_canvas refuses an existing canvas without overwrite (note_exists)", async () => {
    const v = makeM3Vault({ files: { "a.canvas": '{"nodes":[],"edges":[]}' } });
    try {
      const r = await v.call("create_canvas", { vault: "test", path: "a.canvas" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_exists");
    } finally {
      v.cleanup();
    }
  });

  it("create_canvas overwrite of an existing canvas runs the HITL cycle", async () => {
    const v = makeM3Vault({ files: { "a.canvas": '{"nodes":[],"edges":[]}' } });
    try {
      const input = { vault: "test", path: "a.canvas", nodes: [node("x")], overwrite: true };
      const need = await v.call("create_canvas", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");
      const ok = await v.call("create_canvas", input, {
        elicitToken: mint(v, "create_canvas", hashOf(need)),
      });
      expect(ok.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("read_canvas rejects a non-.canvas path and a malformed canvas", async () => {
    const v = makeM3Vault({ files: { "bad.canvas": "{not json", "note.md": "x" } });
    try {
      const wrong = await v.call("read_canvas", { vault: "test", path: "note.md" });
      expect(wrong.ok).toBe(false);
      if (!wrong.ok) expect(wrong.error.code).toBe("invalid_input");

      const missing = await v.call("read_canvas", { vault: "test", path: "ghost.canvas" });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("note_not_found");

      const bad = await v.call("read_canvas", { vault: "test", path: "bad.canvas" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("update_canvas adds/removes/updates and preserves unknown fields", async () => {
    const v = makeM3Vault();
    try {
      v.write(
        "b.canvas",
        JSON.stringify({
          nodes: [{ ...node("n1"), styleAttributes: { shape: "pill" } }, node("n2")],
          edges: [],
          metadata: { app: "obsidian" },
        }),
      );
      const u = await v.call("update_canvas", {
        vault: "test",
        path: "b.canvas",
        update_nodes: { n1: { text: "updated" } },
        remove_node_ids: ["n2"],
        add_nodes: [node("n3")],
      });
      expect(u.ok).toBe(true);
      if (u.ok) {
        const d = u.data as {
          applied: { nodes_added: number; nodes_removed: number; nodes_updated: number };
        };
        expect(d.applied).toMatchObject({ nodes_added: 1, nodes_removed: 1, nodes_updated: 1 });
      }
      const disk = JSON.parse(v.read("b.canvas")) as {
        nodes: Array<Record<string, unknown>>;
        metadata: unknown;
      };
      expect(disk.nodes.map((n) => n.id)).toEqual(["n1", "n3"]);
      const n1 = disk.nodes.find((n) => n.id === "n1");
      expect(n1?.text).toBe("updated");
      expect(n1?.styleAttributes).toEqual({ shape: "pill" });
      expect(disk.metadata).toEqual({ app: "obsidian" });
    } finally {
      v.cleanup();
    }
  });

  it("update_canvas with a stale prev_hash is concurrent_modification", async () => {
    const v = makeM3Vault({ files: { "c.canvas": '{"nodes":[],"edges":[]}' } });
    try {
      const r = await v.call("update_canvas", {
        vault: "test",
        path: "c.canvas",
        add_nodes: [node("n1")],
        prev_hash: "0".repeat(64),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
    } finally {
      v.cleanup();
    }
  });

  it("update_canvas removing more than 10 nodes requires confirmation", async () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node(`n${i}`));
    const v = makeM3Vault({ files: { "d.canvas": JSON.stringify({ nodes, edges: [] }) } });
    try {
      const input = {
        vault: "test",
        path: "d.canvas",
        remove_node_ids: nodes.slice(0, 11).map((n) => n.id as string),
      };
      const need = await v.call("update_canvas", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");
      const ok = await v.call("update_canvas", input, {
        elicitToken: mint(v, "update_canvas", hashOf(need)),
      });
      expect(ok.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("query_canvas filters by type, text, and edge target across canvases", async () => {
    const v = makeM3Vault();
    try {
      v.write(
        "one.canvas",
        JSON.stringify({
          nodes: [
            node("a", { text: "find me alpha" }),
            { id: "f", type: "file", x: 0, y: 0, width: 1, height: 1, file: "notes/x.md" },
          ],
          edges: [{ id: "e", fromNode: "a", toNode: "f" }],
        }),
      );
      v.write(
        "two.canvas",
        JSON.stringify({ nodes: [node("b", { text: "other beta" })], edges: [] }),
      );

      const byText = await v.call("query_canvas", {
        vault: "test",
        filter: { text_contains: "alpha" },
      });
      expect(byText.ok).toBe(true);
      if (byText.ok) {
        const d = byText.data as { items: Array<{ node_id: string; canvas_path: string }> };
        expect(d.items).toHaveLength(1);
        expect(d.items[0]).toMatchObject({ node_id: "a", canvas_path: "one.canvas" });
      }

      const byType = await v.call("query_canvas", { vault: "test", filter: { type: "file" } });
      if (byType.ok) {
        const d = byType.data as { items: Array<{ node_id: string }> };
        expect(d.items.map((i) => i.node_id)).toEqual(["f"]);
      }

      const byEdge = await v.call("query_canvas", { vault: "test", filter: { has_edge_to: "f" } });
      if (byEdge.ok) {
        const d = byEdge.data as { items: Array<{ node_id: string }> };
        expect(d.items.map((i) => i.node_id)).toEqual(["a"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("a create outside the write whitelist is acl_denied", async () => {
    const v = makeM3Vault({ acl: { writePaths: ["boards/**"] } });
    try {
      const denied = await v.call("create_canvas", { vault: "test", path: "other/x.canvas" });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
      const ok = await v.call("create_canvas", { vault: "test", path: "boards/x.canvas" });
      expect(ok.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});
