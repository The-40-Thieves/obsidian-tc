// Keeps `chunks.acl_path` / `notes.acl_path` equal to what the walk says each stored name resolves to.
//
// The writers set the identity with the rows they write (persist-note-plan.ts, fts.ts), but a pass
// leaves an UNCHANGED note's rows alone, and that is exactly the population that needs this:
//   * every row that existed when migration 20261009_001 ran (marked unresolved, fail closed);
//   * a row whose symlink was re-pointed since it was indexed.
// A metadata-only write: no parsing, no embedding. The vault generation moves when anything changed,
// because the permitted-path sets and the query cache are keyed on it and both are derived from
// these identities.
import { statSync } from "node:fs";
import { inWriteTransaction, type WriteTxnHooks } from "../../db/txn";
import type { Database } from "../../db/types";
import { resolveVaultPathChecked } from "../../vault/paths";
import {
  ACL_PATH_TABLES,
  ACL_PATH_UNRESOLVED,
  hasAclPathColumn,
} from "../../vault/stored-acl-path";
import { bumpGeneration } from "../generation";

/** The ACL identity a walk entry is stored under: its symlink-resolved path, or none (UNRESOLVED) for
 *  a hard-linked file, which read_note refuses (st_nlink > 1, WalkEntry.hardLinked). */
export const walkIdentity = (e: { aclRel: string; hardLinked?: true }): string =>
  e.hardLinked ? ACL_PATH_UNRESOLVED : e.aclRel;

/** Is `abs` a regular file with a second directory entry (st_nlink > 1)? read_note refuses one, since
 *  realpath cannot see through a hard link (`allowed/x.md` may be `private/y.md`). Not statable: no. */
export function isHardLinkedFile(abs: string): boolean {
  try {
    const st = statSync(abs);
    return st.isFile() && st.nlink > 1;
  } catch {
    return false;
  }
}

/** The ACL identity of a path an index-on-write caller names (vault/paths.ts resolveVaultPathChecked):
 *  it differs from the path through a symlinked folder, and the gate and the stored row both judge
 *  THAT, never the name. null = none: an unknown root, a path that escapes, or a hard-linked file.
 *  The row is then stored unresolved, which no reader returns until a pass resolves it. */
export function indexAclIdentity(root: string | undefined, path: string): string | null {
  if (root === undefined) return null;
  try {
    const resolved = resolveVaultPathChecked(root, path);
    return isHardLinkedFile(resolved.abs) ? null : resolved.aclRel;
  } catch {
    return null;
  }
}

/** At or below this many names, read each by seek instead of scanning the vault's rows. */
const SEEK_LIMIT = 8;

/** Set the identity of every stored row whose name is a key of `identities`. Returns how many
 *  (table, name) pairs changed. */
export function syncAclPaths(
  db: Database,
  vaultId: string,
  identities: ReadonlyMap<string, string>,
  hooks?: WriteTxnHooks,
): number {
  if (identities.size === 0) return 0;
  const stale: Array<{ table: (typeof ACL_PATH_TABLES)[number]; path: string; aclPath: string }> =
    [];
  for (const table of ACL_PATH_TABLES) {
    if (!hasAclPathColumn(db, table)) continue;
    // One note (index-on-write) is a seek per table; a whole pass is one scan, not a seek per note.
    const rows =
      identities.size <= SEEK_LIMIT
        ? [...identities.keys()].flatMap(
            (p) =>
              db
                .prepare(
                  `SELECT DISTINCT path, acl_path FROM ${table} WHERE vault_id = ? AND path = ?`,
                )
                .all(vaultId, p) as Array<{ path: string; acl_path: string | null }>,
          )
        : (db
            .prepare(`SELECT DISTINCT path, acl_path FROM ${table} WHERE vault_id = ?`)
            .all(vaultId) as Array<{ path: string; acl_path: string | null }>);
    // A name with several stored identities appears once per identity; any one that differs from the
    // walk's is stale, and the UPDATE below sets them all.
    const seen = new Set<string>();
    for (const r of rows) {
      const want = identities.get(r.path);
      if (want === undefined || r.acl_path === want || seen.has(r.path)) continue;
      seen.add(r.path);
      stale.push({ table, path: r.path, aclPath: want });
    }
  }
  if (stale.length === 0) return 0;
  inWriteTransaction(
    db,
    "index_notes_flush", // a metadata write like the notes flush; no new label series for it
    () => {
      for (const s of stale)
        db.prepare(
          `UPDATE ${s.table} SET acl_path = ? WHERE vault_id = ? AND path = ? AND (acl_path IS NULL OR acl_path <> ?)`,
        ).run(s.aclPath, vaultId, s.path, s.aclPath);
      bumpGeneration(db, vaultId);
    },
    hooks,
  );
  return stale.length;
}
