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
import { hasNotesTable, notesRowExpected } from "../search/fts";
import { errorMessage } from "../util/errors";
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
  /** THE-1073 fix round 1 (MEDIUM, Codex): set when THIS vault's own walk or query THREW — a
   *  symlinked root, a locked table — as opposed to a genuinely empty overall probe result (no
   *  cache.db yet, no `notes` table). The two must render differently: an error is a real failure
   *  to answer the question, not "nothing to check yet". */
  error?: string;
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
 * else in this system could tell an operator that. A per-vault PROBE FAILURE (`state.error`) warns
 * too, but with its own message — it means the question could not be answered, not that coverage
 * is fine.
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
      const errored = states.filter((s) => s.error !== undefined);
      const short = states.filter((s) => s.error === undefined && s.missing > 0);
      const details: Record<string, string | string[]> = {
        counts: states.map((s) =>
          s.error !== undefined
            ? `${s.vaultId}=ERROR`
            : `${s.vaultId}=${s.notesIndexed}/${s.notesOnDisk}`,
        ),
      };
      if (errored.length === 0 && short.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: `index coverage: ${states.length} vault(s) checked, every note on disk is indexed`,
          details,
        };
      }
      const totalMissing = short.reduce((n, s) => n + s.missing, 0);
      const summaryParts: string[] = [];
      if (totalMissing > 0)
        summaryParts.push(
          `${totalMissing} note(s) on disk but not indexed across ${short.length} vault(s)`,
        );
      if (errored.length > 0) summaryParts.push(`${errored.length} vault(s) failed to probe`);
      return {
        status: "warning" as CheckStatus,
        summary: `index coverage: ${summaryParts.join("; ")}`,
        details,
        issues: [
          ...errored.map((s) => `vault ${s.vaultId}: coverage probe failed — ${s.error}`),
          ...short.map(
            (s) =>
              `vault ${s.vaultId}: ${s.missing} note(s) on disk but not indexed (e.g. ${s.samplePaths.join(", ")})`,
          ),
        ],
        remediation:
          "For a missing-note vault: run index_vault to reconcile. If a note was skipped for invalid YAML frontmatter (THE-1073), fix the note's YAML first — check notes_frontmatter_failed / frontmatter_failures on the last index_vault result, or the reconcile's health.index.detail.reconcile_errors. For a failed-probe vault: the vault root or cache.db could not be read — check the exception in `issues` (a symlinked vault root, a locked or corrupt cache.db).",
      };
    },
  };
}

/**
 * THE-1073 — per-vault on-disk-vs-indexed counts behind `doctor --probe`.
 *
 * Owns its own DB open/close (unlike most doctor/*.ts submodules, which leave that to the CLI),
 * same reasoning as probeNoteSummariesScale: cli/commands/doctor.ts sits against biome's 700-line
 * ceiling. Walks each vault root with the SAME `walkVault` + readable filter indexVault itself
 * uses (index-vault.ts), and shares indexVault's OWN `notesRowExpected` predicate for which walked
 * files actually get a `notes` row (a zero-byte note gets none — see that function's own comment),
 * so a note this check calls "missing" is exactly a note the next index_vault pass would try to
 * write a row for and hasn't yet.
 *
 * Distinguishes "nothing to check yet" from "could not check": cache.db simply not existing yet
 * (fresh install) or lacking a `notes` table are legitimate empty results (`[]`, rendered `ok` by
 * the check above); everything else that throws — the db failing to OPEN, or one vault's own
 * walk/query failing (e.g. a symlinked root `walkVault` refuses) — is carried as that vault's
 * `error` instead of being silently swallowed into the SAME `[]` a fresh install gets. Fix round 1
 * (MEDIUM, Codex): the original cast every failure into `[]`, so a symlinked root read as a clean
 * "no vault to inspect" `ok` instead of a warning.
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
  if (!existsSync(path)) return []; // fresh install — nothing to check yet, not a failure

  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(path, busyTimeoutMs);
  } catch (e) {
    // cache.db EXISTS but could not be opened (locked, corrupt) — a real failure, one entry per
    // vault so it is not lost.
    const msg = errorMessage(e);
    return vaults.map(({ id }) => ({
      vaultId: id,
      notesOnDisk: 0,
      notesIndexed: 0,
      missing: 0,
      samplePaths: [],
      error: msg,
    }));
  }
  try {
    const opened = db;
    if (!hasNotesTable(opened)) return []; // pre-migration db — nothing to check yet
    return vaults.map(({ id, root, isReadable }): IndexCoverageState => {
      try {
        // notesRowExpected takes raw CONTENT; a walked entry only carries its byte size, but
        // "size 0" and "raw === \"\"" agree for every text file this ever sees, so this avoids
        // reading every candidate file's content just to answer the predicate.
        const onDisk = walkVault(root, { extensions: [".md"] })
          .filter((e) => isReadable(e.relPath) && notesRowExpected(e.size > 0 ? "x" : ""))
          .map((e) => e.relPath);
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
      } catch (e) {
        return {
          vaultId: id,
          notesOnDisk: 0,
          notesIndexed: 0,
          missing: 0,
          samplePaths: [],
          error: errorMessage(e),
        };
      }
    });
  } finally {
    try {
      db.close?.();
    } catch {
      /* closing a handle we may never have opened must not fail the run */
    }
  }
}
