#!/usr/bin/env node
// Attribute a cache.db / experiential.db's size to the tables and indexes inside it, and report
// what SQLite the file is being read by.
//
// WHY THIS EXISTS, AND WHY IT IS A NODE SCRIPT RATHER THAN A DOCTOR CHECK:
//
// `dbstat` is a compile-time virtual table (SQLITE_ENABLE_DBSTAT_VTAB). It is compiled into
// Node's `node:sqlite` and is NOT compiled into Bun's bundled SQLite — which is the production
// runtime. So the running server structurally cannot answer "what is in these 226 MB", and no
// doctor check can be written that would work where it matters. Measured 2026-08-05:
//
//   bun:sqlite   3.53.0   FTS5 yes   MATH_FUNCTIONS yes   DBSTAT no
//   node:sqlite  3.53.3   FTS5 yes   MATH_FUNCTIONS yes   DBSTAT yes
//
// That gap is the whole reason THE-610 ("four growth curves with no write-side enforcement")
// could describe growth without anyone being able to attribute it. This script closes it from
// the side that can: open the same file with Node, read dbstat, report.
//
// The first real run answered a question that had been open for a while — over half of a 226 MB
// cache.db is the SAME VECTORS STORED TWICE (`chunk_embeddings` 60.4 MB + sqlite-vec's own
// `vec_chunks_vector_chunks00` 56.1 MB). That is deliberate, not a leak: the brute-force cosine
// fallback reads `chunk_embeddings` when vec0 is unavailable, which is exactly the macOS case.
// Knowing which half is deliberate is the point of measuring rather than guessing.
//
// READ-ONLY by construction. It opens with readOnly and runs no DDL, no VACUUM, no ANALYZE —
// pointing it at a live production database is safe, and that is the intended use.
import { DatabaseSync } from "node:sqlite";

const MB = 1048576;

/** Feature probes worth reporting: each one changes what this codebase can do, not trivia. */
const CAPABILITIES = [
  ["FTS5", "ENABLE_FTS5"],
  ["math functions", "ENABLE_MATH_FUNCTIONS"],
  ["dbstat", "ENABLE_DBSTAT"],
  ["STAT4", "ENABLE_STAT4"],
  ["load_extension", "OMIT_LOAD_EXTENSION", true],
];

/**
 * Page-count attribution, largest first. Pure so it is testable without a database.
 * @param rows [{name, bytes}] one row per table/index
 * @returns rows with a share of the total, plus the total itself
 */
export function attribute(rows) {
  const total = rows.reduce((a, r) => a + r.bytes, 0);
  return {
    total,
    rows: [...rows]
      .sort((a, b) => b.bytes - a.bytes)
      .map((r) => ({ ...r, share: total > 0 ? r.bytes / total : 0 })),
  };
}

/** True when `flag` is present in compile options; `negated` inverts it (OMIT_* means absent). */
export function hasFlag(options, flag, negated = false) {
  const present = options.some((o) => o.includes(flag));
  return negated ? !present : present;
}

function report(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const version = db.prepare("select sqlite_version() v").get().v;
  const options = db
    .prepare("select compile_options o from pragma_compile_options")
    .all()
    .map((r) => r.o);

  console.log(`\n${path}`);
  console.log(`  read by SQLite ${version}`);
  console.log(
    `  ${CAPABILITIES.map(([label, flag, neg]) => `${label}=${hasFlag(options, flag, neg)}`).join("  ")}`,
  );

  let raw;
  try {
    raw = db.prepare("select name, sum(pgsize) b from dbstat group by name").all();
  } catch (e) {
    // The one failure mode worth naming rather than swallowing: run this under a build without
    // dbstat and you get nothing, which must not read as "the database is empty".
    console.log(
      `  dbstat UNAVAILABLE in this build — cannot attribute: ${String(e.message).slice(0, 60)}`,
    );
    db.close();
    return;
  }

  const { total, rows } = attribute(raw.map((r) => ({ name: r.name, bytes: r.b })));
  console.log(`  attributed ${(total / MB).toFixed(1)} MB across ${rows.length} objects\n`);
  for (const r of rows.slice(0, 12)) {
    console.log(
      `    ${String(r.name).padEnd(30)}${(r.bytes / MB).toFixed(1).padStart(8)} MB  ${(r.share * 100).toFixed(1).padStart(5)}%`,
    );
  }
  if (rows.length > 12) console.log(`    … ${rows.length - 12} smaller objects`);
  db.close();
}

const isMain = process.argv[1]?.endsWith("db-page-report.mjs");
if (isMain) {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (paths.length === 0) {
    console.error("usage: db-page-report <path-to.db> [more.db …]");
    console.error("  reports SQLite version, capability flags, and page attribution (read-only)");
    process.exit(2);
  }
  for (const p of paths) {
    try {
      report(p);
    } catch (e) {
      console.error(`\n${p}\n  FAILED: ${String(e.message).slice(0, 120)}`);
      process.exitCode = 1;
    }
  }
}
