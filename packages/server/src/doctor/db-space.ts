// db.reclaimable-space (THE-1039, GH #930) — how much of cache.db is dead weight a `compact` run
// would recover, and how big is the FTS5 index driving it?
//
// Own module rather than more of checks.ts, same reasoning as capture-location.ts and
// note-summary-scale.ts: a self-contained classifier that checks.ts does not need to carry.
// Re-exported from doctor/index.ts so every existing importer of the doctor surface is unchanged.
//
// UNLIKE most doctor/*.ts checks, this one has NO `--probe` gate: it was the cheapest version of
// GH #929/#930 to ship (a file `stat`, two PRAGMAs and a `COUNT(*)` on each present `<t>_data`
// shadow table — no write, no FTS write, no gateway call) and it is the check that would have
// surfaced the underlying growth months earlier had it existed. The probe itself
// (`probeDbSpace`) lives in cli/commands/doctor-probes.ts, alongside every other store-touching
// probe this package's CLI wires in — see that file's header for why the DB-opening code sits
// there rather than here.
import type { Check, CheckStatus } from "./types";

/** One present FTS table's shadow-storage row count — `<t>_data` holds the merged/unmerged
 *  segment bytes `'merge'`/`'optimize'` act on (see db/maintenance.ts and
 *  cli/commands/compact.ts), so this number is what actually shrinks when either runs. */
export interface FtsDataRowCount {
  table: string;
  dataRows: number;
}

export interface DbSpaceState {
  /** THE-1039 fix round 1 (A2): main file + `-wal` sidecar when present
   *  (`db/introspect.ts`'s `dbFootprintBytes`) — the SAME accounting `obsidian-tc compact` uses
   *  for its before/after sizes, so the two surfaces can't silently disagree on "how big is this
   *  database". Stated explicitly in the summary text below, not left implicit in the number. */
  fileBytes: number;
  /** `freelist_count * page_size` — bytes a VACUUM would return to the filesystem. */
  freelistBytes: number;
  ftsData: FtsDataRowCount[];
  /** THE-1039 fix round 4 (H2) — which open strategy the probe's readonly connection actually took
   *  (`db/pragmas.ts`'s `readonlyOpenFallbackable`). Only `"native"` guarantees the inspection left
   *  the file's bytes unchanged, so `"fallback"` is named in the summary instead of staying a field
   *  nothing reads. Absent when the probe predates this field (a hand-built view in a test). */
  readonlyMode?: "native" | "fallback";
}

/**
 * THE-1039 fix round 1 (A3) — `probeDbSpace` collapsed "cache.db does not exist" and "cache.db
 * exists but could not be opened" (permissions, an exclusive lock, corruption) into the same
 * `undefined`, so a READ-ONLY store reported the fresh-install line instead of a finding. Three
 * distinct states now, so each renders its own honest sentence.
 */
export type DbSpaceView =
  | { status: "missing" }
  | { status: "unopenable"; reason: string }
  | { status: "ok"; state: DbSpaceState };

/** THE-1039 ruling: warn when freelist bytes exceed 10% of the file. */
const WARN_FREELIST_RATIO = 0.1;

/**
 * db.reclaimable-space — is cache.db carrying enough dead weight that `obsidian-tc compact` is
 * worth running?
 *
 * Freelist bytes, not FTS index size, drive the verdict: the freelist is what VACUUM reclaims
 * directly and is comparable across any cause of bloat (FTS segments, deleted rows, anything
 * else), where an unmerged FTS index is the single biggest CONTRIBUTOR on a vault old enough to
 * have edited notes (GH #929) but not the only possible one. `ftsData` is reported alongside for
 * diagnosis — which table is heavy — without being the threshold itself.
 */
export function dbSpaceCheck(view: DbSpaceView): Check {
  return {
    id: "db.reclaimable-space",
    category: "storage",
    run: () => {
      if (view.status === "missing") {
        return {
          status: "ok" as CheckStatus,
          summary: "db.reclaimable-space: no cache.db yet (fresh install)",
          details: { state: "no store" },
        };
      }
      if (view.status === "unopenable") {
        return {
          status: "warning" as CheckStatus,
          summary: `db.reclaimable-space: cache.db exists but could not be opened (${view.reason})`,
          details: { state: "unopenable", reason: view.reason },
          remediation:
            "Check file permissions and whether another process holds an exclusive lock on cache.db, then run `obsidian-tc doctor` again.",
        };
      }
      const { fileBytes, freelistBytes, ftsData, readonlyMode } = view.state;
      const details: Record<string, string | string[]> = {
        fileBytes: String(fileBytes),
        freelistBytes: String(freelistBytes),
        ftsData: ftsData.map((f) => `${f.table}_data=${f.dataRows} rows`),
        ...(readonlyMode !== undefined ? { readonlyMode } : {}),
      };
      // H2: the weaker guarantee, stated in the row itself — never silent.
      const fallbackNote =
        readonlyMode === "fallback"
          ? " — inspection connection was not read-only on this platform; a dangling WAL left by an " +
            "unclean shutdown may be checkpointed on close"
          : "";
      const ratio = fileBytes > 0 ? freelistBytes / fileBytes : 0;
      if (ratio > WARN_FREELIST_RATIO) {
        return {
          status: "warning" as CheckStatus,
          summary:
            `db.reclaimable-space: cache.db is ${fileBytes} bytes (main + -wal); ${freelistBytes} ` +
            `bytes (${(ratio * 100).toFixed(1)}%) reclaimable by VACUUM — over the 10% floor${fallbackNote}`,
          details,
          remediation: "obsidian-tc compact",
        };
      }
      return {
        status: "ok" as CheckStatus,
        summary: `db.reclaimable-space: cache.db is ${fileBytes} bytes (main + -wal); ${freelistBytes} bytes reclaimable by VACUUM${fallbackNote}`,
        details,
      };
    },
  };
}
