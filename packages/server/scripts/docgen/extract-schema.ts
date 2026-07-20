// docgen — schema extractor (THE-471). Provision a throwaway in-memory cache DB (runs every cache
// migration) and introspect the REAL schema via sqlite_master + PRAGMA table_info — more robust than
// regexing DDL with nested CHECK(...) parens, and always matches what the server actually creates.
import { openDatabase } from "../../src/db/open";
import { provisionCacheDb } from "../../src/db/provision";
import type { TableDoc } from "./model";

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function extractSchema(): Promise<TableDoc[]> {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);

  const tableRows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  const idxStmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );

  const out: TableDoc[] = [];
  for (const { name } of tableRows) {
    if (!SAFE_NAME.test(name)) continue; // PRAGMA can't be parameterized; names come from the schema
    const cols = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const indexes = (idxStmt.all(name) as Array<{ name: string }>).map((r) => r.name);
    out.push({
      name,
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type || "?",
        notes: c.pk ? "pk" : c.notnull ? "not null" : undefined,
      })),
      indexes,
    });
  }
  db.close?.();
  return out;
}
