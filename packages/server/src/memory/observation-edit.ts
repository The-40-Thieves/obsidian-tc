// Addressing and closing ONE observation (update_observation's data layer). An observation's
// address is its interval row's rowid: never reassigned, so stable across reads and writes, and
// it exists for every observation already stored (keyless ones included), so no migration.
import type { Database } from "../db/types";

/** Wire form of an observation's address, e.g. `obs_42`. */
export function formatObservationId(id: number): string {
  return `obs_${id}`;
}

/** Inverse of formatObservationId; null for anything that is not `obs_<positive integer>`. */
export function parseObservationId(raw: string): number | null {
  const m = /^obs_([1-9][0-9]{0,14})$/.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

/** Close ONE interval by its row id (update_observation's path — the observation has an address
 *  even when it has no key): a correction (`supersededByHash` = the replacement's hash) or a
 *  retirement (null). Only an OPEN row of `entityId` is touched; false means no such open row. */
export function closeIntervalById(
  db: Database,
  entityId: string,
  intervalId: number,
  validTo: number,
  supersededByHash: string | null,
): boolean {
  const r = db
    .prepare(
      `UPDATE memory_observation_intervals SET valid_to = ?, superseded_by = ?
       WHERE id = ? AND entity_id = ? AND valid_to IS NULL`,
    )
    .run(validTo, supersededByHash, intervalId, entityId);
  return r.changes > 0;
}
