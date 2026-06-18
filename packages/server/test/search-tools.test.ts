import type { ToolResult } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";
import { makeM2Vault } from "./m2-helpers";

function payload(res: ToolResult): any {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
  return res.data;
}

async function seeded() {
  const v = makeM2Vault({
    files: {
      "fox.md": "# Fox\n\nthe quick brown fox jumps",
      "dog.md": "# Dog\n\nthe lazy dog sleeps",
      "task.md": "---\nstatus: active\npriority: 3\n---\n\n# Task\n\nship the release",
    },
  });
  await v.call("index_vault", { vault: "test" });
  return v;
}

describe("Domain 6 search tools on the dispatch pipeline", () => {
  it("search_text returns ranked literal matches", async () => {
    const v = await seeded();
    const d = payload(await v.call("search_text", { vault: "test", query: "fox" }));
    expect(d.mode_used).toBe("text");
    expect(d.items.map((i: { path: string }) => i.path)).toContain("fox.md");
    expect(d.items.every((i: { path: string }) => i.path !== "dog.md")).toBe(true);
    v.cleanup();
  });

  it("search_regex returns per-match locations", async () => {
    const v = await seeded();
    const d = payload(await v.call("search_regex", { vault: "test", pattern: "la\\w+" }));
    expect(d.mode_used).toBe("regex");
    expect(d.items[0].match).toBe("lazy");
    expect(d.items[0].path).toBe("dog.md");
    v.cleanup();
  });

  it("search_semantic returns top-k chunks after indexing", async () => {
    const v = await seeded();
    const d = payload(await v.call("search_semantic", { vault: "test", query: "lazy dog", k: 2 }));
    expect(d.mode_used).toBe("semantic");
    expect(d.items.length).toBeGreaterThan(0);
    expect(d.items[0]).toHaveProperty("chunk_id");
    expect(d.items[0]).toHaveProperty("embedding_model");
    v.cleanup();
  });

  it("search_jsonlogic filters by frontmatter", async () => {
    const v = await seeded();
    const d = payload(
      await v.call("search_jsonlogic", {
        vault: "test",
        logic: { "==": [{ var: "status" }, "active"] },
      }),
    );
    expect(d.items).toEqual([{ path: "task.md", matched: true }]);
    v.cleanup();
  });

  it("search_dql reports plugin_missing (no Dataview bridge yet)", async () => {
    const v = await seeded();
    const res = await v.call("search_dql", { vault: "test", dql: "TABLE file.name" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
    v.cleanup();
  });

  it("search_vault auto uses text first", async () => {
    const v = await seeded();
    const d = payload(await v.call("search_vault", { vault: "test", query: "fox", explain: true }));
    expect(d.mode_used).toBe("text");
    expect(d._explain.modes_tried).toEqual(["text"]);
    expect(d.items.some((i: { path: string }) => i.path === "fox.md")).toBe(true);
    v.cleanup();
  });

  it("search_vault auto falls back to semantic on zero text hits", async () => {
    const v = await seeded();
    const d = payload(
      await v.call("search_vault", { vault: "test", query: "zzqxnomatchword", explain: true }),
    );
    expect(d.mode_used).toBe("semantic");
    expect(d._explain.modes_tried).toEqual(["text", "semantic"]);
    expect(d.items.length).toBeGreaterThan(0);
    v.cleanup();
  });

  it("search_vault auto routes an object query to jsonlogic", async () => {
    const v = await seeded();
    const d = payload(
      await v.call("search_vault", {
        vault: "test",
        query: { ">": [{ var: "priority" }, 2] },
      }),
    );
    expect(d.mode_used).toBe("jsonlogic");
    expect(d.items.map((i: { path: string }) => i.path)).toEqual(["task.md"]);
    v.cleanup();
  });

  it("enforces the read ACL across search", async () => {
    const v = makeM2Vault({
      files: { "pub/a.md": "secret word here", "priv/b.md": "secret word hidden" },
      acl: { readPaths: ["pub/**"] },
    });
    const d = payload(await v.call("search_text", { vault: "test", query: "secret" }));
    expect(d.items.map((i: { path: string }) => i.path)).toEqual(["pub/a.md"]);
    v.cleanup();
  });
});
