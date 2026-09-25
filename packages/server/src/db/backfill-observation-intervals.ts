// THE-1130 adversarial-review fix — the `postApply` step for
// 20260925_002_memory_observation_intervals.sql (see that migration's own header). Backfills one
// OPEN, unkeyed interval row per pre-existing observation line, using the SAME `parseObservations`
// every read path already uses, rather than a second, SQL-based line-splitter that disagreed with
// it on whitespace (SQLite's `trim()` strips only ASCII space by default; JS `.trim()` also strips
// tab and CR — a real fixture with both produced 3 JS-parsed facts against 4 SQL-backfilled rows).
import { parseObservations, serializeObservations } from "../memory/entities";
import type { Database } from "./types";

interface EntityObservationsRow {
  id: string;
  observations: string;
  created_at: number;
}

/** Run once, inside the migration's own transaction (db/migrate.ts's `postApply`). For every
 *  `memory_entities` row: re-parse its text with `parseObservations`, REWRITE the column via
 *  `serializeObservations` of that exact parse when the bytes differ (so the stored blob can never
 *  again disagree with a future re-parse of itself — the fix for the SQL/JS `trim()` divergence),
 *  and insert exactly one open interval row per resulting line, in order, `valid_from` = the
 *  entity's own `created_at` (mirrors `insertEntity`'s treatment of a freshly-created batch — see
 *  that function's own comment for why no finer-grained timestamp exists). */
export function backfillObservationIntervalsJs(db: Database): void {
  const rows = db
    .prepare("SELECT id, observations, created_at FROM memory_entities")
    .all() as EntityObservationsRow[];
  const updateBlob = db.prepare("UPDATE memory_entities SET observations = ? WHERE id = ?");
  const insertInterval = db.prepare(
    `INSERT INTO memory_observation_intervals
       (entity_id, obs_hash, key, valid_from, valid_to, superseded_by, created_at)
     VALUES (?, ?, NULL, ?, NULL, NULL, ?)`,
  );
  for (const row of rows) {
    const lines = parseObservations(row.observations);
    const normalized = serializeObservations(lines);
    if (normalized !== row.observations) updateBlob.run(normalized, row.id);
    lines.forEach((_, i) => {
      // A per-line placeholder, NOT a real sha256 — see the migration file's own header: nothing
      // in application code ever dereferences a historical hash value (only `key` is used for
      // supersession lookups), so this only needs to be present and distinguishable, not
      // cryptographic. Kept namespaced under "backfill:" so it reads unmistakably as one on sight.
      insertInterval.run(row.id, `backfill:${row.id}:${i}`, row.created_at, row.created_at);
    });
  }
}
