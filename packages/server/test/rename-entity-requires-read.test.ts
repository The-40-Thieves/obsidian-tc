// rename_entity carries an entity's note (its observations, and any frontmatter the note holds) from
// the old path to the new one, so it needs the same read that get_entity needs: the memory read
// scope AND the folder read ACL on the entity. A caller that may write memory but not read it must
// be refused before anything moves, a destination it may not read is refused before the collision
// lookup, and a neighbour it may not read stays silent in the response.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

const V = "test";
const WRITE_ONLY = new Set(["write:memory"]);
const READ_AND_WRITE = new Set(["read:memory", "write:memory"]);
// Only the public folder and the two notes under test are readable; the hidden neighbour is not.
const SETUP = { acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }) };

async function seed(
  v: M5Vault,
  type: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await v.call("create_entity", { vault: V, type, name, ...extra }, SETUP);
  if (!r.ok) throw new Error(`create_entity failed: ${JSON.stringify(r.error)}`);
  return (r.data as { entity_id: string }).entity_id;
}

/** The error of a failed call, with every occurrence of `id` neutralised so two calls that differ
 *  only in WHICH id the caller sent compare byte for byte. */
function errorOf(r: ToolResult, id: string): string {
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.data)}`);
  return JSON.stringify(r.error).split(id).join("<id>");
}

describe("rename_entity needs the memory read scope", () => {
  it("a caller with write:memory but not read:memory is refused and the note does not move", async () => {
    const v = makeM5Vault();
    try {
      const id = await seed(v, "person", "Old", { observations: ["private fact"] });
      const byName = await v.call(
        "rename_entity",
        { vault: V, entity_id: id, new_name: "New" },
        { grantedScopes: WRITE_ONLY },
      );
      expect(byName.ok).toBe(false);
      if (!byName.ok) expect(byName.error.code).toBe("forbidden");
      const byStatus = await v.call(
        "rename_entity",
        { vault: V, entity_id: id, status: "retired" },
        { grantedScopes: WRITE_ONLY },
      );
      expect(byStatus.ok).toBe(false);
      expect(v.exists("memory/person/Old.md")).toBe(true);
      expect(v.exists("memory/person/New.md")).toBe(false);
      expect(v.db.prepare("SELECT name, status FROM memory_entities WHERE id = ?").get(id)).toEqual(
        { name: "Old", status: "active" },
      );
    } finally {
      v.cleanup();
    }
  });

  it("a caller with read:memory and write:memory still renames the entity", async () => {
    const v = makeM5Vault();
    try {
      const id = await seed(v, "person", "Old", { observations: ["fact"] });
      const r = await v.call(
        "rename_entity",
        { vault: V, entity_id: id, new_name: "New" },
        { grantedScopes: READ_AND_WRITE },
      );
      expect(r.ok).toBe(true);
      expect(v.exists("memory/person/New.md")).toBe(true);
      expect(v.exists("memory/person/Old.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("an entity the folder ACL hides and a nonexistent one get byte-identical refusals", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["public/**"] } });
    try {
      const id = await seed(v, "person", "Hidden");
      const real = await v.call(
        "rename_entity",
        { vault: V, entity_id: id, new_name: "Z" },
        { grantedScopes: READ_AND_WRITE },
      );
      const missing = await v.call(
        "rename_entity",
        { vault: V, entity_id: "ent_nonexistent", new_name: "Z" },
        { grantedScopes: READ_AND_WRITE },
      );
      expect(errorOf(real, id)).toBe(errorOf(missing, "ent_nonexistent"));
      expect(v.exists("memory/person/Hidden.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("a destination the caller cannot read is refused before the name-collision lookup", async () => {
    // Old is readable; New is not, and an entity already named New sits at its path.
    const v = makeM5Vault({ acl: { readPaths: ["memory/person/Old.md"] } });
    try {
      const id = await seed(v, "person", "Old");
      await seed(v, "person", "New");
      const r = await v.call(
        "rename_entity",
        { vault: V, entity_id: id, new_name: "New" },
        { grantedScopes: READ_AND_WRITE },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("acl_denied");
        expect(JSON.stringify(r.error)).not.toContain("already exists");
      }
      expect(v.exists("memory/person/Old.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("an unreadable neighbour is not named, counted or touched by a rename", async () => {
    const v = makeM5Vault({
      acl: { readPaths: ["memory/person/Target.md", "memory/person/New.md"] },
    });
    try {
      const target = await seed(v, "person", "Target");
      const hidden = await seed(v, "tool", "Hidden");
      await v.call(
        "link_entities",
        { vault: V, source_id: hidden, target_id: target, relation_type: "uses" },
        SETUP,
      );
      const r = await v.call(
        "rename_entity",
        { vault: V, entity_id: target, new_name: "New" },
        { grantedScopes: READ_AND_WRITE },
      );
      expect(r.ok).toBe(true);
      if (r.ok)
        expect((r.data as { neighbors_rematerialized: number }).neighbors_rematerialized).toBe(0);
      expect(JSON.stringify(r)).not.toContain("Hidden");
      expect(JSON.stringify(r)).not.toContain(hidden);
    } finally {
      v.cleanup();
    }
  });
});
