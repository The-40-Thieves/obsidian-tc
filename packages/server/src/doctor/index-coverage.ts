// index.coverage (THE-1073) — are the notes on DISK the same set as the notes actually INDEXED?
//
// Its own module rather than more of checks.ts, same reasoning as note-summary-scale.ts and
// column-liveness.ts: checks.ts is already dense against biome's 700-line ceiling, and this is a
// self-contained per-vault classifier.
//
// The gap this closes: a note skipped this pass (THE-1073's frontmatter-YAML skip-and-warn, or any
// future per-note skip) is counted in IndexStats and named on stderr, but neither signal survives
// past the process that logged it — an operator who was not watching stderr at the exact moment has
// no way to ask "is every note on disk actually in the index right now?" `notes_ready: true` and a
// healthy chunk count both stayed green on Cave while 17 notes sat on disk, unindexed, for nine
// days (see index-vault.ts's processNote and CHANGELOG.md's THE-1073 entry) — this is the read
// surface that question needed.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db/open";
import { hasNotesTable } from "../search/fts";
import { walkVault } from "../vault/paths";
import type { Check, CheckStatus } from "./types";

/** One vault's on-disk-vs-indexed comparison. `samplePaths` is capped at 5, same shape as every
 *  other doctor sample list in this package. */
export interface IndexCoverageState {
  vaultId: string;
  notesOnDisk: number;
  notesIndexed: number;
  missing: number;
  samplePaths: string[];
}

export interface IndexCoverageView {
  /** Attached only under `--probe`; a default run stays offline and touches neither the vault
   *  filesystem nor the store, same contract as every other store-touching check in this
   *  package. */
  probe?: () => IndexCoverageState[];
}

/**
 * index.coverage — notes present on disk (readable per the vault's ACL) but absent from the
 * `notes` table.
 *
 * A WARNING, never a fail: the server keeps serving whatever IS indexed, and the gap self-heals
 * the moment the missing note's content (or its YAML) is fixed and the next index_vault pass runs.
 * What this check makes visible is the gap existing at all — see the module header for why nothing
 * else in this system could tell an operator that.
 */
export function indexCoverageCheck(view: IndexCoverageView): Check {
  return {
    id: "index.coverage",
    category: "retrieval",
    run: () => {
      if (!view.probe) {
        return {
          status: "ok" as CheckStatus,
          summary:
            "index coverage (not probed): run `doctor --probe` to compare notes on disk against the index",
          details: { coverage: "not probed" },
        };
      }
      const states = view.probe();
      if (states.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: "index coverage: no vault to inspect",
          details: { coverage: "no vault" },
        };
      }
      const short = states.filter((s) => s.missing > 0);
      const details: Record<string, string | string[]> = {
        counts: states.map((s) => `${s.vaultId}=${s.notesIndexed}/${s.notesOnDisk}`),
      };
      if (short.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: `index coverage: ${states.length} vault(s) checked, every note on disk is indexed`,
          details,
        };
      }
      const totalMissing = short.reduce((n, s) => n + s.missing, 0);
      return {
        status: "warning" as CheckStatus,
        summary: `index coverage: ${totalMissing} note(s) on disk but not indexed, across ${short.length}/${states.length} vault(s)`,
        details,
        issues: short.map(
          (s) =>
            `vault ${s.vaultId}: ${s.missing} note(s) on disk but not indexed (e.g. ${s.samplePaths.join(", ")})`,
        ),
        remediation:
          "Run index_vault to reconcile. If a note was skipped for invalid YAML frontmatter (THE-1073), fix the note's YAML first — check notes_frontmatter_failed / frontmatter_failures on the last index_vault result, or the reconcile's health.index.detail.reconcile_errors, for which path and why.",
      };
    },
  };
}

/**
 * THE-1073 — per-vault on-disk-vs-indexed counts behind `doctor --probe`.
 *
 * Owns its own DB open/close (unlike most doctor/*.ts submodules, which leave that to the CLI),
 * same reasoning as probeNoteSummariesScale: cli/commands/doctor.ts sits against biome's 700-line
 * ceiling. Walks each vault root with the SAME `walkVault` + readable filter indexVault itself uses
 * (index-vault.ts), so a note this check calls "missing" is exactly a note the next index_vault
 * pass would actually try to index.
 */
export async function probeIndexCoverage(
  cacheDir: string,
  vaults: ReadonlyArray<{ id: string; root: string; isReadable: (rel: string) => boolean }>,
  // THE-935: required, not optional — this probe opens the SAME cache.db a live server (and every
  // other cfg-scoped opener) does, so it must not silently fall back to DEFAULT_BUSY_TIMEOUT_MS
  // when an operator has configured a different value.
  busyTimeoutMs: number,
): Promise<IndexCoverageState[]> {
  const path = join(cacheDir, "cache.db");
  if (!existsSync(path)) return [];
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(path, busyTimeoutMs);
    const opened = db;
    if (!hasNotesTable(opened)) return [];
    return vaults.map(({ id, root, isReadable }) => {
      const onDisk = walkVault(root, { extensions: [".md"] })
        .map((e) => e.relPath)
        .filter(isReadable);
      const indexedRows = opened
        .prepare("SELECT path FROM notes WHERE vault_id = ?")
        .all(id) as Array<{ path: string }>;
      const indexedSet = new Set(indexedRows.map((r) => r.path));
      const missingPaths = onDisk.filter((p) => !indexedSet.has(p));
      return {
        vaultId: id,
        notesOnDisk: onDisk.length,
        notesIndexed: indexedSet.size,
        missing: missingPaths.length,
        samplePaths: missingPaths.slice(0, 5),
      };
    });
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
