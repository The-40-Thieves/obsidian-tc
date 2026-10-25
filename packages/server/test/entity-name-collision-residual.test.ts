// Pins the accepted one-bit residual of memory entity names (GH #1396, SECURITY.md "Known
// limitations"). A name clash is looked up by name alone, so a caller can learn that an exact name is
// taken by an entity whose stored note path it may not read. These tests pin what the caller sees:
// a clash with that hidden entity answers exactly as a clash with a visible one, the destination
// read check refuses a name-derived path the caller cannot read before the lookup, and neither
// tool moves or changes the hidden entity. If any of this changes, the residual has widened or
// closed, and SECURITY.md must change with it.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

const V = "test";
const READ_AND_WRITE = new Set(["read:memory", "write:memory"]);
// Unrestricted setup for seeding: the seeded rows and notes are not what these tests examine.
const SETUP = { acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }) };
const HIDDEN_STORED_PATH = "memory/tool/secret.md";

async function seed(v: M5Vault, name: string): Promise<string> {
  const r = await v.call("create_entity", { vault: V, type: "person", name }, SETUP);
  if (!r.ok) throw new Error(`create_entity failed: ${JSON.stringify(r.error)}`);
  return (r.data as { entity_id: string }).entity_id;
}

/** An entity named `name` whose stored vault_path sits in a folder the caller cannot read, while
 *  the path derived from its name (memory/person/<name>.md) is readable to the caller. */
async function seedDivergent(v: M5Vault, name: string): Promise<string> {
  const id = await seed(v, name);
  v.db
    .prepare("UPDATE memory_entities SET vault_path = ? WHERE id = ?")
    .run(HIDDEN_STORED_PATH, id);
  return id;
}

/** The failure envelope with the clashing name replaced by a placeholder, so a hidden clash and a
 *  visible clash on different names compare byte for byte. Nothing else is neutralised: an id or a
 *  path that leaks would make the two envelopes differ. */
function envelopeOf(r: ToolResult, name: string): string {
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.data)}`);
  return JSON.stringify(r.error).split(name).join("<name>");
}

function entityRows(v: M5Vault): string {
  return JSON.stringify(
    v.db
      .prepare("SELECT id, entity_type, name, status, vault_path FROM memory_entities ORDER BY id")
      .all(),
  );
}

describe("entity name clash does not reveal a hidden entity (create_entity)", () => {
  it("a clash with a hidden entity answers exactly like a clash with a visible one", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["memory/person/**"] } });
    try {
      const hidden = await seedDivergent(v, "Taken");
      await seed(v, "Visible");
      const hiddenClash = await v.call(
        "create_entity",
        { vault: V, type: "person", name: "Taken" },
        { grantedScopes: READ_AND_WRITE },
      );
      const visibleClash = await v.call(
        "create_entity",
        { vault: V, type: "person", name: "Visible" },
        { grantedScopes: READ_AND_WRITE },
      );
      expect(hiddenClash.ok).toBe(false);
      expect(envelopeOf(hiddenClash, "Taken")).toBe(envelopeOf(visibleClash, "Visible"));
      expect(envelopeOf(hiddenClash, "Taken")).toContain("entity already exists");
      expect(JSON.stringify(hiddenClash)).not.toContain(hidden);
      expect(JSON.stringify(hiddenClash)).not.toContain(HIDDEN_STORED_PATH);
    } finally {
      v.cleanup();
    }
  });

  it("a clash whose name-derived path the caller cannot read is refused as acl_denied before the lookup", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["memory/person/Visible.md"] } });
    try {
      const hidden = await seed(v, "Taken");
      await seed(v, "Visible");
      const r = await v.call(
        "create_entity",
        { vault: V, type: "person", name: "Taken" },
        { grantedScopes: READ_AND_WRITE },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("acl_denied");
        expect(r.error.details).toMatchObject({ op: "read" });
      }
      expect(JSON.stringify(r)).not.toContain("already exists");
      expect(JSON.stringify(r)).not.toContain(hidden);
    } finally {
      v.cleanup();
    }
  });

  it("a refused clash changes neither the hidden entity nor its note", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["memory/person/**"] } });
    try {
      await seedDivergent(v, "Taken");
      const before = entityRows(v);
      const noteBefore = v.exists("memory/person/Taken.md");
      await v.call(
        "create_entity",
        { vault: V, type: "person", name: "Taken", observations: ["intruder"] },
        { grantedScopes: READ_AND_WRITE },
      );
      expect(entityRows(v)).toBe(before);
      expect(v.exists("memory/person/Taken.md")).toBe(noteBefore);
      expect(v.exists(HIDDEN_STORED_PATH)).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});

describe("entity name clash does not reveal a hidden entity (rename_entity)", () => {
  it("a clash with a hidden entity answers exactly like a clash with a visible one", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["memory/person/**"] } });
    try {
      const hidden = await seedDivergent(v, "Taken");
      await seed(v, "Visible");
      const source = await seed(v, "Source");
      const hiddenClash = await v.call(
        "rename_entity",
        { vault: V, entity_id: source, new_name: "Taken" },
        { grantedScopes: READ_AND_WRITE },
      );
      const visibleClash = await v.call(
        "rename_entity",
        { vault: V, entity_id: source, new_name: "Visible" },
        { grantedScopes: READ_AND_WRITE },
      );
      expect(hiddenClash.ok).toBe(false);
      expect(envelopeOf(hiddenClash, "Taken")).toBe(envelopeOf(visibleClash, "Visible"));
      expect(envelopeOf(hiddenClash, "Taken")).toContain("entity already exists");
      expect(JSON.stringify(hiddenClash)).not.toContain(hidden);
      expect(JSON.stringify(hiddenClash)).not.toContain(HIDDEN_STORED_PATH);
    } finally {
      v.cleanup();
    }
  });

  it("a destination the caller cannot read is refused as acl_denied before the lookup", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["memory/person/Source.md"] } });
    try {
      const hidden = await seed(v, "Taken");
      const source = await seed(v, "Source");
      const r = await v.call(
        "rename_entity",
        { vault: V, entity_id: source, new_name: "Taken" },
        { grantedScopes: READ_AND_WRITE },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("acl_denied");
        expect(r.error.details).toMatchObject({ op: "read" });
      }
      expect(JSON.stringify(r)).not.toContain("already exists");
      expect(JSON.stringify(r)).not.toContain(hidden);
      expect(v.exists("memory/person/Source.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("a refused clash moves neither the hidden entity nor its note, nor the source", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["memory/person/**"] } });
    try {
      await seedDivergent(v, "Taken");
      const source = await seed(v, "Source");
      const before = entityRows(v);
      const noteBefore = v.exists("memory/person/Taken.md");
      await v.call(
        "rename_entity",
        { vault: V, entity_id: source, new_name: "Taken" },
        { grantedScopes: READ_AND_WRITE },
      );
      expect(entityRows(v)).toBe(before);
      expect(v.exists("memory/person/Taken.md")).toBe(noteBefore);
      expect(v.exists("memory/person/Source.md")).toBe(true);
      expect(v.exists(HIDDEN_STORED_PATH)).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});
