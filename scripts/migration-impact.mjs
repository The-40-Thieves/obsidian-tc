#!/usr/bin/env node
// Answer "which TEST migration chains does this new migration affect?" — before CI answers it for
// you, one red build at a time.
//
// WHY THIS EXISTS. Adding a migration has three documented steps (add the .sql, append it to
// db/migration-manifest.ts, regenerate the embedded copy) and all three are gated:
// `migrations-manifest.test.ts` asserts every .sql on disk is registered in exactly one chain, and
// `migrations:embed:check` asserts the embedded copy matches. There is a FOURTH consequence and it
// is gated by nothing:
//
//   62 test files hand-build their OWN literal migration chain. Only 16 read the manifest.
//
// So a new migration silently leaves 62 independent chains behind, and you discover which ones
// mattered by watching CI go red. Measured on 2026-08-06, adding three experiential migrations in
// one night cost THREE separate CI rounds — 20260806_003 broke reflect-evaluator + forget,
// _004 broke citation, _005 broke citation again — each found by a failing build rather than by
// knowing the set in advance.
//
// THE DUPLICATION IS DELIBERATE AND THIS SCRIPT DOES NOT FIGHT IT. citation.test.ts states the
// rationale: "this chain is minimal by choice, so each addition is a deliberate statement that the
// function under test now depends on it." A minimal chain makes a test's schema dependencies
// explicit; a manifest-driven one would silently hand every test every future table, and a test
// that passes because of a table it never meant to depend on is worse than one that fails loudly.
// The defect was never the duplication — it was that the affected set was unknowable in advance.
// This makes it knowable. It is a LOOKUP, not a gate.
//
// It is deliberately NOT a gate, and that is not timidity. Whether a chain that CREATEs table T
// actually breaks when a migration ALTERs T depends on whether the code under test touches the new
// column — which is not statically decidable. A gate would fire on chains that are genuinely fine,
// and this repo's own rule is that a gate needs a non-empty floor and must be watched failing
// before it is trusted. A false-positive gate trains people to ignore it.
//
// EXITS 1 WHEN THE MIGRATION NAMES NO TABLE. That is the load-bearing part. A structural query that
// fails to parse and one that genuinely matches nothing are indistinguishable from their output —
// the exact trap that produced a false "0 sites, clean" during the ast-grep sweep that found this
// problem. A zero here must mean "no chains create these tables", never "I could not read the file".
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const MIGRATIONS = join(ROOT, "packages/server/src/migrations");
const TESTS = join(ROOT, "packages/server/test");

/** Tables and views a migration TOUCHES: creates, alters, or drops.
 *
 *  Regex rather than a SQL parser, deliberately. These migrations are hand-written, in-repo, and
 *  uniformly shaped — every one is a plain CREATE/ALTER/DROP with the name on the same line. A
 *  tree-sitter SQL grammar would be a second unpinned dependency for no additional correctness on
 *  this corpus. The trade is stated rather than hidden: if a migration ever wraps a DDL statement
 *  in something exotic, this under-reports, and the exit-1-on-empty guard below is what catches it. */
export function tablesTouched(sql) {
  const out = new Set();
  const patterns = [
    /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)/gi,
    /\bALTER\s+TABLE\s+["`[]?(\w+)/gi,
    /\bCREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)/gi,
    /\bDROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?["`[]?(\w+)/gi,
    /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`[]?(\w+)/gi,
  ];
  // Strip -- comments first: these headers are long, prose-heavy, and routinely NAME other tables
  // while explaining a decision. Counting those would make almost every migration look as though
  // it touched half the schema.
  const code = sql.replace(/^\s*--.*$/gm, "");
  for (const re of patterns) {
    for (const m of code.matchAll(re)) out.add(m[1]);
  }
  return out;
}

/** The .sql files a test file pins in a hand-built chain.
 *
 *  Matches the FILENAME anywhere, not a quoted-string-starting-with-it. That distinction is not
 *  cosmetic: an earlier version anchored to the opening quote and silently missed every chain that
 *  names its migration through a path —
 *
 *      new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)
 *
 *  which is how 44 of the 59 hand-built chains in this tree spell it. The under-count was caught
 *  only by cross-checking against an independent ripgrep tally (59 vs the 15 this returned), which
 *  is the whole argument for never trusting a structural query's number until a second, differently
 *  constructed measurement agrees with it. */
export function pinnedMigrations(testSrc) {
  const out = new Set();
  for (const m of testSrc.matchAll(/(\d{8}_\d{3}_[a-z0-9_]+\.sql)/g)) out.add(m[1]);
  return out;
}

/** Does this test read the production manifest instead of hand-building? Those track new
 *  migrations automatically and never need editing. */
export function usesManifest(testSrc) {
  return /EXPERIENTIAL_MIGRATION_FILES|CACHE_MIGRATION_FILES/.test(testSrc);
}

function readMigration(name) {
  const file = name.endsWith(".sql") ? name : `${name}.sql`;
  return readFileSync(join(MIGRATIONS, basename(file)), "utf8");
}

/** Which test files would need their chain extended for a migration touching `targets`. */
export function affectedTests(targets) {
  const affected = [];
  const manifestDriven = [];
  for (const f of readdirSync(TESTS).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(TESTS, f), "utf8");
    const pinned = pinnedMigrations(src);
    // ORDER MATTERS, and getting it wrong silently drops files from the answer. A file can do
    // BOTH: migrate-chain.test.ts pins an 8-migration prefix AND imports the manifest for a
    // separate full-chain test. An earlier version early-returned on usesManifest(), which filed
    // that hybrid as fully auto-tracked and omitted it from every blast radius — even though its
    // literal prefix is exactly the thing that needs editing. Pins decide; manifest use is
    // reported alongside, never instead.
    if (pinned.size === 0) {
      if (usesManifest(src)) manifestDriven.push(f);
      continue;
    }
    // A chain is affected when it CREATES a table the migration touches — that is the chain whose
    // schema is now behind production for that table. A chain that never creates it cannot break.
    const creates = new Set();
    for (const p of pinned) {
      try {
        for (const t of tablesTouched(readMigration(p))) creates.add(t);
      } catch {
        // A pinned file that no longer exists is a different defect (migrations are append-only,
        // so this should be impossible); migrations-manifest.test.ts owns it. Skip rather than
        // fail the lookup.
      }
    }
    const hit = [...targets].filter((t) => creates.has(t));
    if (hit.length > 0) affected.push({ file: f, tables: hit, pinned: pinned.size });
  }
  return { affected, manifestDriven };
}

function main() {
  const arg = process.argv[2];
  if (!arg || arg === "--help") {
    process.stdout.write(
      "usage: node scripts/migration-impact.mjs <migration.sql>\n" +
        "       node scripts/migration-impact.mjs --all\n\n" +
        "Lists the hand-built TEST migration chains a migration affects.\n",
    );
    process.exit(arg ? 0 : 2);
  }

  if (arg === "--all") {
    let literal = 0;
    let manifest = 0;
    for (const f of readdirSync(TESTS).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(TESTS, f), "utf8");
      // Same precedence as affectedTests: a hybrid counts as hand-built, because its literal
      // prefix still needs editing whatever else it also reads.
      if (pinnedMigrations(src).size > 0) literal += 1;
      else if (usesManifest(src)) manifest += 1;
    }
    process.stdout.write(
      `migration chains in test/:\n` +
        `  ${manifest} read the manifest (auto-track new migrations)\n` +
        `  ${literal} hand-build a literal chain (may need editing per migration)\n`,
    );
    process.exit(0);
  }

  let sql;
  try {
    sql = readMigration(arg);
  } catch (e) {
    process.stderr.write(`migration-impact: cannot read ${arg} — ${e?.message ?? e}\n`);
    process.exit(1);
  }

  const targets = tablesTouched(sql);
  if (targets.size === 0) {
    // See the header: a zero from an unreadable file must never look like a clean result.
    process.stderr.write(
      `migration-impact: ${basename(arg)} names no CREATE/ALTER/DROP target.\n` +
        `  Either it is not a schema migration, or the DDL is shaped in a way this script does not\n` +
        `  parse. Refusing to report "0 affected chains" from a query that did not run.\n`,
    );
    process.exit(1);
  }

  const { affected, manifestDriven } = affectedTests(targets);
  process.stdout.write(`${basename(arg)} touches: ${[...targets].sort().join(", ")}\n\n`);
  if (affected.length === 0) {
    process.stdout.write("No hand-built test chain creates these tables. Nothing to update.\n");
  } else {
    process.stdout.write(
      `${affected.length} hand-built test chain(s) create these tables — check whether each needs the new migration:\n`,
    );
    for (const a of affected.sort((x, y) => x.file.localeCompare(y.file))) {
      process.stdout.write(
        `  test/${a.file.padEnd(44)} (${a.pinned} pinned)  via ${a.tables.join(", ")}\n`,
      );
    }
    process.stdout.write(
      `\nNot every one will break — a chain only fails if the code under test touches the new\n` +
        `column. This is the set to CHECK, not a list of known failures.\n`,
    );
  }
  process.stdout.write(
    `\n${manifestDriven.length} manifest-driven test(s) track it automatically.\n`,
  );
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
