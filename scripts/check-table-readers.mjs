#!/usr/bin/env node
// Write-only table gate (THE-720 follow-up): a table that production WRITES and nothing production
// READS is dead work — cost with no consumer.
//
// WHY THIS IS A SOURCE SCAN AND NOT A DOCTOR CHECK. `derived.liveness` and
// `derived.column-liveness` both answer "is this being WRITTEN". Neither can answer "is anything
// READING it", because that is a property of the source, not of the store — and it is exactly the
// case they are blind to. `audit_reports` holds 299 rows in production: both checks report it
// `live`, green, no warning, while no tool, doctor check or read surface has ever surfaced one.
// A table can be perfectly live and perfectly pointless.
//
// The two failure modes are mirror images and need opposite fixes:
//   * orphaned CONSUMER — read, never written  -> build the producer (derived.column-liveness sees this)
//   * orphaned PRODUCER — written, never read  -> build the reader, or stop writing (THIS gate)
//
// VIEWS COUNT AS READERS, and getting that wrong is the obvious way to write a gate full of false
// positives. `chunk_access_stats` is a SQL VIEW over `chunk_retrievals`; a TypeScript-only scan
// would call that table unread while note_quality depends on it transitively.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "packages/server/src/migrations");
const SRC = join(ROOT, "packages/server/src");

/**
 * Tables that production writes and nothing production reads, with the reason each is tolerated.
 * A ticket is not optional here: "we might read it later" is how a table accrues rows for a year.
 */
export const WRITE_ONLY_ALLOWLIST = new Map([
  [
    "retrieval_policy",
    "THE-538 logs arm/propensity/per-stream weights for OFF-POLICY evaluation. Its consumer is " +
      "THE-539 (learned fusion weights), ICEBOXED on entry criteria — so this is deliberately " +
      "collecting training data ahead of a deferred model. Revisit when THE-539 leaves the icebox.",
  ],
]);

const listFiles = (dir, ext, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) listFiles(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
};

/** Table names declared by the migration chain. */
export function declaredTables(sqlText) {
  const out = new Set();
  for (const m of sqlText.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?([a-z_][a-z0-9_]*)/gi,
  ))
    out.add(m[1]);
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// `\b` after the name stops `job_runs` matching `job_runs_archive`. Optional quoting on both sides
// because the codebase writes both `FROM chunks` and `FROM "chunks"`.
const readRe = (t) => new RegExp(String.raw`(?:FROM|JOIN)\s+["'\`]?${esc(t)}["'\`]?\b`, "i");
const writeRe = (t) =>
  new RegExp(
    String.raw`(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+["'\`]?${esc(t)}["'\`]?\b`,
    "i",
  );

export function analyse({ tables, sources, viewSql }) {
  const rows = [];
  for (const t of [...tables].sort()) {
    const rr = readRe(t);
    const wr = writeRe(t);
    // A VIEW that selects from the table is a real consumer — note_quality reads chunk_retrievals
    // only through chunk_access_stats.
    const readers = sources.filter((s) => rr.test(s.text)).length + (rr.test(viewSql) ? 1 : 0);
    const writers = sources.filter((s) => wr.test(s.text)).length;
    rows.push({ table: t, readers, writers });
  }
  return rows;
}

function main() {
  const sqlFiles = listFiles(MIGRATIONS, ".sql");
  const allSql = sqlFiles.map((f) => readFileSync(f, "utf8")).join("\n");
  const tables = declaredTables(allSql);

  // Production sources only. Tests are excluded ON PURPOSE: all three write-only tables found in
  // the 2026-08-04 census are read by their own tests and by nothing else, so counting tests as
  // readers would hide precisely what this gate exists to find.
  const sources = listFiles(SRC, ".ts")
    .filter((f) => !f.endsWith(".test.ts") && !f.includes(`${"/"}migrations${"/"}`))
    .map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, "utf8") }));

  const rows = analyse({ tables, sources, viewSql: allSql });

  // FLOORS. A source scan that matches nothing reports a clean bill of health, and this repo has
  // shipped that twice. Both of these must hold or the gate is not measuring anything.
  if (tables.size < 20) {
    console.error(
      `table-readers gate: only ${tables.size} tables parsed from ${sqlFiles.length} migration(s) — ` +
        "the CREATE TABLE scan is broken, not the schema.",
    );
    process.exit(1);
  }
  const withReaders = rows.filter((r) => r.readers > 0).length;
  if (withReaders < 10) {
    console.error(
      `table-readers gate: only ${withReaders} tables have any reader — the FROM/JOIN scan is ` +
        "broken. A gate that finds no readers would flag every table and be muted immediately.",
    );
    process.exit(1);
  }

  const writeOnly = rows.filter((r) => r.writers > 0 && r.readers === 0);
  const unexpected = writeOnly.filter((r) => !WRITE_ONLY_ALLOWLIST.has(r.table));
  // An allowlisted table that gained a reader must leave the list, or the list rots into decoration.
  const stale = [...WRITE_ONLY_ALLOWLIST.keys()].filter((t) => {
    const row = rows.find((r) => r.table === t);
    return !row || row.readers > 0 || row.writers === 0;
  });

  console.log(
    `table-readers gate: ${tables.size} tables, ${withReaders} with readers, ` +
      `${writeOnly.length} write-only (${unexpected.length} unexpected)`,
  );
  for (const r of writeOnly) {
    const why = WRITE_ONLY_ALLOWLIST.get(r.table);
    console.log(
      why
        ? `  allowed    ${r.table}  (${why.slice(0, 60)}…)`
        : `  WRITE-ONLY ${r.table}  (${r.writers} writer(s), 0 readers)`,
    );
  }
  for (const t of stale)
    console.error(
      `table-readers gate: ${t} is no longer write-only — remove it from the allowlist`,
    );

  if (unexpected.length > 0) {
    console.error(
      `\ntable-readers gate: ${unexpected.length} table(s) are written by production and read by ` +
        "nothing.\nEither build the read surface, stop writing them, or add them to " +
        "WRITE_ONLY_ALLOWLIST with a ticket saying why the data is worth keeping.",
    );
  }
  process.exit(unexpected.length > 0 || stale.length > 0 ? 1 : 0);
}

// Importing this module (the tests do, to reach the exported helpers) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
