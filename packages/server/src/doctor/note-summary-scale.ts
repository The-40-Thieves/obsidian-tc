// search.note-summaries-scale (THE-891 item 5) — is a vault's note-summary brute-force scan still
// cheap, or has it grown past the ceiling search/note-summaries.ts documents?
//
// Its own module rather than more of checks.ts, same reasoning as column-liveness.ts and
// kb-health.ts: that file is already comment-dense against biome's 700-line ceiling, and this is a
// self-contained classifier. Re-exported from checks.ts so every existing importer of the doctor
// surface is unchanged.
//
// The gap this closes: `searchNoteSummaries` is a brute-force O(n) cosine scan over every embedded
// note, justified in its module header as "stays small enough" with no stated bound and no way to
// tell, from inside the system, when a vault has grown past that assumption. NOTE_SUMMARY_SCAN_CEILING
// (search/note-summaries.ts) is the derived bound; this check is what makes crossing it observable.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db/open";
import { NOTE_SUMMARY_SCAN_CEILING, noteSummaryScanCount } from "../search/note-summaries";
import type { Check, CheckStatus } from "./types";

// Re-exported so a caller of this module never needs a second import from search/note-summaries —
// the ceiling and the check that reports against it travel together.
export { NOTE_SUMMARY_SCAN_CEILING };

/** One vault's observed scan size against the ceiling. */
export interface NoteSummaryScaleState {
  vaultId: string;
  /** Rows `searchNoteSummaries` would scan for this vault — noteSummaryScanCount's result. */
  count: number;
}

export interface NoteSummaryScaleView {
  /** THE-628: the note-summary candidate stream is dark behind `retrieval.summaries.enabled`. Off
   *  means the scan never runs, so a vault sitting past the ceiling is not yet a live cost —
   *  reported as informational, never warned on, same as derived.liveness's "off by config". */
  enabled: boolean;
  /** Attached only under `--probe`; a default run stays offline and touches no store, same
   *  contract as every other store-touching check in this package. */
  probe?: () => NoteSummaryScaleState[];
}

/**
 * search.note-summaries-scale — has any vault's note-summary scan grown past the ceiling?
 *
 * A COUNT past NOTE_SUMMARY_SCAN_CEILING does not mean the scan is broken — results stay correct,
 * same posture as the vec0-fallback counter (obsidian_tc_vec_fallback_total). What degrades is
 * latency added to every search request that hits the summary candidate stream, silently, because
 * nothing else in the system measures this scan's cost.
 *
 * A warning, never a fail: a slow brute-force scan breaks no request outright. What it breaks is
 * the "stays small enough" assumption the module was shipped under.
 */
export function noteSummaryScaleCheck(view: NoteSummaryScaleView): Check {
  return {
    id: "search.note-summaries-scale",
    category: "retrieval",
    run: () => {
      if (!view.enabled) {
        return {
          status: "ok" as CheckStatus,
          summary: "note-summaries scale: off — the summary candidate stream never runs",
          details: { scale: "off (retrieval.summaries.enabled is false)" },
        };
      }
      if (!view.probe) {
        return {
          status: "ok" as CheckStatus,
          summary: "note-summaries scale (not probed): run `doctor --probe` to count rows",
          details: { scale: "not probed" },
        };
      }
      const states = view.probe();
      if (states.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: "note-summaries scale: no store to inspect",
          details: { scale: "no store" },
        };
      }
      const over = states.filter((s) => s.count > NOTE_SUMMARY_SCAN_CEILING);
      const details: Record<string, string | string[]> = {
        counts: states.map((s) => `${s.vaultId}=${s.count}`),
        ceiling: String(NOTE_SUMMARY_SCAN_CEILING),
      };
      if (over.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: `note-summaries scale: ${states.length} vault(s) checked, all under the ${NOTE_SUMMARY_SCAN_CEILING}-note ceiling`,
          details,
        };
      }
      return {
        status: "warning" as CheckStatus,
        summary: `note-summaries scale: ${over.length}/${states.length} vault(s) over the ${NOTE_SUMMARY_SCAN_CEILING}-note ceiling`,
        details,
        issues: over.map(
          (s) =>
            `vault ${s.vaultId}: ${s.count} embedded note summaries — past the ceiling where the brute-force cosine scan is still "a few ms"; see search/note-summaries.ts for the cost model`,
        ),
        remediation:
          "Not a correctness problem — results stay right, only slower. Left alone the added latency scales further with note count. A vec0-backed partition for note summaries (mirroring vec_chunks in search/vec.ts) is the intended follow-up once a vault reaches this size; see the module header on search/note-summaries.ts.",
      };
    },
  };
}

/**
 * THE-891 item 5 — per-vault row counts behind `doctor --probe`.
 *
 * Owns its own DB open/close (unlike most doctor/*.ts submodules, which leave that to the CLI)
 * because cli/commands/doctor.ts sits against biome's 700-line ceiling; the CLI's other probes stay
 * where they are. A single indexed COUNT per vault — cheap enough it could run outside `--probe`,
 * but gated the same as every other store-touching check for one consistent contract.
 */
export async function probeNoteSummariesScale(
  cacheDir: string,
  vaultIds: string[],
  // THE-935 fix round 1: required, not optional — this probe opens the SAME cache.db a live
  // server (and every other cfg-scoped opener) does, so it must not silently fall back to
  // DEFAULT_BUSY_TIMEOUT_MS when an operator has configured a different value.
  busyTimeoutMs: number,
): Promise<NoteSummaryScaleState[]> {
  const path = join(cacheDir, "cache.db");
  if (!existsSync(path)) return [];
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(path, busyTimeoutMs);
    const opened = db;
    return vaultIds.map((vaultId) => ({ vaultId, count: noteSummaryScanCount(opened, vaultId) }));
  } catch {
    return [];
  } finally {
    try {
      db?.close?.();
    } catch {
      /* closing a handle we may never have opened must not fail the run */
    }
  }
}
