// Capture / inbox queue model (M5 / THE-181, G2.1 Domain 21).
//
// A capture is staged content that has NOT yet been written to the vault — it lives
// only in the SQLite capture_queue until commit_capture materializes it to a note.
// `enqueueCapture` is the STABLE write contract the ambient capture worker (THE-175)
// targets; its shape (and the committed_at/committed_path lifecycle) must stay stable.
import { randomBytes } from "node:crypto";
import type { Database } from "../db/types";

export interface CaptureRow {
  id: string;
  vault_id: string;
  title: string | null;
  content: string;
  tags: string | null; // comma-separated
  source: string | null;
  target_path_hint: string | null;
  captured_at: number;
  committed_at: number | null;
  committed_path: string | null;
}

const CAPTURE_COLS =
  "id, vault_id, title, content, tags, source, target_path_hint, captured_at, committed_at, committed_path";

/** Stable capture id, e.g. "cap_9f2c…". 12 random bytes = 24 hex chars. */
export function genCaptureId(): string {
  return `cap_${randomBytes(12).toString("hex")}`;
}

export interface EnqueueCaptureInput {
  vaultId: string;
  content: string;
  title?: string;
  tags?: readonly string[];
  source?: string;
  targetPathHint?: string;
  now: number;
}

/** Stage content for later commit. Returns the created row. (THE-175 contract.) */
export function enqueueCapture(db: Database, input: EnqueueCaptureInput): CaptureRow {
  const id = genCaptureId();
  const tags = input.tags && input.tags.length > 0 ? input.tags.join(",") : null;
  db.prepare(
    `INSERT INTO capture_queue
       (id, vault_id, title, content, tags, source, target_path_hint, captured_at, committed_at, committed_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    id,
    input.vaultId,
    input.title ?? null,
    input.content,
    tags,
    input.source ?? null,
    input.targetPathHint ?? null,
    input.now,
  );
  return getCapture(db, id) as CaptureRow;
}

export function getCapture(db: Database, id: string): CaptureRow | undefined {
  return db.prepare(`SELECT ${CAPTURE_COLS} FROM capture_queue WHERE id = ?`).get(id) as
    | CaptureRow
    | undefined;
}

export interface ListCapturesOptions {
  committed?: boolean;
  source?: string;
  afterCursor?: string;
  limit?: number;
}

/** List captures newest-first with a composite (captured_at, id) cursor. The default
 *  lists only PENDING captures (committed_at IS NULL); committed:true lists committed. */
export function listCaptures(
  db: Database,
  vaultId: string,
  opts: ListCapturesOptions = {},
): CaptureRow[] {
  const clauses: string[] = ["vault_id = ?"];
  const params: unknown[] = [vaultId];
  clauses.push(opts.committed ? "committed_at IS NOT NULL" : "committed_at IS NULL");
  if (opts.source !== undefined) {
    clauses.push("source = ?");
    params.push(opts.source);
  }
  if (opts.afterCursor) {
    const sep = opts.afterCursor.indexOf(":");
    const ca = Number(opts.afterCursor.slice(0, sep));
    const id = opts.afterCursor.slice(sep + 1);
    clauses.push("(captured_at < ? OR (captured_at = ? AND id > ?))");
    params.push(ca, ca, id);
  }
  return db
    .prepare(
      `SELECT ${CAPTURE_COLS} FROM capture_queue WHERE ${clauses.join(" AND ")}
       ORDER BY captured_at DESC, id ASC LIMIT ?`,
    )
    .all(...params, opts.limit ?? 100) as CaptureRow[];
}

/** Cursor token encoding a row's (captured_at, id) for stable keyset pagination. */
export function captureCursor(row: CaptureRow): string {
  return `${row.captured_at}:${row.id}`;
}

export function markCommitted(
  db: Database,
  id: string,
  committedPath: string,
  now: number,
): { changes: number } {
  const res = db
    .prepare(
      "UPDATE capture_queue SET committed_at = ?, committed_path = ? WHERE id = ? AND committed_at IS NULL",
    )
    .run(now, committedPath, id);
  return { changes: res.changes };
}

export function deleteCapture(db: Database, id: string): { changes: number } {
  const res = db.prepare("DELETE FROM capture_queue WHERE id = ?").run(id);
  return { changes: res.changes };
}
