// The ACL identity of a STORED index row (`chunks.acl_path` / `notes.acl_path`), as opposed to its
// display name (`path`).
//
// The index keys a note by the path it was walked under. Through a symlinked folder that is an alias
// (`wiki/x.md` for `private/x.md`), and a read ACL decides on the symlink-resolved path, never the
// name (vault/paths.ts resolveVaultPathChecked, vault/acl-read-filter.ts readableEntry). A stored
// row's name is therefore never a safe thing to authorize: every reader that filters index rows by
// the read ACL asks `storedAclPathOf` for the row's identity first, and judges THAT. The name is what
// the result is shown under.
//
//   no exception listed   the row is its own identity (`acl_path IS NULL` or `= path`).
//   listed, a path        the row is an alias; the ACL judges the path it leads to.
//   listed, null          UNRESOLVED (`acl_path = ''`, set by migration 20261009_001 on every row
//                         that predates the column, or two rows of one name disagreeing): FAIL
//                         CLOSED, the row is returned to nobody until the indexer resolves it.
import type { Database } from "../db/types";

/** `acl_path` of a row whose identity is not known yet. See migration 20261009_001. */
export const ACL_PATH_UNRESOLVED = "";

/** The tables that carry `acl_path`. A reader of either must judge its rows through this module. */
export const ACL_PATH_TABLES = ["chunks", "notes"] as const;
export type AclPathTable = (typeof ACL_PATH_TABLES)[number];

const withColumn = new WeakMap<Database, Set<AclPathTable>>();

/** Does `table` carry `acl_path` on this connection? A bare fixture with a hand-built chain
 *  predates the column and every row of it is its own identity. Only a positive answer is cached,
 *  so a migration applied later on the same handle is seen. */
export function hasAclPathColumn(db: Database, table: AclPathTable): boolean {
  const known = withColumn.get(db);
  if (known?.has(table)) return true;
  let ok = false;
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    ok = cols.some((c) => c.name === "acl_path");
  } catch {
    ok = false;
  }
  if (ok) {
    const set = known ?? new Set<AclPathTable>();
    set.add(table);
    withColumn.set(db, set);
  }
  return ok;
}

/**
 * Every stored name of this vault whose identity is NOT itself: alias rows map to their target,
 * unresolved or self-contradicting ones to null. Small by construction (aliases only; the partial
 * indexes of migration 20261009_001 serve exactly this predicate), so it is loaded whole.
 */
export function loadAclPathExceptions(db: Database, vaultId: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const table of ACL_PATH_TABLES) {
    if (!hasAclPathColumn(db, table)) continue;
    const rows = db
      .prepare(
        `SELECT DISTINCT path, acl_path FROM ${table} WHERE vault_id = ? AND acl_path IS NOT NULL AND acl_path <> path`,
      )
      .all(vaultId) as Array<{ path: string; acl_path: string }>;
    for (const r of rows) {
      const next = r.acl_path === ACL_PATH_UNRESOLVED ? null : r.acl_path;
      // Two rows of one name that name different identities cannot both be right: closed.
      if (!out.has(r.path)) out.set(r.path, next);
      else if (out.get(r.path) !== next) out.set(r.path, null);
    }
  }
  return out;
}

/**
 * The identity a reader must authorize for a STORED path, or null when it is unresolved (fail
 * closed). The exceptions are loaded on first use, so a predicate that is built and never called
 * (an unrestricted caller's) costs nothing, and one tool call sees one consistent view.
 */
export function storedAclPathOf(db: Database, vaultId: string): (storedPath: string) => string | null {
  let exceptions: Map<string, string | null> | undefined;
  return (storedPath) => {
    exceptions ??= loadAclPathExceptions(db, vaultId);
    const hit = exceptions.get(storedPath);
    return hit === undefined ? storedPath : hit;
  };
}

/**
 * A stored-path read predicate: `decide` judges the row's ACL identity (and only that — folder
 * confinement and exclusions stay on the name the caller sees). Unresolved rows are never readable.
 */
export function readableStoredRow(
  db: Database,
  vaultId: string,
  decide: (aclRel: string) => boolean,
): (storedPath: string) => boolean {
  const aclOf = storedAclPathOf(db, vaultId);
  return (storedPath) => {
    const aclRel = aclOf(storedPath);
    return aclRel !== null && decide(aclRel);
  };
}
