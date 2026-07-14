import type { Database } from "./types";

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
