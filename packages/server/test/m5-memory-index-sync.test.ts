// Memory writes keep the search index in step with the projection notes they commit: every
// note a memory tool writes is re-indexed with its bytes, every note it removes is de-indexed,
// and a refused call touches neither hook. Assertions read the hook spies, never the store.
import { describe, expect, it, vi } from "vitest";
import { makeM5Vault } from "./m5-helpers";

const ENTITY = (type: string, name: string): string => `memory/${type}/${name}.md`;

async function createEntity(
  v: ReturnType<typeof makeM5Vault>,
  type: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await v.call("create_entity", { vault: "test", type, name, ...extra });
  if (!r.ok) throw new Error(`create_entity failed: ${JSON.stringify(r.error)}`);
  return (r.data as { entity_id: string }).entity_id;
}

async function firstObservationId(
  v: ReturnType<typeof makeM5Vault>,
  entityId: string,
): Promise<string> {
  const r = await v.call("get_entity", { vault: "test", entity_id: entityId });
  if (!r.ok) throw new Error(`get_entity failed: ${JSON.stringify(r.error)}`);
  return (r.data as { observations: { observation_id: string }[] }).observations[0]
    ?.observation_id as string;
}

function spies() {
  return { reindex: vi.fn(), deindex: vi.fn() };
}

describe("memory writes reindex the projection they commit", () => {
  it("create_entity reindexes the new note once, with the bytes on disk", async () => {
    const s = spies();
    const v = makeM5Vault(s);
    try {
      await createEntity(v, "person", "Alice");
      expect(s.reindex.mock.calls).toEqual([
        ["test", ENTITY("person", "Alice"), v.read(ENTITY("person", "Alice"))],
      ]);
      expect(s.deindex).not.toHaveBeenCalled();
    } finally {
      v.cleanup();
    }
  });

  it("create_entity with materialize: false reindexes nothing", async () => {
    const s = spies();
    const v = makeM5Vault(s);
    try {
      await createEntity(v, "person", "Alice", { materialize: false });
      expect(s.reindex).not.toHaveBeenCalled();
    } finally {
      v.cleanup();
    }
  });

  it("link_entities reindexes only the source note, with its bytes on disk", async () => {
    const s = spies();
    const v = makeM5Vault(s);
    try {
      const alice = await createEntity(v, "person", "Alice");
      const bob = await createEntity(v, "person", "Bob");
      s.reindex.mockClear();
      const r = await v.call("link_entities", {
        vault: "test",
        source_id: bob,
        target_id: alice,
        relation_type: "knows",
      });
      expect(r.ok).toBe(true);
      expect(s.reindex.mock.calls).toEqual([
        ["test", ENTITY("person", "Bob"), v.read(ENTITY("person", "Bob"))],
      ]);
    } finally {
      v.cleanup();
    }
  });

  it("add_observation and update_observation reindex the entity's note once each", async () => {
    const s = spies();
    const v = makeM5Vault(s);
    try {
      const alice = await createEntity(v, "person", "Alice", { observations: ["Likes tea"] });
      const observationId = await firstObservationId(v, alice);
      s.reindex.mockClear();
      const added = await v.call("add_observation", {
        vault: "test",
        entity_id: alice,
        observation: "Lives in Lisbon",
      });
      expect(added.ok).toBe(true);
      expect(s.reindex.mock.calls.map((c) => c[1])).toEqual([ENTITY("person", "Alice")]);
      s.reindex.mockClear();
      const updated = await v.call("update_observation", {
        vault: "test",
        entity_id: alice,
        observation_id: observationId,
        observation: "Likes coffee",
      });
      expect(updated.ok).toBe(true);
      expect(s.reindex.mock.calls.map((c) => c[1])).toEqual([ENTITY("person", "Alice")]);
      expect(s.reindex.mock.calls[0]?.[2]).toBe(v.read(ENTITY("person", "Alice")));
    } finally {
      v.cleanup();
    }
  });

  it("rename reindexes the new and neighbour note paths and never the old one", async () => {
    const s = spies();
    const v = makeM5Vault(s);
    try {
      const alice = await createEntity(v, "person", "Alice");
      const bob = await createEntity(v, "person", "Bob");
      await v.call("link_entities", {
        vault: "test",
        source_id: bob,
        target_id: alice,
        relation_type: "knows",
      });
      s.reindex.mockClear();
      s.deindex.mockClear();
      const r = await v.call("rename_entity", {
        vault: "test",
        entity_id: alice,
        new_name: "Alice2",
      });
      expect(r.ok).toBe(true);
      const paths = s.reindex.mock.calls.map((c) => c[1]);
      expect(paths.sort()).toEqual([ENTITY("person", "Alice2"), ENTITY("person", "Bob")]);
      expect(paths).not.toContain(ENTITY("person", "Alice"));
      expect(s.deindex.mock.calls).toEqual([["test", ENTITY("person", "Alice")]]);
    } finally {
      v.cleanup();
    }
  });

  it("delete_entity deindexes the note when trashed", async () => {
    const s = spies();
    const v = makeM5Vault(s);
    try {
      const alice = await createEntity(v, "person", "Alice");
      s.reindex.mockClear();
      const r = await v.callConfirmed("delete_entity", {
        vault: "test",
        entity_id: alice,
        cascade: false,
        permanent: false,
      });
      expect(r.ok).toBe(true);
      expect(s.deindex.mock.calls).toEqual([["test", ENTITY("person", "Alice")]]);
    } finally {
      v.cleanup();
    }
  });

  it("delete_entity deindexes the note when permanent", async () => {
    const s = spies();
    const v = makeM5Vault(s);
    try {
      const alice = await createEntity(v, "person", "Alice");
      s.deindex.mockClear();
      const r = await v.callConfirmed("delete_entity", {
        vault: "test",
        entity_id: alice,
        cascade: false,
        permanent: true,
      });
      expect(r.ok).toBe(true);
      expect(s.deindex.mock.calls).toEqual([["test", ENTITY("person", "Alice")]]);
    } finally {
      v.cleanup();
    }
  });

  it("refused calls (rename collision, unconfirmed delete) touch neither hook", async () => {
    const s = spies();
    const v = makeM5Vault(s);
    try {
      const alice = await createEntity(v, "person", "Alice");
      await createEntity(v, "person", "Alice2");
      s.reindex.mockClear();
      s.deindex.mockClear();
      const collision = await v.call("rename_entity", {
        vault: "test",
        entity_id: alice,
        new_name: "Alice2",
      });
      expect(collision.ok).toBe(false);
      const unconfirmed = await v.call("delete_entity", {
        vault: "test",
        entity_id: alice,
        cascade: false,
        permanent: false,
      });
      expect(unconfirmed.ok).toBe(false);
      expect(s.reindex).not.toHaveBeenCalled();
      expect(s.deindex).not.toHaveBeenCalled();
    } finally {
      v.cleanup();
    }
  });

  it("a throwing reindex hook does not fail a committed call", async () => {
    const v = makeM5Vault({
      reindex: () => {
        throw new Error("indexer down");
      },
    });
    try {
      const r = await v.call("create_entity", { vault: "test", type: "person", name: "Alice" });
      expect(r.ok).toBe(true);
      expect(v.exists(ENTITY("person", "Alice"))).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});
