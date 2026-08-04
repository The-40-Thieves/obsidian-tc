// Tests for the write-only table gate (scripts/check-table-readers.mjs).
//
// node:test rather than vitest, for the reason check-boundaries.test.mjs documents: scripts/ sits
// outside every workspace glob and no root vitest config reaches it. `node --test scripts/*.test.mjs`.
//
// The cases below are the ones the gate is WRONG in if unpinned, and each was chosen because it
// would silently turn the gate into decoration rather than break it loudly:
//   * a table read only through a SQL VIEW is a false positive waiting to happen
//   * word-boundary bleed (job_runs vs job_runs_archive) hides a real write-only table
//   * quoted identifiers appear in this codebase alongside bare ones
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyse, declaredTables } from "./check-table-readers.mjs";

const src = (path, text) => ({ path, text });

test("declaredTables parses bare, quoted and IF NOT EXISTS forms", () => {
  const t = declaredTables(`
    CREATE TABLE notes (id TEXT);
    CREATE TABLE IF NOT EXISTS chunks (id TEXT);
    create table "quoted_one" (id TEXT);
  `);
  assert.deepEqual([...t].sort(), ["chunks", "notes", "quoted_one"]);
});

test("a table read ONLY through a SQL view is not write-only", () => {
  // The real case this defends: note_quality reaches chunk_retrievals only via the
  // chunk_access_stats VIEW. A TypeScript-only scan would call that table unread and the gate
  // would demand someone "fix" a table that is load-bearing.
  const rows = analyse({
    tables: new Set(["events"]),
    sources: [src("a.ts", `db.prepare("INSERT INTO events (id) VALUES (?)")`)],
    viewSql: `CREATE VIEW event_stats AS SELECT COUNT(*) FROM events GROUP BY kind;`,
  });
  assert.deepEqual(rows, [{ table: "events", readers: 1, writers: 1 }]);
});

test("with no view and no TS reader, the same table IS write-only", () => {
  // The negative half of the case above — proves the view is what rescued it, not the regex
  // happening to match something else.
  const rows = analyse({
    tables: new Set(["events"]),
    sources: [src("a.ts", `db.prepare("INSERT INTO events (id) VALUES (?)")`)],
    viewSql: "",
  });
  assert.deepEqual(rows, [{ table: "events", readers: 0, writers: 1 }]);
});

test("word boundaries: a longer table name does not lend its reader to a shorter one", () => {
  // Without \b, `FROM job_runs_archive` would count as a reader of `job_runs` and hide it.
  const rows = analyse({
    tables: new Set(["job_runs", "job_runs_archive"]),
    sources: [
      src("w.ts", `db.prepare("INSERT INTO job_runs (job) VALUES (?)")`),
      src("r.ts", `db.prepare("SELECT * FROM job_runs_archive")`),
    ],
    viewSql: "",
  });
  const byName = Object.fromEntries(rows.map((r) => [r.table, r]));
  assert.equal(byName.job_runs.readers, 0, "job_runs must NOT inherit the archive table's reader");
  assert.equal(byName.job_runs.writers, 1);
  assert.equal(byName.job_runs_archive.readers, 1);
});

test("quoted identifiers count on both the read and write side", () => {
  const rows = analyse({
    tables: new Set(["notes"]),
    sources: [
      src("w.ts", `db.prepare('UPDATE "notes" SET x = 1')`),
      src("r.ts", `db.prepare('SELECT * FROM "notes"')`),
    ],
    viewSql: "",
  });
  assert.deepEqual(rows, [{ table: "notes", readers: 1, writers: 1 }]);
});

test("JOIN counts as a read, not just FROM", () => {
  const rows = analyse({
    tables: new Set(["tags"]),
    sources: [
      src("w.ts", `db.prepare("INSERT INTO tags (t) VALUES (?)")`),
      src("r.ts", `db.prepare("SELECT * FROM notes JOIN tags ON tags.id = notes.id")`),
    ],
    viewSql: "",
  });
  assert.deepEqual(rows, [{ table: "tags", readers: 1, writers: 1 }]);
});

test("a table with neither reader nor writer is not reported as write-only", () => {
  // memory_entities' shape (THE-629): no writer at all. That is derived.liveness's `unwritten`
  // finding, a different defect with a different fix — this gate must not also claim it.
  const rows = analyse({
    tables: new Set(["memory_entities"]),
    sources: [src("a.ts", "// nothing touches it")],
    viewSql: "",
  });
  assert.deepEqual(rows, [{ table: "memory_entities", readers: 0, writers: 0 }]);
});
