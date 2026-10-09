import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
// Loaded at runtime so Vite never statically resolves the (newish) node:sqlite builtin.
export function openMemoryDb(): any {
  const { DatabaseSync } = req("node:sqlite");
  return new DatabaseSync(":memory:");
}

/** Fixture rows are inserted raw. Stamp each one as its own ACL identity (`acl_path = path`), which
 *  is what the indexer stores for any note not reached through a symlinked folder. A row with no
 *  `acl_path` is UNRESOLVED and no reader returns it (vault/stored-acl-path.ts). */
export function stampAclPath(db: { exec(sql: string): unknown }): void {
  db.exec("UPDATE chunks SET acl_path = path WHERE acl_path IS NULL");
  db.exec("UPDATE notes SET acl_path = path WHERE acl_path IS NULL");
}
