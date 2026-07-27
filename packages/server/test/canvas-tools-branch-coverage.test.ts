// THE-602: branch-coverage top-up for src/tools/m3/canvas-tools.ts. Every case here asserts
// real caller-visible behavior (an error code, a returned count, a disk write or its absence) —
// not merely that a branch executed. See test/canvas.test.ts for the primary behavioral suite;
// this file targets the folder guards, edge mutations, invalid-patch rejection, and the
// query_canvas root/paths/filter/pagination branches that suite doesn't exercise.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
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

function errCode(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return r.error.code;
}

describe("canvas-tools branch coverage (THE-602)", () => {
  it("create_canvas rejects an existing folder at the target path", async () => {
    const v = makeM3Vault();
    try {
      mkdirSync(join(v.root, "dir.canvas"), { recursive: true });
      const r = await v.call("create_canvas", { vault: "test", path: "dir.canvas" });
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("invalid_input");
      // must not have touched the folder
      expect(v.exists("dir.canvas")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("update_canvas on a folder path is note_not_found, distinct from a truly missing path", async () => {
    const v = makeM3Vault();
    try {
      mkdirSync(join(v.root, "dir.canvas"), { recursive: true });
      const onFolder = await v.call("update_canvas", {
        vault: "test",
        path: "dir.canvas",
        add_nodes: [node("n1")],
      });
      expect(onFolder.ok).toBe(false);
      expect(errCode(onFolder)).toBe("note_not_found");

      const onMissing = await v.call("update_canvas", {
        vault: "test",
        path: "ghost.canvas",
        add_nodes: [node("n1")],
      });
      expect(onMissing.ok).toBe(false);
      expect(errCode(onMissing)).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("update_canvas removes edges by id and reports the count", async () => {
    const v = makeM3Vault({
      files: {
        "e.canvas": JSON.stringify({
          nodes: [node("n1"), node("n2")],
          edges: [
            { id: "e1", fromNode: "n1", toNode: "n2" },
            { id: "e2", fromNode: "n2", toNode: "n1" },
          ],
        }),
      },
    });
    try {
      const r = await v.call("update_canvas", {
        vault: "test",
        path: "e.canvas",
        remove_edge_ids: ["e1"],
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { applied: { edges_removed: number } };
        expect(d.applied.edges_removed).toBe(1);
      }
      const disk = JSON.parse(v.read("e.canvas")) as { edges: Array<{ id: string }> };
      expect(disk.edges.map((e) => e.id)).toEqual(["e2"]);
    } finally {
      v.cleanup();
    }
  });

  it("update_canvas updates a matching edge and silently ignores an unknown edge id", async () => {
    const v = makeM3Vault({
      files: {
        "f.canvas": JSON.stringify({
          nodes: [node("n1"), node("n2")],
          edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
        }),
      },
    });
    try {
      const r = await v.call("update_canvas", {
        vault: "test",
        path: "f.canvas",
        update_edges: { e1: { color: "1" }, ghost: { color: "2" } },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { applied: { edges_updated: number } };
        // only e1 matched a real edge; "ghost" doesn't exist and must not count or throw
        expect(d.applied.edges_updated).toBe(1);
      }
      const disk = JSON.parse(v.read("f.canvas")) as {
        edges: Array<{ id: string; color?: string }>;
      };
      expect(disk.edges.find((e) => e.id === "e1")?.color).toBe("1");
      expect(disk.edges).toHaveLength(1);
    } finally {
      v.cleanup();
    }
  });

  it("update_canvas silently ignores an unknown node id in update_nodes", async () => {
    const v = makeM3Vault({
      files: { "n.canvas": JSON.stringify({ nodes: [node("n1")], edges: [] }) },
    });
    try {
      const r = await v.call("update_canvas", {
        vault: "test",
        path: "n.canvas",
        update_nodes: { ghost: { text: "nope" } },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { applied: { nodes_updated: number } };
        expect(d.applied.nodes_updated).toBe(0);
      }
    } finally {
      v.cleanup();
    }
  });

  it("update_canvas adds edges and reports the count", async () => {
    const v = makeM3Vault({
      files: { "g.canvas": JSON.stringify({ nodes: [node("n1"), node("n2")], edges: [] }) },
    });
    try {
      const r = await v.call("update_canvas", {
        vault: "test",
        path: "g.canvas",
        add_edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { applied: { edges_added: number } };
        expect(d.applied.edges_added).toBe(1);
      }
      const disk = JSON.parse(v.read("g.canvas")) as { edges: Array<{ id: string }> };
      expect(disk.edges.map((e) => e.id)).toEqual(["e1"]);
    } finally {
      v.cleanup();
    }
  });

  it("update_canvas rejects a patch that leaves the canvas structurally invalid, and does not write", async () => {
    const v = makeM3Vault({
      files: { "h.canvas": JSON.stringify({ nodes: [node("n1")], edges: [] }) },
    });
    try {
      const before = v.read("h.canvas");
      const r = await v.call("update_canvas", {
        vault: "test",
        path: "h.canvas",
        // width must be a number per CanvasNode; this breaks CanvasDoc.safeParse after the merge
        update_nodes: { n1: { width: "not-a-number" } },
      });
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("invalid_input");
      // the rejected patch must never reach disk
      expect(v.read("h.canvas")).toBe(before);
    } finally {
      v.cleanup();
    }
  });

  it("query_canvas scopes the scan to an explicit root", async () => {
    const v = makeM3Vault();
    try {
      v.write("sub/in.canvas", JSON.stringify({ nodes: [node("a")], edges: [] }));
      v.write("out.canvas", JSON.stringify({ nodes: [node("b")], edges: [] }));
      const r = await v.call("query_canvas", { vault: "test", root: "sub" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ node_id: string }> };
        expect(d.items.map((i) => i.node_id)).toEqual(["a"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("query_canvas with a root outside the read whitelist is acl_denied", async () => {
    const v = makeM3Vault({ acl: { readPaths: ["sub/**"] } });
    try {
      v.write("sub/in.canvas", JSON.stringify({ nodes: [node("a")], edges: [] }));
      v.write("out.canvas", JSON.stringify({ nodes: [node("b")], edges: [] }));
      const r = await v.call("query_canvas", { vault: "test", root: "out" });
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("acl_denied");
    } finally {
      v.cleanup();
    }
  });

  it("query_canvas with explicit paths filters out non-.canvas and ACL-denied entries", async () => {
    const v = makeM3Vault({
      acl: { readPaths: ["ok/**"] },
      files: {
        "ok/a.canvas": JSON.stringify({ nodes: [node("a")], edges: [] }),
        "denied/b.canvas": JSON.stringify({ nodes: [node("b")], edges: [] }),
        "ok/note.md": "not a canvas",
      },
    });
    try {
      const r = await v.call("query_canvas", {
        vault: "test",
        paths: ["ok/a.canvas", "denied/b.canvas", "ok/note.md"],
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { canvases_scanned: number; items: Array<{ node_id: string }> };
        // denied/b.canvas is filtered by ACL, ok/note.md by extension: only ok/a.canvas survives
        expect(d.canvases_scanned).toBe(1);
        expect(d.items.map((i) => i.node_id)).toEqual(["a"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("query_canvas reports a missing path and a malformed canvas as scan errors, not a hard failure", async () => {
    const v = makeM3Vault({
      files: {
        "ok.canvas": JSON.stringify({ nodes: [node("a")], edges: [] }),
        "bad.canvas": "{not json",
      },
    });
    try {
      const r = await v.call("query_canvas", {
        vault: "test",
        paths: ["ok.canvas", "ghost.canvas", "bad.canvas"],
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          errors: Array<{ path: string; code: string }>;
          items: Array<{ node_id: string }>;
          canvases_scanned: number;
        };
        expect(d.errors).toEqual(
          expect.arrayContaining([
            { path: "ghost.canvas", code: "note_not_found" },
            { path: "bad.canvas", code: "invalid_input" },
          ]),
        );
        expect(d.items.map((i) => i.node_id)).toEqual(["a"]);
        expect(d.canvases_scanned).toBe(3);
      }
    } finally {
      v.cleanup();
    }
  });

  it("query_canvas filters by color and by file_path_contains", async () => {
    const v = makeM3Vault();
    try {
      v.write(
        "c.canvas",
        JSON.stringify({
          nodes: [
            node("red", { color: "1" }),
            node("blue", { color: "2" }),
            { id: "f1", type: "file", x: 0, y: 0, width: 1, height: 1, file: "projects/alpha.md" },
            { id: "f2", type: "file", x: 0, y: 0, width: 1, height: 1, file: "projects/beta.md" },
          ],
          edges: [],
        }),
      );
      const byColor = await v.call("query_canvas", { vault: "test", filter: { color: "1" } });
      expect(byColor.ok).toBe(true);
      if (byColor.ok) {
        const d = byColor.data as { items: Array<{ node_id: string }> };
        expect(d.items.map((i) => i.node_id)).toEqual(["red"]);
      }

      const byFile = await v.call("query_canvas", {
        vault: "test",
        filter: { file_path_contains: "alpha" },
      });
      expect(byFile.ok).toBe(true);
      if (byFile.ok) {
        const d = byFile.data as { items: Array<{ node_id: string }> };
        expect(d.items.map((i) => i.node_id)).toEqual(["f1"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("query_canvas omits snippet for a node with neither text nor file (e.g. a group)", async () => {
    const v = makeM3Vault({
      files: {
        "grp.canvas": JSON.stringify({
          nodes: [{ id: "g1", type: "group", x: 0, y: 0, width: 10, height: 10 }],
          edges: [],
        }),
      },
    });
    try {
      const r = await v.call("query_canvas", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<Record<string, unknown>> };
        expect(d.items).toHaveLength(1);
        expect(d.items[0]).not.toHaveProperty("snippet");
      }
    } finally {
      v.cleanup();
    }
  });

  it("query_canvas paginates with a cursor, tolerates a non-numeric cursor, and reports next_cursor", async () => {
    const v = makeM3Vault();
    try {
      const nodes = Array.from({ length: 3 }, (_, i) => node(`n${i}`));
      v.write("p.canvas", JSON.stringify({ nodes, edges: [] }));

      const first = await v.call("query_canvas", { vault: "test", limit: 2 });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("unreachable");
      const d1 = first.data as { items: Array<{ node_id: string }>; next_cursor?: string };
      expect(d1.items.map((i) => i.node_id)).toEqual(["n0", "n1"]);
      expect(d1.next_cursor).toBe("2");

      const second = await v.call("query_canvas", {
        vault: "test",
        limit: 2,
        cursor: d1.next_cursor,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("unreachable");
      const d2 = second.data as { items: Array<{ node_id: string }>; next_cursor?: string };
      expect(d2.items.map((i) => i.node_id)).toEqual(["n2"]);
      expect(d2.next_cursor).toBeUndefined();

      // a non-numeric cursor must fall back to the start (0), not throw or skip everything
      const garbage = await v.call("query_canvas", { vault: "test", cursor: "not-a-number" });
      expect(garbage.ok).toBe(true);
      if (!garbage.ok) throw new Error("unreachable");
      const d3 = garbage.data as { items: Array<{ node_id: string }> };
      expect(d3.items.map((i) => i.node_id)).toEqual(["n0", "n1", "n2"]);
    } finally {
      v.cleanup();
    }
  });
});
