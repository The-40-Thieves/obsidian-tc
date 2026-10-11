// search.notes_fts, the part that reads the FTS STATE (fts-status.ts) rather than the integrity of
// the index: a transient lock and a real failure are different findings from a deliberate "off".
import type { FtsStatus } from "../search/fts-status";
import type { CheckResult } from "./types";

/** A warning for a lock or a real failure; undefined when the state needs no special finding. */
export function ftsStatusFinding(s: FtsStatus | undefined): CheckResult | undefined {
  if (s?.state === "recovering" || (s?.state === "unavailable" && s.reason === "lock_contention")) {
    const tries =
      s.state === "recovering" ? `attempt ${s.attempts} of ${s.max_attempts}` : "retries spent";
    return {
      status: "warning",
      summary: `notes_fts: ${s.state === "recovering" ? "RECOVERING" : "UNAVAILABLE"} — database locked (${tries}); searches use slower disk scans`,
      details: {
        notes_fts: `${s.state} (lock_contention, ${tries}): ${s.last_error ?? "database is locked"}`,
      },
      issues: [
        "another connection held cache.db's write lock when notes_fts was provisioned. This is transient: a running server retries in the background and switches full-text search back on by itself.",
      ],
      remediation:
        "Find what is holding the lock (a second server on the same cacheDir, a long `compact` or `index` run). If it persists, check `server_health.fts` on the running server.",
    };
  }
  if (
    s?.state === "unavailable" &&
    (s.reason === "provision_failed" || s.reason === "integrity_failed")
  ) {
    return {
      status: "warning",
      summary: `notes_fts FAILED (${s.reason}) — not a lock; full-text search is off until this is fixed`,
      details: { notes_fts: `unavailable (${s.reason}): ${s.last_error ?? "no detail"}` },
      issues: [
        `provisioning notes_fts failed with a non-transient error: ${s.last_error ?? "no detail"}. Searches fall back to disk scans, so results stay complete but slow.`,
      ],
      remediation:
        "A missing FTS5 module needs a SQLite build with FTS5; a corrupt index can be rebuilt with `INSERT INTO notes_fts(notes_fts) VALUES('rebuild');` against cache.db. Nothing is lost: notes_fts is derived from the notes table.",
    };
  }
  return undefined;
}
