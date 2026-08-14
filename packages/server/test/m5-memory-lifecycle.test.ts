// THE-833 — the memory-entity lifecycle: status (active/retired) filtering on get_entity and
// query_entity_graph, rename_entity (store + materialized-note consistency, including neighbor
// [[link]] rematerialization), unlink_entities (the inverse of link_entities), and delete_entity
// (HITL-gated, dependency-aware, modelled on `forget`). Every assertion is on the STORE (SQLite via
// v.db) or the PROJECTION (v.read/v.exists), never on a log line — the same discipline
// m5-memory.test.ts uses for the five original memory tools.
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

describe("THE-833 status filtering", () => {
  it("get_entity hides a retired entity by default and returns it with include_retired", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "tool", "legacy-linter");
      const renamed = await v.call("rename_entity", {
        vault: "test",
        entity_id: id,
        status: "retired",
      });
      expect(renamed.ok).toBe(true);

      const hidden = await v.call("get_entity", { vault: "test", entity_id: id });
      expect(hidden.ok).toBe(false);
      if (!hidden.ok) expect(hidden.error.code).toBe("invalid_input");

      const shown = await v.call("get_entity", {
        vault: "test",
        entity_id: id,
        include_retired: true,
      });
      expect(shown.ok).toBe(true);
      if (shown.ok) expect((shown.data as { status: string }).status).toBe("retired");

      // Lookup by (type, name) and by unique name are filtered the same way.
      const byName = await v.call("get_entity", { vault: "test", name: "legacy-linter" });
      expect(byName.ok).toBe(false);
      const byNameShown = await v.call("get_entity", {
        vault: "test",
        name: "legacy-linter",
        include_retired: true,
      });
      expect(byNameShown.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("a retired entity does not count toward by-name ambiguity unless include_retired is set", async () => {
    const v = makeM5Vault();
    try {
      await createEntity(v, "person", "Mercury");
      const id2 = await createEntity(v, "place", "Mercury");
      await v.call("rename_entity", { vault: "test", entity_id: id2, status: "retired" });

      // Only one ACTIVE "Mercury" remains -> unambiguous.
      const r = await v.call("get_entity", { vault: "test", name: "Mercury" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { type: string }).type).toBe("person");

      // With retired entities included, both candidates surface again -> ambiguous.
      const ambiguous = await v.call("get_entity", {
        vault: "test",
        name: "Mercury",
        include_retired: true,
      });
      expect(ambiguous.ok).toBe(false);
      if (!ambiguous.ok) expect(ambiguous.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("query_entity_graph excludes a retired node by default and includes it with include_retired", async () => {
    const v = makeM5Vault();
    try {
      const a = await createEntity(v, "person", "A");
      const b = await createEntity(v, "project", "B");
      await v.call("link_entities", {
        vault: "test",
        source_id: a,
        target_id: b,
        relation_type: "works_on",
      });
      await v.call("rename_entity", { vault: "test", entity_id: b, status: "retired" });

      const hidden = await v.call("query_entity_graph", {
        vault: "test",
        seed_entity_id: a,
        depth: 2,
        direction: "out",
      });
      expect(hidden.ok).toBe(true);
      if (hidden.ok) {
        const items = (hidden.data as { items: Array<{ entity_id: string }> }).items;
        expect(items.some((i) => i.entity_id === b)).toBe(false);
      }

      const shown = await v.call("query_entity_graph", {
        vault: "test",
        seed_entity_id: a,
        depth: 2,
        direction: "out",
        include_retired: true,
      });
      expect(shown.ok).toBe(true);
      if (shown.ok) {
        const items = (shown.data as { items: Array<{ entity_id: string; status: string }> }).items;
        const found = items.find((i) => i.entity_id === b);
        expect(found?.status).toBe("retired");
      }
    } finally {
      v.cleanup();
    }
  });

  it("query_entity_graph 404s a retired seed unless include_retired is set", async () => {
    const v = makeM5Vault();
    try {
      const a = await createEntity(v, "person", "A");
      await v.call("rename_entity", { vault: "test", entity_id: a, status: "retired" });
      const hidden = await v.call("query_entity_graph", { vault: "test", seed_entity_id: a });
      expect(hidden.ok).toBe(false);
      if (!hidden.ok) expect(hidden.error.code).toBe("invalid_input");
      const shown = await v.call("query_entity_graph", {
        vault: "test",
        seed_entity_id: a,
        include_retired: true,
      });
      expect(shown.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});

describe("rename_entity", () => {
  it("requires new_name or status", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada");
      const r = await v.call("rename_entity", { vault: "test", entity_id: id });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("404s a missing entity", async () => {
    const v = makeM5Vault();
    try {
      const r = await v.call("rename_entity", {
        vault: "test",
        entity_id: "ent_nope",
        new_name: "X",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("refuses a rename that collides with an existing (type, name)", async () => {
    const v = makeM5Vault();
    try {
      const a = await createEntity(v, "person", "Ada");
      await createEntity(v, "person", "Grace");
      const r = await v.call("rename_entity", { vault: "test", entity_id: a, new_name: "Grace" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("updates the store AND moves the materialized note, preserving unknown frontmatter", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada", { observations: ["mathematician"] });
      // Simulate a human edit adding frontmatter Obsidian owns (aliases) directly to the note.
      const before = v.read("memory/person/Ada.md");
      v.write("memory/person/Ada.md", before.replace("---\n", "---\naliases:\n  - Countess\n"));

      const r = await v.call(
        "rename_entity",
        { vault: "test", entity_id: id, new_name: "Ada Lovelace" },
        { now: () => 200 },
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { name: string; vault_path: string; updated_at: number };
        expect(d.name).toBe("Ada Lovelace");
        expect(d.vault_path).toBe("memory/person/Ada Lovelace.md");
        expect(d.updated_at).toBe(200);
      }

      // Store: the SAME entity_id now resolves under the new name.
      const row = v.db.prepare("SELECT name FROM memory_entities WHERE id = ?").get(id) as {
        name: string;
      };
      expect(row.name).toBe("Ada Lovelace");

      // Projection: old note is gone, new note exists with regenerated body + preserved frontmatter.
      expect(v.exists("memory/person/Ada.md")).toBe(false);
      const after = v.read("memory/person/Ada Lovelace.md");
      expect(after).toContain("# Ada Lovelace");
      expect(after).toContain("- mathematician");
      expect(after).toContain("obsidian_tc_id:");
      expect(after).toContain("aliases:");
      expect(after).toContain("Countess");
    } finally {
      v.cleanup();
    }
  });

  it("re-materializes a neighbor's [[link]] to the new name on rename", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "person", "Ada");
      const babbage = await createEntity(v, "person", "Babbage");
      await v.call("link_entities", {
        vault: "test",
        source_id: babbage,
        target_id: ada,
        relation_type: "collaborated_with",
      });
      expect(v.read("memory/person/Babbage.md")).toContain("- collaborated_with [[Ada]]");

      const r = await v.call("rename_entity", {
        vault: "test",
        entity_id: ada,
        new_name: "Ada Lovelace",
      });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect((r.data as { neighbors_rematerialized: number }).neighbors_rematerialized).toBe(1);

      // Babbage's note is the one with the OUTGOING link, and rename_entity rematerializes it —
      // its [[link]] must follow the rename, not still point at the old name.
      const babbageNote = v.read("memory/person/Babbage.md");
      expect(babbageNote).toContain("- collaborated_with [[Ada Lovelace]]");
      expect(babbageNote).not.toContain("[[Ada]]");
    } finally {
      v.cleanup();
    }
  });

  it("a status-only change (retire) leaves the note at the same path but updates its frontmatter", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "tool", "old-linter");
      const r = await v.call("rename_entity", { vault: "test", entity_id: id, status: "retired" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { status: string; vault_path: string; name: string };
        expect(d.status).toBe("retired");
        expect(d.name).toBe("old-linter");
        expect(d.vault_path).toBe("memory/tool/old-linter.md");
      }
      const note = v.read("memory/tool/old-linter.md");
      expect(note).toContain("status: retired");
    } finally {
      v.cleanup();
    }
  });
});

describe("unlink_entities", () => {
  it("removes only the named relation and leaves others intact", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "person", "Ada");
      const babbage = await createEntity(v, "person", "Babbage");
      const london = await createEntity(v, "place", "London");
      await v.call("link_entities", {
        vault: "test",
        source_id: ada,
        target_id: babbage,
        relation_type: "collaborated_with",
      });
      await v.call("link_entities", {
        vault: "test",
        source_id: ada,
        target_id: london,
        relation_type: "lived_in",
      });
      expect(v.read("memory/person/Ada.md")).toContain("- collaborated_with [[Babbage]]");
      expect(v.read("memory/person/Ada.md")).toContain("- lived_in [[London]]");

      const r = await v.call("unlink_entities", {
        vault: "test",
        source_id: ada,
        target_id: babbage,
        relation_type: "collaborated_with",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { removed: boolean }).removed).toBe(true);

      const note = v.read("memory/person/Ada.md");
      expect(note).not.toContain("collaborated_with");
      expect(note).toContain("- lived_in [[London]]");

      const row = v.db
        .prepare("SELECT COUNT(*) AS n FROM memory_relations WHERE source_id = ? AND target_id = ?")
        .get(ada, babbage) as { n: number };
      expect(row.n).toBe(0);
      const stillThere = v.db
        .prepare("SELECT COUNT(*) AS n FROM memory_relations WHERE source_id = ? AND target_id = ?")
        .get(ada, london) as { n: number };
      expect(stillThere.n).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  it("is a no-op (removed: false) when the relation doesn't exist", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "person", "Ada");
      const babbage = await createEntity(v, "person", "Babbage");
      const r = await v.call("unlink_entities", {
        vault: "test",
        source_id: ada,
        target_id: babbage,
        relation_type: "never_linked",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { removed: boolean }).removed).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("404s a missing source or target with invalid_input", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "person", "Ada");
      const r = await v.call("unlink_entities", {
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

describe("delete_entity", () => {
  it("refuses without a confirmation token and succeeds with one", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "tool", "scratch");
      const need = await v.call("delete_entity", { vault: "test", entity_id: id });
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");
      // The row must still exist — a refused confirmation is not a partial delete.
      expect(v.db.prepare("SELECT COUNT(*) AS n FROM memory_entities").get()).toEqual({ n: 1 });

      const ok = await v.callConfirmed("delete_entity", { vault: "test", entity_id: id });
      expect(ok.ok).toBe(true);
      if (ok.ok) expect((ok.data as { deleted: boolean }).deleted).toBe(true);
      expect(v.db.prepare("SELECT COUNT(*) AS n FROM memory_entities").get()).toEqual({ n: 0 });
      expect(v.exists("memory/tool/scratch.md")).toBe(false);
      expect(v.exists(".trash/memory/tool/scratch.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("404s a missing entity", async () => {
    const v = makeM5Vault();
    try {
      const r = await v.callConfirmed("delete_entity", { vault: "test", entity_id: "ent_nope" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("refuses to delete an entity with relations unless cascade is set", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "person", "Ada");
      const babbage = await createEntity(v, "person", "Babbage");
      await v.call("link_entities", {
        vault: "test",
        source_id: ada,
        target_id: babbage,
        relation_type: "collaborated_with",
      });

      const refused = await v.callConfirmed("delete_entity", { vault: "test", entity_id: babbage });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe("invalid_input");
        expect((refused.error.details as { relation_count?: number }).relation_count).toBe(1);
      }
      // Still there — the refusal must not have partially deleted anything.
      expect(v.db.prepare("SELECT COUNT(*) AS n FROM memory_entities").get()).toEqual({ n: 2 });

      const cascaded = await v.callConfirmed("delete_entity", {
        vault: "test",
        entity_id: babbage,
        cascade: true,
      });
      expect(cascaded.ok).toBe(true);
      if (cascaded.ok)
        expect((cascaded.data as { relations_deleted: number }).relations_deleted).toBe(1);

      expect(
        v.db.prepare("SELECT COUNT(*) AS n FROM memory_entities WHERE id = ?").get(babbage),
      ).toEqual({ n: 0 });
      expect(v.db.prepare("SELECT COUNT(*) AS n FROM memory_relations").get()).toEqual({ n: 0 });

      // The surviving neighbor (Ada) referenced Babbage — its note must no longer dangle on the
      // deleted entity's [[link]].
      const adaNote = v.read("memory/person/Ada.md");
      expect(adaNote).not.toContain("Babbage");
    } finally {
      v.cleanup();
    }
  });

  it("supports permanent deletion (no .trash copy)", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "tool", "scratch");
      const ok = await v.callConfirmed("delete_entity", {
        vault: "test",
        entity_id: id,
        permanent: true,
      });
      expect(ok.ok).toBe(true);
      expect(v.exists("memory/tool/scratch.md")).toBe(false);
      expect(v.exists(".trash/memory/tool/scratch.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});
