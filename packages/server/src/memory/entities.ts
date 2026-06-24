// Memory entity + relation graph model (M5 / THE-181, G2.1 Domain 22).
//
// Typed accessors over the M0 memory_entities + memory_relations tables. SQLite is
// the source of truth (the optional .md materialization in materialize.ts is a
// regenerable projection). Entities are typed nodes keyed naturally by
// (vault_id, entity_type, name); observations are newline-separated facts; relations
// are typed directed edges with a (source, target, type) composite PK that makes
// link_entities naturally idempotent.
import { randomBytes } from "node:crypto";
import type { Database } from "../db/types";

/** True when an error is a SQLite UNIQUE-constraint violation (cross-driver: better-sqlite3
 *  sets code SQLITE_CONSTRAINT_UNIQUE; bun:sqlite / node:sqlite carry the message). */
export function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg);
}

export interface EntityRow {
  id: string;
  vault_id: string;
  entity_type: string;
  name: string;
  observations: string; // newline-separated facts
  materialize: number; // 0 | 1
  vault_path: string | null;
  created_at: number;
  updated_at: number;
}

const ENTITY_COLS =
  "id, vault_id, entity_type, name, observations, materialize, vault_path, created_at, updated_at";

/** Stable entity id, e.g. "ent_9f2c…". 12 random bytes = 24 hex chars. */
export function genEntityId(): string {
  return `ent_${randomBytes(12).toString("hex")}`;
}

/** Split stored observations into trimmed, non-empty facts. */
export function parseObservations(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Join facts into the newline-separated storage form (trimmed, de-blanked). */
export function serializeObservations(obs: readonly string[]): string {
  return obs
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
    .join("\n");
}

export function getEntityById(db: Database, id: string): EntityRow | undefined {
  return db.prepare(`SELECT ${ENTITY_COLS} FROM memory_entities WHERE id = ?`).get(id) as
    | EntityRow
    | undefined;
}

export function findEntity(
  db: Database,
  vaultId: string,
  entityType: string,
  name: string,
): EntityRow | undefined {
  return db
    .prepare(
      `SELECT ${ENTITY_COLS} FROM memory_entities WHERE vault_id = ? AND entity_type = ? AND name = ?`,
    )
    .get(vaultId, entityType, name) as EntityRow | undefined;
}

/** All entities in a vault sharing a name (across types) — for ambiguity detection
 *  when get_entity is called by name without a type. */
export function findEntitiesByName(db: Database, vaultId: string, name: string): EntityRow[] {
  return db
    .prepare(
      `SELECT ${ENTITY_COLS} FROM memory_entities WHERE vault_id = ? AND name = ? ORDER BY entity_type`,
    )
    .all(vaultId, name) as EntityRow[];
}

export interface InsertEntityInput {
  vaultId: string;
  entityType: string;
  name: string;
  observations?: readonly string[];
  materialize?: boolean;
  vaultPath?: string | null;
  now: number;
}

export function insertEntity(db: Database, input: InsertEntityInput): EntityRow {
  const id = genEntityId();
  db.prepare(
    `INSERT INTO memory_entities
       (id, vault_id, entity_type, name, observations, materialize, vault_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.vaultId,
    input.entityType,
    input.name,
    serializeObservations(input.observations ?? []),
    input.materialize === false ? 0 : 1,
    input.vaultPath ?? null,
    input.now,
    input.now,
  );
  return getEntityById(db, id) as EntityRow;
}

/** Record the materialized .md path (and bump updated_at) after a projection write. */
export function setEntityVaultPath(
  db: Database,
  id: string,
  vaultPath: string | null,
  now: number,
): void {
  db.prepare("UPDATE memory_entities SET vault_path = ?, updated_at = ? WHERE id = ?").run(
    vaultPath,
    now,
    id,
  );
}

/** Append one fact to an entity. Returns the new count, or undefined if missing. */
export function appendObservation(
  db: Database,
  id: string,
  observation: string,
  now: number,
): { observationCount: number; updatedAt: number } | undefined {
  const row = getEntityById(db, id);
  if (!row) return undefined;
  const obs = parseObservations(row.observations);
  obs.push(observation.trim());
  const next = serializeObservations(obs);
  db.prepare("UPDATE memory_entities SET observations = ?, updated_at = ? WHERE id = ?").run(
    next,
    now,
    id,
  );
  return { observationCount: parseObservations(next).length, updatedAt: now };
}

/** Insert a typed relation. Idempotent on the (source,target,type) composite PK;
 *  `existedAlready` distinguishes a no-op re-link from a fresh edge. */
export function insertRelation(
  db: Database,
  sourceId: string,
  targetId: string,
  relationType: string,
  now: number,
): { existedAlready: boolean } {
  const exists = db
    .prepare(
      "SELECT 1 FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = ?",
    )
    .get(sourceId, targetId, relationType);
  if (exists) return { existedAlready: true };
  db.prepare(
    "INSERT INTO memory_relations (source_id, target_id, relation_type, created_at) VALUES (?, ?, ?, ?)",
  ).run(sourceId, targetId, relationType, now);
  return { existedAlready: false };
}

export interface RelationEdge {
  relation_type: string;
  direction: "out" | "in";
  other_id: string;
  other_name: string;
  other_type: string;
}

/** Both incoming and outgoing edges of an entity, each joined to the other end's
 *  name + type (for get_entity output and for materialization's [[links]]). */
export function relationsForEntity(db: Database, id: string): RelationEdge[] {
  const out = db
    .prepare(
      `SELECT r.relation_type AS relation_type, r.target_id AS other_id, e.name AS other_name, e.entity_type AS other_type
       FROM memory_relations r JOIN memory_entities e ON e.id = r.target_id
       WHERE r.source_id = ? ORDER BY e.name, r.relation_type`,
    )
    .all(id) as Array<{
    relation_type: string;
    other_id: string;
    other_name: string;
    other_type: string;
  }>;
  const inc = db
    .prepare(
      `SELECT r.relation_type AS relation_type, r.source_id AS other_id, e.name AS other_name, e.entity_type AS other_type
       FROM memory_relations r JOIN memory_entities e ON e.id = r.source_id
       WHERE r.target_id = ? ORDER BY e.name, r.relation_type`,
    )
    .all(id) as Array<{
    relation_type: string;
    other_id: string;
    other_name: string;
    other_type: string;
  }>;
  return [
    ...out.map((r) => ({ ...r, direction: "out" as const })),
    ...inc.map((r) => ({ ...r, direction: "in" as const })),
  ];
}

type Direction = "out" | "in" | "both";

interface NeighborEdge {
  nid: string;
  relation_type: string;
}

function neighbors(db: Database, id: string, direction: Direction): NeighborEdge[] {
  const edges: NeighborEdge[] = [];
  if (direction === "out" || direction === "both") {
    for (const r of db
      .prepare("SELECT target_id AS nid, relation_type FROM memory_relations WHERE source_id = ?")
      .all(id) as NeighborEdge[])
      edges.push(r);
  }
  if (direction === "in" || direction === "both") {
    for (const r of db
      .prepare("SELECT source_id AS nid, relation_type FROM memory_relations WHERE target_id = ?")
      .all(id) as NeighborEdge[])
      edges.push(r);
  }
  return edges;
}

export interface GraphNode {
  entity: EntityRow;
  distance: number;
  path: Array<{ via_entity_id: string; via_relation: string }>;
}

export interface BfsOptions {
  depth?: number;
  direction?: Direction;
  relationTypes?: readonly string[];
  entityTypes?: readonly string[];
}

/**
 * Breadth-first traversal from a seed entity. Returns reachable nodes (excluding the
 * seed) up to `depth` hops, each with its distance and the (via_entity, via_relation)
 * path that first reached it. Dangling edges (a relation whose other end was deleted)
 * are skipped, not fatal.
 */
export function bfsGraph(db: Database, seedId: string, opts: BfsOptions = {}): GraphNode[] {
  const depth = Math.max(1, Math.min(opts.depth ?? 2, 5));
  const direction = opts.direction ?? "both";
  const relTypes = opts.relationTypes ? new Set(opts.relationTypes) : undefined;
  const entTypes = opts.entityTypes ? new Set(opts.entityTypes) : undefined;

  const visited = new Set<string>([seedId]);
  const out: GraphNode[] = [];
  let frontier: GraphNode["path"][] = [[]];
  let current: string[] = [seedId];

  for (let dist = 1; dist <= depth && current.length > 0; dist++) {
    const nextIds: string[] = [];
    const nextPaths: GraphNode["path"][] = [];
    for (let i = 0; i < current.length; i++) {
      const fromId = current[i] as string;
      const fromPath = frontier[i] ?? [];
      for (const edge of neighbors(db, fromId, direction)) {
        if (relTypes && !relTypes.has(edge.relation_type)) continue;
        if (visited.has(edge.nid)) continue;
        const entity = getEntityById(db, edge.nid);
        if (!entity) continue; // dangling edge — skip gracefully
        if (entTypes && !entTypes.has(entity.entity_type)) continue;
        visited.add(edge.nid);
        const path = [...fromPath, { via_entity_id: fromId, via_relation: edge.relation_type }];
        out.push({ entity, distance: dist, path });
        nextIds.push(edge.nid);
        nextPaths.push(path);
      }
    }
    current = nextIds;
    frontier = nextPaths;
  }
  return out;
}
