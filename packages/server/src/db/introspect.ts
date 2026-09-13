import type { Database } from "./types";

/**
 * THE-1039: the FTS5 virtual tables this server provisions app-side (search/fts.ts's notes_fts,
 * search/chunk_fts.ts's chunk_fts) — the single list the maintenance sweep's bounded `'merge'`
 * (db/maintenance.ts), `obsidian-tc compact`'s full `'optimize'` (cli/commands/compact.ts), and
 * doctor's reclaimable-space row (cli/commands/doctor-probes.ts) all iterate, so a future FTS
 * table can be added to one and not silently missed by the other two.
 */
export const FTS_TABLE_NAMES = ["notes_fts", "chunk_fts"] as const;

/**
 * Does a table (optionally a view) exist in this database?
 *
 * This was hand-copied into five files with three subtly different SQL bodies. Four asked
 * `type = 'table'`; search/semantic.ts asked `type IN ('table', 'view')` so it would also see a view.
 * The read-ACL predicate drifted the same way and it turned into a security bug, so this is the single
 * source now. The view-matching behavior is preserved verbatim behind `includeViews`, defaulting off,
 * so every existing call is unchanged.
 */
export function tableExists(
  db: Database,
  name: string,
  opts: { includeViews?: boolean } = {},
): boolean {
  const types = opts.includeViews ? "('table', 'view')" : "('table')";
  return (
    db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type IN ${types} AND name = ?`).get(name) !==
    undefined
  );
}
