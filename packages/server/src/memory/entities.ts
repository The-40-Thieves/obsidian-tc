// Memory entity + relation graph model (M5 / THE-181, G2.1 Domain 22).
//
// Typed accessors over the M0 memory_entities + memory_relations tables. SQLite is
// the source of truth (the optional .md materialization in materialize.ts is a
// regenerable projection). Entities are typed nodes keyed naturally by
// (vault_id, entity_type, name); observations are newline-separated facts; relations
// are typed directed edges with a (source, target, type) composite PK that makes
// link_entities naturally idempotent.
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../db/types";

/** True when an error is a SQLite UNIQUE-constraint violation (cross-driver: better-sqlite3
 *  sets code SQLITE_CONSTRAINT_UNIQUE; bun:sqlite / node:sqlite carry the message). */
export function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg);
}

/** THE-833: 'active' | 'retired'. Soft, reversible — a retired entity is filtered from
 *  get_entity / query_entity_graph by default (explicit opt-in shows it) but is never deleted; the
 *  append-only philosophy stays intact. See rename_entity in tools/m5, the reachable setter. */
export type EntityStatus = "active" | "retired";

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
  status: EntityStatus;
}

const ENTITY_COLS =
  "id, vault_id, entity_type, name, observations, materialize, vault_path, created_at, updated_at, status";

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

/** THE-1130 adversarial-review fix: the ONE boundary a single observation's text is validated at
 *  — `create_entity`'s `observations` array, `add_observation`'s `observation` field, and the
 *  memory-import adapters all call this before the text reaches SQLite. Returns the trimmed text,
 *  or `null` when it is not acceptable as ONE observation: blank after trimming, or containing a
 *  `\r` or `\n` anywhere. A caller with more than one fact makes more than one call (or passes more
 *  than one array element) — this is a REJECTION, not a silent split or a silent drop: before this
 *  fix, `parseObservations`/`serializeObservations` re-splitting the stored blob on every `\n`
 *  meant a single observation containing an embedded newline silently became TWO parsed lines
 *  sharing the ONE interval row `add_observation`/`insertEntity` inserted for it (ordinal
 *  correlation broken at the source), and a whitespace-only observation silently produced an
 *  interval row for a text line that `serializeObservations` then dropped from the blob entirely
 *  (a row with nothing to correlate to). Rejecting both up front is what keeps "one text line in
 *  the blob == one interval row" true unconditionally, rather than true-if-callers-are-well-behaved. */
export function normalizeObservationText(raw: string): string | null {
  if (/[\r\n]/.test(raw)) return null;
  const text = raw.trim();
  return text.length > 0 ? text : null;
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
  // Reuses the SAME boundary function the tool schemas validate against (normalizeObservationText)
  // rather than a second ad hoc trim/filter — a direct insertEntity() caller that skips the schema
  // (e.g. a test) gets the identical rule, silently dropping anything the schema would have
  // rejected outright. The schema is the user-facing contract; this is the internal backstop.
  const obs = (input.observations ?? [])
    .map((o) => normalizeObservationText(o))
    .filter((o): o is string => o !== null);
  db.prepare(
    `INSERT INTO memory_entities
       (id, vault_id, entity_type, name, observations, materialize, vault_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.vaultId,
    input.entityType,
    input.name,
    serializeObservations(obs),
    input.materialize === false ? 0 : 1,
    input.vaultPath ?? null,
    input.now,
    input.now,
  );
  // THE-1130: one OPEN, unkeyed interval row per initial observation, valid_from = the entity's
  // own created_at — mirrors the migration backfill's choice for pre-existing rows exactly (no
  // finer-grained timestamp exists for a batch-created observation than the entity's own creation
  // instant). Ordinal position (insertion order here == the blob's line order) is what later zips
  // each text line back to its interval row — see observationViews.
  for (const text of obs)
    insertObservationInterval(db, {
      entityId: id,
      obsHash: obsHash(text),
      key: null,
      validFrom: input.now,
      validTo: null,
      now: input.now,
    });
  const row = getEntityById(db, id) as EntityRow;
  // THE-1130 adversarial-review fix: ASSERT the lockstep invariant rather than silently trusting
  // it — observationViews throws on a text/interval-row count mismatch, and calling it here turns
  // a drift bug into an immediate, loud failure at the write that caused it instead of a confusing
  // one at some later, unrelated read.
  observationViews(db, row);
  return row;
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

export interface EntityPatch {
  name?: string;
  status?: EntityStatus;
}

/** THE-833: rename_entity's data-layer half — updates `name` and/or `status` in place, keeping the
 *  row's id (and therefore every relation pointing at it) stable. Returns the updated row, or
 *  undefined if the id doesn't exist. Callers (tools/m5) are responsible for the natural-key
 *  collision check and the materialized-note move; this function only touches SQLite. */
export function updateEntity(
  db: Database,
  id: string,
  patch: EntityPatch,
  now: number,
): EntityRow | undefined {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    args.push(patch.name);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
  }
  if (sets.length === 0) return getEntityById(db, id);
  sets.push("updated_at = ?");
  args.push(now, id);
  db.prepare(`UPDATE memory_entities SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return getEntityById(db, id);
}

/** THE-833: delete_entity's data-layer half. Removes every relation touching `id` (both
 *  directions) BEFORE the entity row itself — NOT relying on the schema's `ON DELETE CASCADE`,
 *  because `foreign_keys` is per-connection runtime state (off by default) and the test harness's
 *  `openMemoryDb()` never sets it; correctness here must not depend on a PRAGMA a caller forgot
 *  (the same reasoning acl_path_sets' eviction path documents). Returns how many relation rows
 *  were removed alongside whether the entity itself existed, so the caller can report both. */
export function deleteEntity(
  db: Database,
  id: string,
): { deleted: boolean; relationsDeleted: number } {
  const relResult = db
    .prepare("DELETE FROM memory_relations WHERE source_id = ? OR target_id = ?")
    .run(id, id);
  const entResult = db.prepare("DELETE FROM memory_entities WHERE id = ?").run(id);
  return {
    deleted: (entResult.changes as number) > 0,
    relationsDeleted: relResult.changes as number,
  };
}

/** Remove one typed relation. The inverse of `insertRelation`; `existed` distinguishes an actual
 *  removal from a no-op (the edge was already gone). */
export function deleteRelation(
  db: Database,
  sourceId: string,
  targetId: string,
  relationType: string,
): { existed: boolean } {
  const r = db
    .prepare(
      "DELETE FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = ?",
    )
    .run(sourceId, targetId, relationType);
  return { existed: (r.changes as number) > 0 };
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

// --- Observation validity intervals (THE-1130) ---
//
// memory_entities.observations carries the TEXT; memory_observation_intervals is the STRUCTURE
// layered on top, one row per observation, recording when it was true and what (if anything)
// replaced it. The actual invariant (adversarial-review correction — "never rewritten" was false,
// every append already reserializes the whole column): the column is only ever reserialized from
// its OWN normalized parse plus one appended line, inside the SAME transaction as the interval
// insert — never truncated, never has a line's TEXT edited or removed once accepted. Every accepted
// observation therefore keeps its text forever (a supersession or retirement only ever sets a
// `valid_to` on the interval row, never touches the blob), but the column bytes themselves ARE
// rewritten on every write, by design — that rewrite round-trips to a byte-identical result
// precisely because `normalizeObservationText` (this file) rejects anything that would make
// `parseObservations`/`serializeObservations` disagree about how many lines a value is. Correlation
// between a blob line and its interval row is BY ORDINAL POSITION, not by hash — see the migration
// file's own header for why. Every write path that appends a line to the blob inserts exactly one
// interval row in the same transaction, in the same order, so
// `parseObservations(row.observations)[i]` and `listObservationIntervals(db, row.id)[i]` always
// describe the same observation.

/** `^[a-z0-9][a-z0-9_.-]*$`, max 64 chars, after lowercasing — the caller-supplied key that opts
 *  an observation INTO supersession tracking (THE-1130 decision record: matching is explicit,
 *  never inferred from text). */
export const OBSERVATION_KEY_RE = /^[a-z0-9][a-z0-9_.-]*$/;

/** Lowercase + validate a caller-supplied observation key. Returns null for anything that isn't a
 *  legal key (empty, over 64 chars, or fails OBSERVATION_KEY_RE once lowercased) — the caller (a
 *  zod schema, in practice) decides what error that becomes; this function only knows the shape. */
export function normalizeObservationKey(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  if (key.length < 1 || key.length > 64) return null;
  return OBSERVATION_KEY_RE.test(key) ? key : null;
}

/** sha256 hex of the trimmed observation text (no `[key] ` rendering prefix). Informational
 *  provenance only — recorded on `superseded_by` so a closed interval names what replaced it
 *  without a second copy of the text. Never a lookup key: matching for supersession is by `key`
 *  alone — add_observation's handler finds the open interval with `observationViews(...).findIndex`
 *  over the set it already holds for rendering, rather than a second DB round-trip. */
export function obsHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

export interface ObservationIntervalRow {
  id: number;
  entity_id: string;
  obs_hash: string;
  key: string | null;
  valid_from: number;
  valid_to: number | null;
  superseded_by: string | null;
  created_at: number;
}

const OBSERVATION_INTERVAL_COLS =
  "id, entity_id, obs_hash, key, valid_from, valid_to, superseded_by, created_at";

/** One observation: its text (from the blob) zipped with its validity interval. What
 *  get_entity/query_entity_graph/materialize.ts all build their view from. */
export interface ObservationView {
  text: string;
  key: string | null;
  validFrom: number;
  validTo: number | null;
  supersededBy: string | null;
}

/** Every interval row for an entity, in the SAME order parseObservations reads its text blob
 *  (insertion order — `id` is an autoincrement rowid, never reassigned). */
export function listObservationIntervals(db: Database, entityId: string): ObservationIntervalRow[] {
  return db
    .prepare(
      `SELECT ${OBSERVATION_INTERVAL_COLS} FROM memory_observation_intervals WHERE entity_id = ? ORDER BY id`,
    )
    .all(entityId) as ObservationIntervalRow[];
}

/** Zip an entity's text blob with its interval rows by ordinal position (see this section's own
 *  header). Throws on a length mismatch — every write path keeps the two in lockstep, so a drift
 *  here means a bug or a hand-edited row, and misattributing one observation's interval to another
 *  silently is worse than failing loud. */
export function observationViews(
  db: Database,
  entity: Pick<EntityRow, "id" | "observations">,
): ObservationView[] {
  const texts = parseObservations(entity.observations);
  const intervals = listObservationIntervals(db, entity.id);
  if (texts.length !== intervals.length)
    throw new Error(
      `memory_observation_intervals drift for entity ${entity.id}: ` +
        `${texts.length} observation(s) in the text blob, ${intervals.length} interval row(s)`,
    );
  return texts.map((text, i) => {
    const iv = intervals[i] as ObservationIntervalRow;
    return {
      text,
      key: iv.key,
      validFrom: iv.valid_from,
      validTo: iv.valid_to,
      supersededBy: iv.superseded_by,
    };
  });
}

/** Observations valid at `asOfMs`: `valid_from <= asOfMs AND (valid_to IS NULL OR asOfMs <
 *  valid_to)` — THE-635's own as_of convention (an as_of in the past excludes anything added
 *  later; see get_entity/query_entity_graph's tool descriptions for the caller-facing wording). */
export function observationsAsOf(
  db: Database,
  entity: Pick<EntityRow, "id" | "observations">,
  asOfMs: number,
): ObservationView[] {
  return observationViews(db, entity).filter(
    (o) => o.validFrom <= asOfMs && (o.validTo === null || asOfMs < o.validTo),
  );
}

/** Append one interval row. Always called in lockstep with a blob text append (appendObservation,
 *  or insertEntity's own initial batch) — never on its own — so ordinal correlation holds. */
export function insertObservationInterval(
  db: Database,
  input: {
    entityId: string;
    obsHash: string;
    key: string | null;
    validFrom: number;
    validTo: number | null;
    now: number;
  },
): void {
  db.prepare(
    `INSERT INTO memory_observation_intervals (entity_id, obs_hash, key, valid_from, valid_to, superseded_by, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(input.entityId, input.obsHash, input.key, input.validFrom, input.validTo, input.now);
}

/** Close the OPEN interval for (entityId, key) — either supersession (`supersededByHash` set to
 *  the new observation's hash) or a stand-alone retirement (`supersededByHash` null: nothing
 *  replaces it). Returns false when there was no open row for that key — the caller (add_observation)
 *  turns that into invalid_input for a retirement, since there's nothing to retire. */
export function closeOpenInterval(
  db: Database,
  entityId: string,
  key: string,
  validTo: number,
  supersededByHash: string | null,
): boolean {
  const r = db
    .prepare(
      `UPDATE memory_observation_intervals SET valid_to = ?, superseded_by = ?
       WHERE entity_id = ? AND key = ? AND valid_to IS NULL`,
    )
    .run(validTo, supersededByHash, entityId, key);
  return (r.changes as number) > 0;
}
