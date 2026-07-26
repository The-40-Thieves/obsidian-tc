// THE-585: the DB-backed halves of the Prometheus gauge catalog.
//
// These lived inline in cli.ts's `serve()`, which is why three of them were never wired at all:
// `activeSessions`, `captureQueueDepth` and `elicitTokensPending` were declared in `GaugeSources`,
// registered a `# TYPE` line, and then emitted no series for many releases. Nothing tested them,
// because nothing COULD — the only construction site was buried in a 1500-line boot function.
//
// Extracting them here is the fix that keeps them fixed: a plain function over a `Database`, which
// a test can call against a real provisioned schema and assert actually returns rows.
//
// Each query is backed by an index that already existed for exactly this predicate:
//   workspace_sessions -> idx_workspace_sessions_unended  (partial, WHERE ended_at IS NULL)
//   capture_queue      -> idx_capture_uncommitted         (partial, WHERE committed_at IS NULL)
//   elicit_tokens      -> idx_elicit_tokens_expires
//
// These run SYNCHRONOUSLY on every Prometheus scrape, so the cost was measured rather than assumed.
// EXPLAIN QUERY PLAN:
//
//   active_sessions  SEARCH ... USING INDEX idx_workspace_sessions_unended | USE TEMP B-TREE FOR GROUP BY
//   capture_queue    SCAN ... USING INDEX idx_capture_uncommitted          (no temp b-tree — that
//                                                                           index leads with vault_id)
//   elicit_pending   SEARCH ... USING INDEX idx_elicit_tokens_expires      | USE TEMP B-TREE FOR GROUP BY
//
// Two of the three need a temp B-tree to group, because their partial indexes do not lead with
// `vault_id`. Measured anyway at 10x any realistic size — 50,000 sessions, 5,000 of them unended —
// that is **2.67 ms per scrape**. Not worth a schema migration for covering indexes; revisit only
// if a real deployment shows scrape latency, since the fix (adding `(vault_id) WHERE ...` partial
// indexes) is cheap whenever it IS warranted.
import type { Database } from "../db/types";
import type { GaugeSources } from "./registry";

type VaultValues = Array<{ vault: string; value: number }>;

const ACTIVE_SESSIONS_SQL =
  "SELECT vault_id AS vault, COUNT(*) AS value FROM workspace_sessions WHERE ended_at IS NULL GROUP BY vault_id";

const CAPTURE_QUEUE_SQL =
  "SELECT vault_id AS vault, COUNT(*) AS value FROM capture_queue WHERE committed_at IS NULL GROUP BY vault_id";

// "Pending" means genuinely actionable — neither consumed NOR expired. Counting expired-but-
// unconsumed tokens would report a backlog an operator can do nothing about (the sweep reaps them),
// which is worse than not reporting it: it looks like work that is stuck.
const ELICIT_PENDING_SQL =
  "SELECT vault_id AS vault, COUNT(*) AS value FROM elicit_tokens WHERE consumed_at IS NULL AND expires_at > ? GROUP BY vault_id";

// THE-197: live idempotency cache size per vault (unexpired, completed rows only).
const IDEMPOTENCY_BYTES_SQL =
  "SELECT vault_id AS vault, COALESCE(SUM(result_size), 0) AS value FROM idempotency_keys WHERE completed_at IS NOT NULL AND expires_at > ? GROUP BY vault_id";

/**
 * Build the database-backed gauge sources. Each is a thunk, read lazily at SCRAPE time — never at
 * construction — so the numbers are live rather than a boot-time snapshot.
 *
 * `now` is injectable because two of these are time-dependent, and a test that cannot control the
 * clock cannot distinguish "expired, correctly excluded" from "the query is wrong".
 */
export function databaseGaugeSources(
  db: Database,
  now: () => number = Date.now,
): Pick<
  GaugeSources,
  | "activeSessions"
  | "captureQueueDepth"
  | "elicitTokensPending"
  | "idempotencyCacheBytes"
  | "vecFingerprint"
> {
  const rows = (sql: string, ...params: unknown[]): VaultValues =>
    db.prepare(sql).all(...params) as VaultValues;
  return {
    activeSessions: () => rows(ACTIVE_SESSIONS_SQL),
    captureQueueDepth: () => rows(CAPTURE_QUEUE_SQL),
    elicitTokensPending: () => rows(ELICIT_PENDING_SQL, now()),
    idempotencyCacheBytes: () => rows(IDEMPOTENCY_BYTES_SQL, now()),
    vecFingerprint: () => activeVecFingerprint(db),
  };
}

/**
 * THE-585 (#13): the representation the vector index was actually built under.
 *
 * `vault` carries the bounded subsystem name `"index"`, NOT a vault id — and that is a finding, not
 * a shortcut. `vec_index_fingerprint` is declared `CHECK (id = 1)`: there is exactly ONE row per
 * database, so every vault sharing a cache.db shares one fingerprint. Labelling it per vault would
 * copy the same string across N series and imply a per-vault choice that does not exist.
 *
 * Returns [] when the table is absent — a cache.db that has never generated an embedding has no
 * fingerprint, and an empty series is the honest report. Emitting a placeholder would be a claim.
 */
function activeVecFingerprint(db: Database): Array<{ vault: string; fingerprint: string }> {
  try {
    const row = db.prepare("SELECT fingerprint FROM vec_index_fingerprint WHERE id = 1").get() as
      | { fingerprint?: string }
      | undefined;
    return row?.fingerprint ? [{ vault: "index", fingerprint: row.fingerprint }] : [];
  } catch {
    // Table not created yet (no embedding generated on this db). Not an error condition.
    return [];
  }
}
