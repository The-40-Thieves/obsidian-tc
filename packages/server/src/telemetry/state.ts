// THE-1125 — durable half of opt-in telemetry: the install id (telemetry_state, one row, id=1)
// and the outcome of the last send attempt, so `doctor`/`server_health`/`telemetry status` can
// report lastSendAt/lastError across process restarts. Everything ELSE telemetry needs (the
// in-process counters) is deliberately NOT here — see collector.ts, which never touches cache.db.
import { randomUUID } from "node:crypto";
import type { Database } from "../db/types";

export interface TelemetryState {
  installId: string;
  lastSendAt: number | null;
  lastError: string | null;
}

/** Read the one telemetry_state row, or null when the feature has never sent/rotated anything
 *  (the row is created lazily by getOrCreateInstallId, not by the migration). */
export function readTelemetryState(db: Database): TelemetryState | null {
  const row = db
    .prepare(
      "SELECT install_id AS installId, last_send_at AS lastSendAt, last_error AS lastError FROM telemetry_state WHERE id = 1",
    )
    .get() as
    | { installId: string; lastSendAt: number | null; lastError: string | null }
    | undefined;
  return row ?? null;
}

/** Return the current install id, creating one (a fresh random UUID, never derived from anything
 *  vault- or principal-identifying) on first call. Idempotent: a second call on an already-seeded
 *  cache.db returns the SAME id rather than rotating it — only `resetInstallId` rotates. */
export function getOrCreateInstallId(db: Database, now: () => number = Date.now): string {
  const existing = readTelemetryState(db);
  if (existing) return existing.installId;
  const installId = randomUUID();
  db.prepare(
    "INSERT INTO telemetry_state (id, install_id, last_send_at, last_error, created_at) VALUES (1, ?, NULL, NULL, ?)",
  ).run(installId, now());
  return installId;
}

/** `obsidian-tc telemetry reset-id`: replace the install id with a fresh random UUID. Does NOT
 *  touch last_send_at/last_error — rotating identity says nothing about send history. Returns the
 *  new id. */
export function resetInstallId(db: Database, now: () => number = Date.now): string {
  const installId = randomUUID();
  const changed = db
    .prepare("UPDATE telemetry_state SET install_id = ? WHERE id = 1")
    .run(installId).changes;
  if (changed === 0) {
    db.prepare(
      "INSERT INTO telemetry_state (id, install_id, last_send_at, last_error, created_at) VALUES (1, ?, NULL, NULL, ?)",
    ).run(installId, now());
  }
  return installId;
}

/** Record the outcome of one send attempt. `error` undefined means the send succeeded (clears
 *  last_error); a string means it failed with that message (never a secret — see sender.ts, which
 *  only ever passes a transport-error message or an HTTP status line, never response bytes). */
export function recordSendResult(db: Database, outcome: { at: number; error?: string }): void {
  const changed = db
    .prepare("UPDATE telemetry_state SET last_send_at = ?, last_error = ? WHERE id = 1")
    .run(outcome.at, outcome.error ?? null).changes;
  if (changed === 0) {
    // No row yet (a send somehow ran before getOrCreateInstallId — defensive, should not happen
    // in practice since the sender always resolves installId first): seed one with a fresh id
    // rather than silently dropping the outcome.
    db.prepare(
      "INSERT INTO telemetry_state (id, install_id, last_send_at, last_error, created_at) VALUES (1, ?, ?, ?, ?)",
    ).run(randomUUID(), outcome.at, outcome.error ?? null, outcome.at);
  }
}
