// GH #995 follow-up: the leader's reconcile outcome, persisted to cache.db so a FOLLOWER process can
// report it. Only the vault-lock leader runs reconciles (vault-lock.ts gateReconcileByLeader), so a
// follower's in-memory indexHealth never leaves "pending". Written by the leader (plane-wiring.ts),
// and by a runtime add_vault's notes pass from whichever process runs it (tool-wiring.ts, notes_ready
// only); read by a follower's server_health and get_index_status (tool-wiring.ts's wireHealthTools).
// Schema: migrations/20261028_001_reconcile_state.sql.
import { tableExists } from "../db/introspect";
import { inWriteTransaction } from "../db/txn";
import { cachedPrepare, type Database } from "../db/types";
import { leaderEpochStale, readLeaderEpoch } from "../search/indexing/leader-epoch";
import { errorMessage } from "../util/errors";
import type { ReconcileHealth } from "./reconcile-outcome";

export interface PersistedReconcileState extends ReconcileHealth {
  notesReady: boolean;
}

/** `self` = this process produced the numbers it reports (it is the leader, or runs alone);
 *  `leader` = a follower reporting the leader's persisted row, or the pending default for a follower
 *  with no usable row (what the leader would report). There is no third value. */
export type ReconcileSource = "leader" | "self";

export interface ReconcileView extends PersistedReconcileState {
  source: ReconcileSource;
}

const PENDING: PersistedReconcileState = {
  reconcile: "pending",
  reconcileAt: null,
  reconcileErrors: [],
  notesReady: false,
};

/** A cache.db write is best-effort: a locked or full database must not reject the reconcile runner
 *  or cut a vault's pass short (plane-wiring.ts, tool-wiring.ts). Followers keep the previous row
 *  until a later pass lands. */
function reportPersistFailure(e: unknown): void {
  process.stderr.write(
    `[index] could not persist the reconcile state to cache.db (followers keep the previous state): ${errorMessage(e)}\n`,
  );
}

function bestEffort(write: () => void): void {
  try {
    write();
  } catch (e) {
    reportPersistFailure(e);
  }
}

/** Upsert of the outcome. A row written under another epoch is not merged into: notes_ready from a
 *  predecessor (or a demoted leader still running) never carries over. SQLite evaluates the SET
 *  right-hand sides against the row as it was before the update, so `reconcile_state.epoch` is the
 *  stored epoch. */
const UPSERT_OUTCOME =
  "INSERT INTO reconcile_state (id, state, reconcile_at, reconcile_errors, notes_ready, epoch) " +
  "VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET " +
  "state = excluded.state, reconcile_at = excluded.reconcile_at, " +
  "reconcile_errors = excluded.reconcile_errors, epoch = excluded.epoch, " +
  "notes_ready = CASE WHEN reconcile_state.epoch = excluded.epoch " +
  "THEN MAX(reconcile_state.notes_ready, excluded.notes_ready) ELSE excluded.notes_ready END";

/** notes_ready is set under the current epoch. A row from a superseded epoch is reset to pending
 *  first, so the notes-only write never leaves a predecessor's outcome showing as the leader's. */
const UPSERT_NOTES_READY =
  "INSERT INTO reconcile_state (id, notes_ready, epoch) VALUES (1, 1, ?) ON CONFLICT(id) DO UPDATE SET " +
  "state = CASE WHEN reconcile_state.epoch = excluded.epoch THEN reconcile_state.state ELSE 'pending' END, " +
  "reconcile_at = CASE WHEN reconcile_state.epoch = excluded.epoch THEN reconcile_state.reconcile_at ELSE NULL END, " +
  "reconcile_errors = CASE WHEN reconcile_state.epoch = excluded.epoch THEN reconcile_state.reconcile_errors ELSE '[]' END, " +
  "notes_ready = 1, epoch = excluded.epoch";

function writeOutcome(
  db: Database,
  health: ReconcileHealth,
  notesReady: boolean,
  epoch: number,
): void {
  cachedPrepare(db, UPSERT_OUTCOME).run(
    health.reconcile,
    health.reconcileAt,
    JSON.stringify(health.reconcileErrors),
    notesReady ? 1 : 0,
    epoch,
  );
}

/** Leader side, once per completed pass. `epoch` is the leader epoch the pass ran under; the runner
 *  skips the write altogether when a successor has promoted since (persistRunOutcome). notes_ready
 *  is monotonic within an epoch (see the upsert), so a pass that starts with `notesReady` false never
 *  clears one an earlier pass already persisted. */
export function persistReconcileState(
  db: Database,
  health: ReconcileHealth,
  notesReady: boolean,
  epoch: number,
): void {
  bestEffort(() => writeOutcome(db, health, notesReady, epoch));
}

/** Leader side, once per completed run (plane-wiring.ts's runner). A run that was aborted (shutdown,
 *  demotion), or that a successor's promotion superseded, never persists: the successor's own pass is
 *  the one followers should see. `epoch` is the run's captured leader epoch (undefined: unfenced).
 *  The stale check and the write share one write transaction, so a successor that promotes between
 *  the two cannot be overwritten. */
export function persistRunOutcome(
  db: Database,
  health: ReconcileHealth,
  notesReady: boolean,
  run: { signal: AbortSignal; epoch: number | undefined },
): void {
  if (run.signal.aborted) return;
  bestEffort(() =>
    inWriteTransaction(db, "reconcile_state", () => {
      if (leaderEpochStale(db, run.epoch)) return;
      writeOutcome(db, health, notesReady, run.epoch ?? readLeaderEpoch(db));
    }),
  );
}

/** Leader side, when the notes pass first completes: sets notes_ready and leaves the outcome alone
 *  within the same epoch. `epoch` is the epoch the pass ran under (undefined: the current one); a
 *  pass from a superseded epoch is dropped, as persistRunOutcome drops its run. */
export function persistNotesReady(db: Database, epoch?: number): void {
  bestEffort(() =>
    inWriteTransaction(db, "reconcile_state", () => {
      if (leaderEpochStale(db, epoch)) return;
      cachedPrepare(db, UPSERT_NOTES_READY).run(epoch ?? readLeaderEpoch(db));
    }),
  );
}

/** Memoised once true: the table is never dropped. A false is re-checked on every read, because the
 *  table can appear later in this process's life. */
const tableSeen = new WeakSet<Database>();

/** Defensive only: every process provisions cache.db before the health tools are wired
 *  (stores.ts, behind withBootstrapBarrier), so the table is normally there. A missing one still
 *  reads as "no row", never a throw. */
function reconcileTableExists(db: Database): boolean {
  if (tableSeen.has(db)) return true;
  if (!tableExists(db, "reconcile_state")) return false;
  tableSeen.add(db);
  return true;
}

function isReconcileState(s: unknown): s is ReconcileHealth["reconcile"] {
  return s === "pending" || s === "ok" || s === "degraded";
}

/** Copies only `{ vault, error }` (both strings) from each entry: a newer leader may write more keys,
 *  and the client's ajv check rejects any extra key. Undefined when the column is not a JSON array. */
function parseReconcileErrors(raw: string): ReconcileHealth["reconcileErrors"] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { vault, error } = entry as Record<string, unknown>;
    return typeof vault === "string" && typeof error === "string" ? [{ vault, error }] : [];
  });
}

function readRow(db: Database): PersistedReconcileState | undefined {
  if (!reconcileTableExists(db)) return undefined;
  const row = cachedPrepare(
    db,
    "SELECT state, reconcile_at, reconcile_errors, notes_ready, epoch FROM reconcile_state WHERE id = 1",
  ).get() as
    | {
        state: unknown;
        reconcile_at: number | null;
        reconcile_errors: string;
        notes_ready: number;
        epoch: number;
      }
    | undefined;
  if (!row || row.epoch !== readLeaderEpoch(db) || !isReconcileState(row.state)) return undefined;
  const reconcileErrors = parseReconcileErrors(row.reconcile_errors);
  if (reconcileErrors === undefined) return undefined;
  return {
    reconcile: row.state,
    reconcileAt: row.reconcile_at,
    reconcileErrors,
    notesReady: row.notes_ready === 1,
  };
}

/** The persisted row, or undefined when there is none, when it was written under a superseded leader
 *  epoch, when it does not parse into the known shape (a mixed-version writer), or when it cannot be
 *  read at all (a renamed column). Undefined reads as pending. Never throws. */
export function readPersistedReconcileState(db: Database): PersistedReconcileState | undefined {
  try {
    return readRow(db);
  } catch {
    return undefined;
  }
}

/** What this process reports: a leader its own in-memory state; a follower the persisted row, or
 *  pending (tagged `leader`) when there is none. */
export function reconcileView(args: {
  isFollower: boolean;
  db: Database | undefined;
  self: PersistedReconcileState;
}): ReconcileView {
  if (!args.isFollower) return { ...args.self, source: "self" };
  const persisted = args.db ? readPersistedReconcileState(args.db) : undefined;
  return { ...(persisted ?? PENDING), source: "leader" };
}
