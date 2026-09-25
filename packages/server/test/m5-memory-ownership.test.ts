import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeM5Vault } from "./m5-helpers";

async function createEntity(v: ReturnType<typeof makeM5Vault>, name: string): Promise<string> {
  const result = await v.call("create_entity", {
    vault: "test",
    type: "person",
    name,
  });
  if (!result.ok) throw new Error(`create_entity failed: ${JSON.stringify(result.error)}`);
  return (result.data as { entity_id: string }).entity_id;
}

function count(v: ReturnType<typeof makeM5Vault>, sql: string, ...params: unknown[]): number {
  return (v.db.prepare(sql).get(...params) as { n: number }).n;
}

describe("PR #978 adversarial ownership verification", () => {
  it("rename_entity refuses a foreign destination without overwriting it or renaming the row", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "Ada");
      const foreign = "# Grace's hand-written note\n\nDO NOT OVERWRITE\n";
      v.write("memory/person/Grace.md", foreign);

      const result = await v.call("rename_entity", {
        vault: "test",
        entity_id: ada,
        new_name: "Grace",
      });

      expect.soft(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("note_exists");
      expect.soft(v.read("memory/person/Grace.md")).toBe(foreign);
      expect.soft(v.exists("memory/person/Ada.md")).toBe(true);
      expect
        .soft(
          count(v, "SELECT COUNT(*) AS n FROM memory_entities WHERE id = ? AND name = 'Ada'", ada),
        )
        .toBe(1);
    } finally {
      v.cleanup();
    }
  });

  it("status-only rename rolls back the row when its current note refuses rematerialization", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "Ada");
      const foreign = "# Foreign replacement\n\nKEEP THIS BODY\n";
      v.write("memory/person/Ada.md", foreign);

      const result = await v.call("rename_entity", {
        vault: "test",
        entity_id: ada,
        status: "retired",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("note_exists");
      expect(v.read("memory/person/Ada.md")).toBe(foreign);
      expect(
        count(
          v,
          "SELECT COUNT(*) AS n FROM memory_entities WHERE id = ? AND status = 'active'",
          ada,
        ),
      ).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  it("link_entities removes its just-inserted relation and leaves no temp file on ownership refusal", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "Ada");
      const babbage = await createEntity(v, "Babbage");
      const foreign = "# Hand-written Ada note\n\nKEEP THIS BODY\n";
      v.write("memory/person/Ada.md", foreign);

      const result = await v.call("link_entities", {
        vault: "test",
        source_id: ada,
        target_id: babbage,
        relation_type: "collaborated_with",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("note_exists");
      expect(v.read("memory/person/Ada.md")).toBe(foreign);
      expect(count(v, "SELECT COUNT(*) AS n FROM memory_relations")).toBe(0);
      expect(
        readdirSync(join(v.root, "memory/person")).some((name) => name.includes(".tmp-")),
      ).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("unlink_entities restores the relation when source-note ownership refusal aborts rematerialization", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "Ada");
      const babbage = await createEntity(v, "Babbage");
      const linked = await v.call("link_entities", {
        vault: "test",
        source_id: ada,
        target_id: babbage,
        relation_type: "collaborated_with",
      });
      expect(linked.ok).toBe(true);
      const foreign = "# A human replaced this projection\n\nKEEP THIS BODY\n";
      v.write("memory/person/Ada.md", foreign);

      const result = await v.call("unlink_entities", {
        vault: "test",
        source_id: ada,
        target_id: babbage,
        relation_type: "collaborated_with",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("note_exists");
      expect(v.read("memory/person/Ada.md")).toBe(foreign);
      expect(
        count(
          v,
          "SELECT COUNT(*) AS n FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = ?",
          ada,
          babbage,
          "collaborated_with",
        ),
      ).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  it("delete_entity refuses to trash or permanently delete a note the entity no longer owns", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "Ada");
      const foreign = "# Hand-written replacement\n\nTHIS IS NOT THE ENTITY NOTE\n";
      v.write("memory/person/Ada.md", foreign);

      const result = await v.callConfirmed("delete_entity", {
        vault: "test",
        entity_id: ada,
        permanent: true,
      });

      expect.soft(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("note_exists");
      expect.soft(v.exists("memory/person/Ada.md")).toBe(true);
      if (v.exists("memory/person/Ada.md"))
        expect.soft(v.read("memory/person/Ada.md")).toBe(foreign);
      expect.soft(count(v, "SELECT COUNT(*) AS n FROM memory_entities WHERE id = ?", ada)).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  it("cascading delete rolls back the entity and relation when a neighbor refuses rematerialization", async () => {
    const v = makeM5Vault();
    try {
      const ada = await createEntity(v, "Ada");
      const babbage = await createEntity(v, "Babbage");
      const linked = await v.call("link_entities", {
        vault: "test",
        source_id: ada,
        target_id: babbage,
        relation_type: "collaborated_with",
      });
      expect(linked.ok).toBe(true);
      const foreign = "# Foreign Ada note\n\nKEEP THIS BODY\n";
      v.write("memory/person/Ada.md", foreign);

      const result = await v.callConfirmed("delete_entity", {
        vault: "test",
        entity_id: babbage,
        cascade: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("note_exists");
      expect(v.read("memory/person/Ada.md")).toBe(foreign);
      expect(count(v, "SELECT COUNT(*) AS n FROM memory_entities WHERE id = ?", babbage)).toBe(1);
      expect(
        count(
          v,
          "SELECT COUNT(*) AS n FROM memory_relations WHERE source_id = ? AND target_id = ?",
          ada,
          babbage,
        ),
      ).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});
