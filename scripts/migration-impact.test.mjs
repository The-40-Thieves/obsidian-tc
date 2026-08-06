// Tests for scripts/migration-impact.mjs — the lookup that answers "which hand-built test
// migration chains does this migration affect?" before CI answers it one red build at a time.
//
// Two cases carry the weight, and both are failure modes a naive implementation ships with:
//
//   1. COMMENTS MUST NOT COUNT. These migration headers are long and prose-heavy, and they
//      routinely NAME other tables while explaining a decision — 20260806_001's header discusses
//      chunk_access_stats, note_quality AND chunk_retrievals before touching two of them. Counting
//      commented mentions would make nearly every migration look as though it touched half the
//      schema, and the resulting blast radius would be noise nobody reads.
//
//   2. AN EMPTY RESULT MUST BE LOAD-BEARING. A file that cannot be parsed and one that genuinely
//      touches nothing are indistinguishable from output alone. That exact trap produced a false
//      "0 sites, clean" during the ast-grep sweep that found this problem in the first place, so
//      the script exits 1 rather than reporting a comfortable zero.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pinnedMigrations, tablesTouched, usesManifest } from "./migration-impact.mjs";

test("finds CREATE, ALTER, DROP and VIEW targets", () => {
  const sql = `
    CREATE TABLE goals (id TEXT PRIMARY KEY);
    ALTER TABLE agent_episodes ADD COLUMN task_result INTEGER;
    CREATE VIEW chunk_access_stats AS SELECT 1;
    DROP VIEW chunk_access_stats;
    CREATE VIRTUAL TABLE chunk_fts USING fts5(content);
  `;
  assert.deepEqual([...tablesTouched(sql)].sort(), [
    "agent_episodes",
    "chunk_access_stats",
    "chunk_fts",
    "goals",
  ]);
});

// THE load-bearing case. Modelled on a real header: 20260806_001 spends twenty comment lines
// discussing note_quality and chunk_access_stats before its DDL touches chunk_retrievals.
test("a table NAMED ONLY IN A COMMENT is not a touched table", () => {
  const sql = `
-- THE-718: chunk_retrievals.outcome is retired. note_quality.outcome_balance follows in a separate
-- migration, and chunk_access_stats is recreated first because SQLite refuses DROP COLUMN under a
-- view. See ALTER TABLE agent_episodes elsewhere.
ALTER TABLE chunk_retrievals DROP COLUMN outcome;
  `;
  // Only the one real statement. Four other tables are named in prose and must not appear.
  assert.deepEqual([...tablesTouched(sql)], ["chunk_retrievals"]);
});

test("a migration with no DDL yields an EMPTY set, so the caller can refuse to report zero", () => {
  const sql = "-- a header and nothing else\n-- ALTER TABLE never_happens ADD COLUMN x;\n";
  assert.equal(tablesTouched(sql).size, 0);
});

test("pinnedMigrations reads both the one-line and wrapped chain spellings", () => {
  const src = `
    const CHAIN = [
      { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
      {
        version: "20260806_003",
        sql: sql("20260806_003_agent_episodes_task_result.sql"),
      },
    ];
  `;
  assert.deepEqual([...pinnedMigrations(src)].sort(), [
    "20260626_001_experiential_init.sql",
    "20260806_003_agent_episodes_task_result.sql",
  ]);
});

// The 44-file miss. An earlier regex anchored the filename to an opening quote, so every chain
// that names its migration through a PATH was invisible — which is how most of this tree spells it.
// The bug surfaced only when the script's count (15) was compared against an independent ripgrep
// tally (59); neither number is self-evidently wrong on its own.
test("finds a migration named through a PATH, not just a bare quoted filename", () => {
  const src = `const INIT_SQL = readFileSync(
      fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)), "utf8");
    runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);`;
  assert.deepEqual([...pinnedMigrations(src)], ["20260519_001_initial.sql"]);
});

// The distinction the whole script turns on: a purely manifest-driven chain needs no edit ever, a
// hand-built one may need one per migration.
test("separates manifest-driven chains from hand-built ones", () => {
  assert.equal(usesManifest('import { EXPERIENTIAL_MIGRATION_FILES } from "../src/db/x";'), true);
  assert.equal(usesManifest('const C = [{ version: "20260626_001", sql: read("a.sql") }];'), false);
});

// A file can do BOTH, and the precedence decides whether it appears in a blast radius at all.
// migrate-chain.test.ts pins an 8-migration prefix AND imports the manifest for a separate
// full-chain test. Classifying it as auto-tracked would drop it from every answer while its
// literal prefix quietly went stale — so pins must win.
test("a HYBRID file (manifest import + literal pins) counts as hand-built", () => {
  const src = `import { EXPERIENTIAL_MIGRATION_FILES } from "../src/db/migration-manifest";
    const prefix = [{ version: "20260626_001", sql: read("20260626_001_experiential_init.sql") }];`;
  assert.equal(usesManifest(src), true); // it does import the manifest...
  assert.ok(pinnedMigrations(src).size > 0); // ...and it also pins. Pins decide.
});
