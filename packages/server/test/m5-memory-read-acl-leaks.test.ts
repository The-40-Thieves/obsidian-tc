// Memory read ACL, second pass: the write/lifecycle tools and the projection note must not become a
// side channel for entities the caller's read ACL hides. Every case runs the review's setup: the
// caller holds read:memory + write:memory, readPaths ["memory/person/**"], writes unrestricted;
// `Ada` (person) is readable, `Hidden` (tool) is not, and an admin has linked them.
import { type ToolResult, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import type { CallerContext } from "../src/mcp/registry";
import { insertEntity } from "../src/memory/entities";
import { entityNotePath, sanitizeSegment } from "../src/memory/materialize";
import { readableRel } from "../src/vault/acl-read-filter";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

const V = VaultId.parse("test");
const CALLER = { readPaths: ["memory/person/**"] };
const SETUP: Partial<CallerContext> = {
  acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  now: () => 100,
};

async function make(
  v: M5Vault,
  type: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await v.call("create_entity", { vault: V, type, name, ...extra }, SETUP);
  if (!r.ok) throw new Error(`create_entity failed: ${JSON.stringify(r.error)}`);
  return (r.data as { entity_id: string }).entity_id;
}

async function link(v: M5Vault, source: string, target: string, type = "knows"): Promise<void> {
  const r = await v.call(
    "link_entities",
    { vault: V, source_id: source, target_id: target, relation_type: type },
    SETUP,
  );
  if (!r.ok) throw new Error(`link_entities failed: ${JSON.stringify(r.error)}`);
}

/** A failed call's error as JSON with each id replaced by its label, so two worlds with different
 *  random ids compare byte for byte. */
function shape(r: ToolResult, labels: Record<string, string> = {}): string {
  let text = JSON.stringify(r.ok ? { data: r.data } : { error: r.error });
  for (const [id, label] of Object.entries(labels)) text = text.split(id).join(label);
  return text;
}

/** Ada with (hiddenEdge) or without a link to a `Hidden` tool entity, in a fresh vault. */
async function world(
  hiddenEdge: boolean,
  over: { acl?: Record<string, unknown>; materialize?: boolean } = {},
) {
  const v = makeM5Vault({ acl: { ...CALLER, ...over.acl } });
  const ada = await make(v, "person", "Ada", { materialize: over.materialize ?? true });
  const hidden = hiddenEdge ? await make(v, "tool", "Hidden", { observations: ["secret"] }) : "";
  if (hiddenEdge) {
    await link(v, hidden, ada, "uses");
    await link(v, ada, hidden, "knows");
  }
  return { v, ada, hidden };
}

describe("create_entity is not an existence oracle (finding 1)", () => {
  for (const materialize of [true, false]) {
    it(`unreadable target: existing row == absent row, materialize=${materialize}`, async () => {
      const existing = makeM5Vault({ acl: CALLER });
      const absent = makeM5Vault({ acl: CALLER });
      try {
        await make(existing, "tool", "Hidden", { materialize });
        const input = { vault: V, type: "tool", name: "Hidden", materialize };
        const a = await existing.call("create_entity", input);
        const b = await absent.call("create_entity", input);
        expect(!a.ok && a.error.code).toBe("acl_denied");
        expect(shape(a)).toBe(shape(b));
        expect(absent.db.prepare("SELECT COUNT(*) AS n FROM memory_entities").get()).toEqual({
          n: 0,
        });
      } finally {
        existing.cleanup();
        absent.cleanup();
      }
    });
  }

  it("a readable collision is still reported (the caller could read that entity anyway)", async () => {
    const v = makeM5Vault({ acl: CALLER });
    try {
      await make(v, "person", "Ada");
      const r = await v.call("create_entity", { vault: V, type: "person", name: "Ada" });
      expect(!r.ok && r.error.code).toBe("invalid_input");
      expect(shape(r)).toContain("entity already exists");
    } finally {
      v.cleanup();
    }
  });

  it("rename_entity onto an unreadable collision: existing == absent", async () => {
    const acl = { readPaths: ["memory/person/A*"] };
    const existing = makeM5Vault({ acl });
    const absent = makeM5Vault({ acl });
    try {
      for (const v of [existing, absent]) await make(v, "person", "Ada");
      await make(existing, "person", "Zed");
      const id = (v: M5Vault) =>
        (v.db.prepare("SELECT id FROM memory_entities WHERE name = 'Ada'").get() as { id: string })
          .id;
      const a = await existing.call("rename_entity", {
        vault: V,
        entity_id: id(existing),
        new_name: "Zed",
      });
      const b = await absent.call("rename_entity", {
        vault: V,
        entity_id: id(absent),
        new_name: "Zed",
      });
      expect(!a.ok && a.error.code).toBe("acl_denied");
      expect(shape(a, { [id(existing)]: "<id>" })).toBe(shape(b, { [id(absent)]: "<id>" }));
    } finally {
      existing.cleanup();
      absent.cleanup();
    }
  });
});

describe("delete_entity / rename_entity do not report hidden relations (finding 2)", () => {
  for (const cascade of [false, true]) {
    it(`delete cascade=${cascade}: Ada with a hidden edge == Ada with none`, async () => {
      const x = await world(true);
      const y = await world(false);
      try {
        const a = await x.v.callConfirmed("delete_entity", {
          vault: V,
          entity_id: x.ada,
          cascade,
        });
        const b = await y.v.callConfirmed("delete_entity", {
          vault: V,
          entity_id: y.ada,
          cascade,
        });
        expect(a.ok).toBe(true);
        const norm = (r: ToolResult, id: string) => {
          if (!r.ok) return shape(r);
          const { trashed_to: _t, vault_path: _p, ...rest } = r.data as Record<string, unknown>;
          return shape({ ok: true, data: rest } as ToolResult, { [id]: "<id>" });
        };
        expect(norm(a, x.ada)).toBe(norm(b, y.ada));
        expect((a.ok && (a.data as { relations_deleted: number }).relations_deleted) || 0).toBe(0);
      } finally {
        x.v.cleanup();
        y.v.cleanup();
      }
    });
  }

  it("a VISIBLE relation still refuses without cascade, listing only visible neighbours", async () => {
    const x = await world(true);
    try {
      const zed = await make(x.v, "person", "Zed");
      await link(x.v, x.ada, zed);
      const r = await x.v.callConfirmed("delete_entity", { vault: V, entity_id: x.ada });
      expect(!r.ok && r.error.code).toBe("invalid_input");
      const text = shape(r);
      expect(text).not.toContain(x.hidden);
      expect(text).not.toContain("Hidden");
      const d = (r as unknown as { error: { details: { relation_count: number } } }).error.details;
      expect(d.relation_count).toBe(1);
      const c = await x.v.callConfirmed("delete_entity", {
        vault: V,
        entity_id: x.ada,
        cascade: true,
      });
      expect(c.ok && (c.data as { relations_deleted: number }).relations_deleted).toBe(1);
    } finally {
      x.v.cleanup();
    }
  });

  it("the confirmation state_fp ignores hidden edges and follows visible ones", async () => {
    const fp = async (v: M5Vault, id: string): Promise<string> => {
      const r = await v.call("delete_entity", { vault: V, entity_id: id });
      const d = (r as unknown as { error: { details: { state_fp?: string } } }).error.details;
      return d.state_fp as string;
    };
    const x = await world(false, { materialize: false });
    try {
      const before = await fp(x.v, x.ada);
      const hidden = await make(x.v, "tool", "Hidden");
      await link(x.v, hidden, x.ada, "uses");
      await link(x.v, x.ada, hidden, "knows");
      expect(await fp(x.v, x.ada)).toBe(before);
      const zed = await make(x.v, "person", "Zed");
      await link(x.v, x.ada, zed);
      expect(await fp(x.v, x.ada)).not.toBe(before);
    } finally {
      x.v.cleanup();
    }
  });

  for (const writable of [true, false]) {
    it(`rename with a hidden incoming neighbour (its note writable=${writable}): same response as none`, async () => {
      const acl = writable ? {} : { writePaths: ["memory/person/**"] };
      const x = await world(true, { acl });
      const y = await world(false, { acl });
      try {
        const run = (w: typeof x) =>
          w.v.call(
            "rename_entity",
            { vault: V, entity_id: w.ada, new_name: "Ada2" },
            { now: () => 200 },
          );
        const a = await run(x);
        const b = await run(y);
        expect(a.ok).toBe(true);
        expect(shape(a, { [x.ada]: "<id>" })).toBe(shape(b, { [y.ada]: "<id>" }));
        expect(
          (a.ok && (a.data as { neighbors_rematerialized: number }).neighbors_rematerialized) || 0,
        ).toBe(0);
        // Best effort, never reported: a writable hidden note follows the rename; an unwritable
        // one is left as it was.
        const note = x.v.read("memory/tool/Hidden.md");
        expect(note.includes("[[Ada2]]")).toBe(writable);
      } finally {
        x.v.cleanup();
        y.v.cleanup();
      }
    });
  }

  it("cascade delete with a hidden, unwritable incoming neighbour surfaces no path or name", async () => {
    const x = await world(true, { acl: { writePaths: ["memory/person/**"] } });
    try {
      const r = await x.v.callConfirmed("delete_entity", {
        vault: V,
        entity_id: x.ada,
        cascade: true,
      });
      expect(r.ok).toBe(true);
      expect(shape(r)).not.toContain("Hidden");
    } finally {
      x.v.cleanup();
    }
  });
});

describe("the projection note names its relation targets (finding 3: ACCEPTED residual)", () => {
  it("a reader of Ada's note sees [[Hidden]] but none of Hidden's observations; get_entity omits it", async () => {
    const x = await world(true);
    try {
      // The note is shared vault content: the caller may read it (readableRel) and it carries the
      // link, exactly as any readable note containing [[Private Note]] names that note. Changing
      // this is a deliberate decision (documented in SECURITY.md), not a drive-by.
      expect(readableRel(x.v.acl, "memory/person/Ada.md", [])).toBe(true);
      expect(readableRel(x.v.acl, "memory/tool/Hidden.md", [])).toBe(false);
      const note = x.v.read("memory/person/Ada.md");
      expect(note).toContain("[[Hidden]]");
      expect(note).not.toContain("secret");
      const got = await x.v.call("get_entity", { vault: V, entity_id: x.ada });
      expect(got.ok && (got.data as { relations: unknown[] }).relations).toEqual([]);
      const hidden = await x.v.call("get_entity", { vault: V, entity_id: x.hidden });
      expect(hidden.ok).toBe(false);
    } finally {
      x.v.cleanup();
    }
  });
});

describe("path collisions and dot segments (finding 4)", () => {
  it("sanitizeSegment / entityNotePath reject '.' and '..'", () => {
    for (const s of [".", "..", " .. "]) expect(() => sanitizeSegment(s), s).toThrow();
    expect(() => entityNotePath("memory", "..", "Secret")).toThrow();
    expect(() => entityNotePath("memory", "person", "..")).toThrow();
    expect(() => entityNotePath("memory/../x", "person", "A")).toThrow();
    expect(entityNotePath("memory", "person", "Ada")).toBe("memory/person/Ada.md");
    expect(sanitizeSegment("   ")).toBe("untitled");
  });

  for (const materialize of [true, false]) {
    it(`create_entity with a '..' / '.' type or name is invalid_input (materialize=${materialize})`, async () => {
      const v = makeM5Vault({ acl: { readPaths: ["memory/**"] } });
      try {
        for (const [type, name] of [
          ["..", "Secret"],
          [".", "Secret"],
          ["person", ".."],
          ["person", "."],
        ]) {
          const r = await v.call("create_entity", { vault: V, type, name, materialize });
          expect(!r.ok && r.error.code, `${type}/${name}`).toBe("invalid_input");
        }
        expect(v.db.prepare("SELECT COUNT(*) AS n FROM memory_entities").get()).toEqual({ n: 0 });
      } finally {
        v.cleanup();
      }
    });
  }

  it("rename_entity to '..' is invalid_input and leaves the entity alone", async () => {
    const v = makeM5Vault();
    try {
      const id = await make(v, "person", "Ada");
      const r = await v.call("rename_entity", { vault: V, entity_id: id, new_name: ".." });
      expect(!r.ok && r.error.code).toBe("invalid_input");
      expect(v.db.prepare("SELECT name FROM memory_entities WHERE id = ?").get(id)).toEqual({
        name: "Ada",
      });
    } finally {
      v.cleanup();
    }
  });

  it("an existing row whose path would escape the folder fails closed for a restricted caller", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["memory/**"] } });
    try {
      const row = insertEntity(v.db, {
        vaultId: "test",
        entityType: "..",
        name: "Secret",
        observations: ["x"],
        materialize: false,
        now: 1,
      });
      const byId = await v.call("get_entity", { vault: V, entity_id: row.id });
      const byName = await v.call("get_entity", { vault: V, type: "..", name: "Secret" });
      expect(byId.ok).toBe(false);
      expect(byName.ok).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("note_exists never names a hidden owner: `Hidden:` exists, create `Hidden-`", async () => {
    const v = makeM5Vault({ acl: CALLER });
    try {
      const hidden = await make(v, "tool", "Hidden:");
      const r = await v.call("create_entity", { vault: V, type: "tool", name: "Hidden-" });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe("acl_denied");
      expect(shape(r)).not.toContain(hidden);
      expect(shape(r)).not.toContain("Hidden:");
    } finally {
      v.cleanup();
    }
  });

  it("note_exists on a READABLE path still hides an owner whose stored location is unreadable", async () => {
    const v = makeM5Vault({ acl: CALLER });
    try {
      const owner = await make(v, "person", "Z:ed");
      v.db
        .prepare("UPDATE memory_entities SET vault_path = ? WHERE id = ?")
        .run("memory/tool/old.md", owner);
      const r = await v.call("create_entity", { vault: V, type: "person", name: "Z-ed" });
      expect(r.ok).toBe(false);
      expect(shape(r)).not.toContain(owner);
    } finally {
      v.cleanup();
    }
  });

  it("note_exists on a readable path keeps naming a readable owner", async () => {
    const v = makeM5Vault({ acl: CALLER });
    try {
      const owner = await make(v, "person", "Z:ed");
      const r = await v.call("create_entity", { vault: V, type: "person", name: "Z-ed" });
      expect(!r.ok && r.error.code).toBe("note_exists");
      expect(shape(r)).toContain(owner);
    } finally {
      v.cleanup();
    }
  });
});
