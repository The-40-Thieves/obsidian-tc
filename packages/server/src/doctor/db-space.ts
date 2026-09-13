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
  fileBytes: number;
  /** `freelist_count * page_size` — bytes a VACUUM would return to the filesystem. */
  freelistBytes: number;
  ftsData: FtsDataRowCount[];
}

export interface DbSpaceView {
  /** Undefined only when cache.db does not exist yet (a fresh install) — this check still runs,
   *  reporting that state, rather than being omitted like a `--probe`-gated one. */
  state?: DbSpaceState;
}

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
      if (!view.state) {
        return {
          status: "ok" as CheckStatus,
          summary: "db.reclaimable-space: no cache.db yet (fresh install)",
          details: { state: "no store" },
        };
      }
      const { fileBytes, freelistBytes, ftsData } = view.state;
      const details: Record<string, string | string[]> = {
        fileBytes: String(fileBytes),
        freelistBytes: String(freelistBytes),
        ftsData: ftsData.map((f) => `${f.table}_data=${f.dataRows} rows`),
      };
      const ratio = fileBytes > 0 ? freelistBytes / fileBytes : 0;
      if (ratio > WARN_FREELIST_RATIO) {
        return {
          status: "warning" as CheckStatus,
          summary:
            `db.reclaimable-space: cache.db is ${fileBytes} bytes; ${freelistBytes} bytes ` +
            `(${(ratio * 100).toFixed(1)}%) reclaimable by VACUUM — over the 10% floor`,
          details,
          remediation: "obsidian-tc compact",
        };
      }
      return {
        status: "ok" as CheckStatus,
        summary: `db.reclaimable-space: cache.db is ${fileBytes} bytes; ${freelistBytes} bytes reclaimable by VACUUM`,
        details,
      };
    },
  };
}
