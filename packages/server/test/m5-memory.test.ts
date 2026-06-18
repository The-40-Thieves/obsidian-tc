// Domain 22 — Memory entities + [[link]] graph, end-to-end through dispatch (THE-181).
// Covers create (materialized + non-materialized), get by id/type+name/name (+ambiguity),
// add_observation with note re-materialization, link_entities (idempotent + source note
// gains the [[link]]), query_entity_graph BFS, every invalid_input path, the read-only
// kill-switch, scope enforcement, and the materialization write ACL.
import { describe, expect, it } from "vitest";
import { makeM5Vault } from "./m5-helpers";

async function createEntity(
  v: ReturnType<typeof makeM5Vault>,
  type: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await v.call(
    "create_entity",
    { vault: "test", type, name, ...extra },
    { now: () => 100 },
  );
  if (!r.ok) throw new Error(`create_entity failed: ${JSON.stringify(r.error)}`);
  return (r.data as { entity_id: string }).entity_id;
}

describe("create_entity", () => {
  it("creates an entity and materializes a vault note with frontmatter + H1", async () => {
    const v = makeM5Vault();
    try {
      const r = await v.call(
        "create_entity",
        { vault: "test", type: "person", name: "Ada", observations: ["mathematician"] },
        { now: () => 100 },
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { entity_id: string; vault_path: string; materialized: boolean };
        expect(d.entity_id).toMatch(/^ent_[a-f0-9]{24}$/);
        expect(d.materialized).toBe(true);
        expect(d.vault_path).toBe("memory/person/Ada.md");
      }
      const note = v.read("memory/person/Ada.md");
      expect(note).toContain("obsidian_tc_id:");
      expect(note).toContain("entity_type: person");
      expect(note).toContain("# Ada");
      expect(note).toContain("- mathematician");
      expect(v.events().some((e) => e.tool_name === "create_entity" && e.status === "ok")).toBe(
        true,
      );
    } finally {
      v.cleanup();
    }
  });

  it("can skip materialization (no note, null vault_path)", async () => {
    const v = makeM5Vault();
    try {
      const r = await v.call("create_entity", {
        vault: "test",
        type: "concept",
        name: "X",
        materialize: false,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { vault_path: string | null }).vault_path).toBeNull();
      expect(v.exists("memory/concept/X.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("rejects a duplicate (type, name) with invalid_input", async () => {
    const v = makeM5Vault();
    try {
      await createEntity(v, "person", "Ada");
      const dup = await v.call("create_entity", { vault: "test", type: "person", name: "Ada" });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("enforces the materialization write ACL and leaves no orphan row", async () => {
    const v = makeM5Vault({ acl: { writePaths: ["allowed/**"] } });
    try {
      const r = await v.call("create_entity", { vault: "test", type: "person", name: "Ada" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("acl_denied");
      expect(v.db.prepare("SELECT COUNT(*) AS n FROM memory_entities").get()).toEqual({ n: 0 });
    } finally {
      v.cleanup();
    }
  });

  it("is blocked by the read-only kill-switch and requires write:memory", async () => {
    const ro = makeM5Vault({ acl: { readOnly: true } });
    try {
      const r = await ro.call("create_entity", { vault: "test", type: "person", name: "Ada" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
    } finally {
      ro.cleanup();
    }
    const v = makeM5Vault();
    try {
      const r = await v.call(
        "create_entity",
        { vault: "test", type: "person", name: "Ada" },
        { grantedScopes: new Set(["read:memory"]) },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
    } finally {
      v.cleanup();
    }
  });
});

describe("get_entity", () => {
  it("resolves by id, by type+name, and by unique name; flags ambiguity + not-found", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada", { observations: ["pioneer"] });
      const byId = await v.call("get_entity", { vault: "test", entity_id: id });
      if (!byId.ok) throw new Error("by id failed");
      expect((byId.data as { name: string; observations: string[] }).observations).toEqual([
        "pioneer",
      ]);

      const byTypeName = await v.call("get_entity", { vault: "test", type: "person", name: "Ada" });
      expect(byTypeName.ok).toBe(true);

      const byName = await v.call("get_entity", { vault: "test", name: "Ada" });
      expect(byName.ok).toBe(true);

      // Ambiguous name across types.
      await createEntity(v, "place", "Ada");
      const ambiguous = await v.call("get_entity", { vault: "test", name: "Ada" });
      expect(ambiguous.ok).toBe(false);
      if (!ambiguous.ok) expect(ambiguous.error.code).toBe("invalid_input");

      const missing = await v.call("get_entity", { vault: "test", entity_id: "ent_nope" });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});

describe("add_observation", () => {
  it("appends a fact and re-materializes the note", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada", { observations: ["one"] });
      const r = await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "two" },
        { now: () => 200 },
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { observation_count: number }).observation_count).toBe(2);
      const note = v.read("memory/person/Ada.md");
      expect(note).toContain("- one");
      expect(note).toContain("- two");
    } finally {
      v.cleanup();
    }
  });

  it("404s a missing entity with invalid_input", async () => {
    const v = makeM5Vault();
    try {
      const r = await v.call("add_observation", {
        vault: "test",
        entity_id: "ent_nope",
        observation: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});

describe("link_entities", () => {
  it("creates a relation, adds the [[link]] to the source note, and is idempotent", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "person", "Ada");
      const babbage = await createEntity(v, "person", "Babbage");
      const r = await v.call("link_entities", {
        vault: "test",
        source_id: ada,
        target_id: babbage,
        relation_type: "collaborated_with",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { existed_already: boolean }).existed_already).toBe(false);
      expect(v.read("memory/person/Ada.md")).toContain("- collaborated_with [[Babbage]]");

      const again = await v.call("link_entities", {
        vault: "test",
        source_id: ada,
        target_id: babbage,
        relation_type: "collaborated_with",
      });
      if (!again.ok) throw new Error("re-link failed");
      expect((again.data as { existed_already: boolean }).existed_already).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("404s a missing source or target with invalid_input", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "person", "Ada");
      const r = await v.call("link_entities", {
        vault: "test",
        source_id: ada,
        target_id: "ent_nope",
        relation_type: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});

describe("query_entity_graph", () => {
  it("traverses BFS from a seed with distance + path", async () => {
    const v = makeM5Vault();
    try {
      const a = await createEntity(v, "person", "A");
      const b = await createEntity(v, "project", "B");
      const c = await createEntity(v, "concept", "C");
      await v.call("link_entities", {
        vault: "test",
        source_id: a,
        target_id: b,
        relation_type: "works_on",
      });
      await v.call("link_entities", {
        vault: "test",
        source_id: b,
        target_id: c,
        relation_type: "uses",
      });
      const r = await v.call("query_entity_graph", {
        vault: "test",
        seed_entity_id: a,
        depth: 2,
        direction: "out",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const items = (r.data as { items: Array<{ entity_id: string; distance: number }> }).items;
        const byId = new Map(items.map((i) => [i.entity_id, i.distance]));
        expect(byId.get(b)).toBe(1);
        expect(byId.get(c)).toBe(2);
      }
    } finally {
      v.cleanup();
    }
  });

  it("404s a missing seed with invalid_input", async () => {
    const v = makeM5Vault();
    try {
      const r = await v.call("query_entity_graph", { vault: "test", seed_entity_id: "ent_nope" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});
