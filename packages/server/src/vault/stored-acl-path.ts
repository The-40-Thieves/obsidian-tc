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
//   a path        the row is its own identity (`acl_path = path`) or an alias; the ACL judges the path
//                 it leads to. chunks and notes must name the SAME one.
//   null          UNRESOLVED (`acl_path IS NULL` or `''`: every row that predates migration
//                 20261009_001, or a writer that did not supply an identity), two rows of one name
//                 disagreeing (chunks against notes included, a self-identity row too), or no row at
//                 all (a derived record whose chunks/notes rows are gone): FAIL CLOSED, the name is
//                 returned to nobody until the indexer resolves it. A missing identity is never read
//                 as "trusted".
import type { Database } from "../db/types";

/** What a writer stores for a row whose identity it could not resolve (NULL means the same, and is
 *  what every row has before a pass resolves it). Both are UNRESOLVED: no reader returns the row.
 *  See migration 20261009_001. */
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
 * The identity a reader must authorize for a STORED path, or null when it is unresolved (fail
 * closed). One rule for every reader (`currentIdentityOf`, below): a name with no row, an unresolved
 * row, or chunks and notes naming different identities (a self-identity row included) is null.
 */
export function storedAclPathOf(
  db: Database,
  vaultId: string,
): (storedPath: string) => string | null {
  return currentIdentityOf(db, vaultId);
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
  const identityOf = currentIdentityOf(db, vaultId);
  return (storedPath) => {
    const aclRel = identityOf(storedPath);
    return aclRel !== null && decide(aclRel);
  };
}

/**
 * The identity of a stored path judged against the CURRENT chunks/notes rows, or null (fail closed)
 * when there is none to judge: a name with no row (a derived record that outlived its alias), an
 * unresolved row, or chunks and notes naming different identities. Only a connection with no
 * `acl_path` column at all keeps the old rule that a name is its own identity.
 */
function currentIdentityOf(db: Database, vaultId: string): (storedPath: string) => string | null {
  let tables: AclPathTable[] | undefined;
  const cache = new Map<string, string | null>();
  return (storedPath) => {
    tables ??= ACL_PATH_TABLES.filter((t) => hasAclPathColumn(db, t));
    if (tables.length === 0) return storedPath;
    if (cache.has(storedPath)) return cache.get(storedPath) ?? null;
    const identities = new Set<string | null>();
    for (const table of tables) {
      const rows = db
        .prepare(`SELECT DISTINCT acl_path FROM ${table} WHERE vault_id = ? AND path = ?`)
        .all(vaultId, storedPath) as Array<{ acl_path: string | null }>;
      for (const r of rows)
        identities.add(
          r.acl_path === null || r.acl_path === ACL_PATH_UNRESOLVED ? null : r.acl_path,
        );
    }
    const only = identities.size === 1 ? [...identities][0] : null;
    cache.set(storedPath, only ?? null);
    return only ?? null;
  };
}
