// M5 memory graph model (THE-181, Domain 22): the typed entity/relation accessors
// over memory_entities + memory_relations, including observation append, idempotent
// relation insert, the incoming/outgoing edge view, and depth/direction/type-filtered
// BFS traversal with graceful handling of dangling edges.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  appendObservation,
  bfsGraph,
  findEntitiesByName,
  findEntity,
  getEntityById,
  insertEntity,
  insertRelation,
  parseObservations,
  relationsForEntity,
} from "../src/memory/entities";
import { openMemoryDb } from "./helpers";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

const V = "test";

describe("entity accessors", () => {
  it("inserts and retrieves an entity by id and by (type, name)", () => {
    const db = freshDb();
    const e = insertEntity(db, {
      vaultId: V,
      entityType: "person",
      name: "Ada Lovelace",
      observations: ["mathematician", "wrote the first algorithm"],
      now: 1000,
    });
    expect(e.id).toMatch(/^ent_[a-f0-9]{24}$/);
    expect(e.materialize).toBe(1);
    expect(parseObservations(e.observations)).toEqual([
      "mathematician",
      "wrote the first algorithm",
    ]);
    expect(getEntityById(db, e.id)?.name).toBe("Ada Lovelace");
    expect(findEntity(db, V, "person", "Ada Lovelace")?.id).toBe(e.id);
    expect(findEntity(db, V, "person", "nobody")).toBeUndefined();
  });

  it("finds same-named entities across types for ambiguity detection", () => {
    const db = freshDb();
    insertEntity(db, { vaultId: V, entityType: "person", name: "Mercury", now: 1 });
    insertEntity(db, { vaultId: V, entityType: "place", name: "Mercury", now: 2 });
    const hits = findEntitiesByName(db, V, "Mercury");
    expect(hits.map((h) => h.entity_type)).toEqual(["person", "place"]);
  });

  it("appends observations and bumps updated_at", () => {
    const db = freshDb();
    const e = insertEntity(db, { vaultId: V, entityType: "concept", name: "Recursion", now: 10 });
    const r = appendObservation(db, e.id, "calls itself", 20);
    expect(r).toEqual({ observationCount: 1, updatedAt: 20 });
    appendObservation(db, e.id, "needs a base case", 30);
    const after = getEntityById(db, e.id);
    expect(parseObservations(after?.observations ?? "")).toEqual([
      "calls itself",
      "needs a base case",
    ]);
    expect(after?.updated_at).toBe(30);
    expect(appendObservation(db, "ent_missing", "x", 40)).toBeUndefined();
  });
});

describe("relations", () => {
  it("inserts a relation idempotently on the composite key", () => {
    const db = freshDb();
    const a = insertEntity(db, { vaultId: V, entityType: "person", name: "A", now: 1 });
    const b = insertEntity(db, { vaultId: V, entityType: "project", name: "B", now: 1 });
    expect(insertRelation(db, a.id, b.id, "works_on", 5)).toEqual({ existedAlready: false });
    expect(insertRelation(db, a.id, b.id, "works_on", 6)).toEqual({ existedAlready: true });
    // A different type between the same pair is a distinct edge.
    expect(insertRelation(db, a.id, b.id, "founded", 7)).toEqual({ existedAlready: false });
  });

  it("returns incoming + outgoing edges joined to the other end", () => {
    const db = freshDb();
    const a = insertEntity(db, { vaultId: V, entityType: "person", name: "A", now: 1 });
    const b = insertEntity(db, { vaultId: V, entityType: "project", name: "B", now: 1 });
    insertRelation(db, a.id, b.id, "works_on", 5);
    const aEdges = relationsForEntity(db, a.id);
    expect(aEdges).toEqual([
      {
        relation_type: "works_on",
        direction: "out",
        other_id: b.id,
        other_name: "B",
        other_type: "project",
      },
    ]);
    const bEdges = relationsForEntity(db, b.id);
    expect(bEdges).toEqual([
      {
        relation_type: "works_on",
        direction: "in",
        other_id: a.id,
        other_name: "A",
        other_type: "person",
      },
    ]);
  });
});

describe("bfsGraph", () => {
  function chain(db: Database) {
    const a = insertEntity(db, { vaultId: V, entityType: "person", name: "A", now: 1 });
    const b = insertEntity(db, { vaultId: V, entityType: "project", name: "B", now: 1 });
    const c = insertEntity(db, { vaultId: V, entityType: "concept", name: "C", now: 1 });
    insertRelation(db, a.id, b.id, "works_on", 1);
    insertRelation(db, b.id, c.id, "uses", 1);
    return { a, b, c };
  }

  it("traverses to a depth and records distance + path", () => {
    const db = freshDb();
    const { a, b, c } = chain(db);
    const nodes = bfsGraph(db, a.id, { depth: 2, direction: "out" });
    const byId = new Map(nodes.map((n) => [n.entity.id, n]));
    expect(byId.get(b.id)?.distance).toBe(1);
    expect(byId.get(c.id)?.distance).toBe(2);
    expect(byId.get(c.id)?.path).toEqual([
      { via_entity_id: a.id, via_relation: "works_on" },
      { via_entity_id: b.id, via_relation: "uses" },
    ]);
  });

  it("respects the depth limit", () => {
    const db = freshDb();
    const { a, b, c } = chain(db);
    const nodes = bfsGraph(db, a.id, { depth: 1, direction: "out" });
    expect(nodes.map((n) => n.entity.id)).toEqual([b.id]);
    expect(nodes.some((n) => n.entity.id === c.id)).toBe(false);
  });

  it("filters by relation type and entity type", () => {
    const db = freshDb();
    const { a, b } = chain(db);
    expect(bfsGraph(db, a.id, { depth: 2, direction: "out", relationTypes: ["nope"] })).toEqual([]);
    const onlyProjects = bfsGraph(db, a.id, {
      depth: 2,
      direction: "out",
      entityTypes: ["project"],
    });
    expect(onlyProjects.map((n) => n.entity.id)).toEqual([b.id]);
  });

  it("honors direction (in vs out)", () => {
    const db = freshDb();
    const { a, b } = chain(db);
    expect(bfsGraph(db, a.id, { depth: 2, direction: "in" })).toEqual([]);
    expect(bfsGraph(db, b.id, { depth: 1, direction: "in" }).map((n) => n.entity.id)).toEqual([
      a.id,
    ]);
  });
});
