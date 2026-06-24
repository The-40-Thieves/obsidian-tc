import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "./helpers";

const sql001 = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const sql002 = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_002_entity_unique.sql", import.meta.url)),
  "utf8",
);

describe("migration 20260519_002 entity natural-key dedup (review #5)", () => {
  it("repoints relations onto the survivor instead of cascade-dropping them", () => {
    const db = openMemoryDb();
    db.exec("PRAGMA foreign_keys = ON;"); // production setting — ON DELETE CASCADE is live
    db.exec(sql001); // initial schema has no natural-key unique index, so dups are insertable

    const insEntity = (id: string, name: string) =>
      db
        .prepare(
          "INSERT INTO memory_entities (id, vault_id, entity_type, name, observations, materialize, vault_path, created_at, updated_at) VALUES (?, 'v1', 'person', ?, '', 1, NULL, 0, 0)",
        )
        .run(id, name);
    insEntity("ent1", "Alice"); // survivor (earliest rowid)
    insEntity("ent2", "Alice"); // duplicate
    insEntity("entX", "Bob");
    db.prepare(
      "INSERT INTO memory_relations (source_id, target_id, relation_type, created_at) VALUES ('ent2', 'entX', 'knows', 0)",
    ).run();

    db.exec(sql002);

    // the duplicate (ent2) is merged away; only the survivor remains for the natural key
    const alice = db
      .prepare(
        "SELECT id FROM memory_entities WHERE vault_id='v1' AND entity_type='person' AND name='Alice'",
      )
      .all() as { id: string }[];
    expect(alice.map((r) => r.id)).toEqual(["ent1"]);

    // the edge survived and was repointed ent2 -> ent1 (without the fix the ON DELETE
    // CASCADE would have dropped it when ent2 was deleted).
    const rels = db.prepare("SELECT source_id, target_id FROM memory_relations").all() as {
      source_id: string;
      target_id: string;
    }[];
    expect(rels).toEqual([{ source_id: "ent1", target_id: "entX" }]);
  });
});
