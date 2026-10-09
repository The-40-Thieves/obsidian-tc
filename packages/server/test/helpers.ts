import { createRequire } from "node:module";
import type { Database } from "../src/db/types";

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

/** A name that only a derived table refers to (an edge end, a contradiction side) has no ACL
 *  identity of its own and is hidden. Seed a `notes` row per name, each its own identity. */
export function seedNotes(db: Database, vaultId: string, paths: string[]): void {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO notes (vault_id, path, title, tags, content_hash, mtime, size, indexed_at, acl_path) VALUES (?, ?, ?, '[]', ?, 0, 1, 0, ?)",
  );
  for (const p of paths) ins.run(vaultId, p, p, `h:${p}`, p);
}
