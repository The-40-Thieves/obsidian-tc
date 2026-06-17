// Runs only under `bun test` (CI job ci-server/bun-smoke). It lives outside
// test/ so vitest (include test/**) and tsc (include src,test) ignore it; only
// Bun executes it, exercising the real bun:sqlite path that node:sqlite tests
// can't cover.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db/open";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

test("openDatabase selects bun:sqlite under Bun and round-trips the real schema", async () => {
  const db = await openDatabase(":memory:");
  db.exec(schemaSql); // full V1 multi-statement DDL must apply cleanly
  db.exec("CREATE TABLE _t (id INTEGER PRIMARY KEY, v TEXT);");
  const r = db.prepare("INSERT INTO _t (v) VALUES (?)").run("x");
  expect(r.changes).toBe(1);
  expect(Number(r.lastInsertRowid)).toBe(1);
  const got = db.prepare("SELECT v FROM _t WHERE id = ?").get(1) as { v: string };
  expect(got.v).toBe("x");
  expect(db.prepare("SELECT id FROM _t").all().length).toBe(1);
  db.close?.();
});
