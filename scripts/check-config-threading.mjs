#!/usr/bin/env node
// Fail the build if a config key is DECLARED in the zod schema but never read by any code.
//
// WHY: `retrieval.densify.knnMinSim` shipped declared-but-unthreaded. It typechecked, it validated, it
// appeared in the docs — and it did nothing, because nothing ever read it. An entire ablation arm was
// measured against a configuration no operator could actually select. A config key that reaches no
// consumer is a lie told to the user in a schema they trust.
//
// This is deliberately CONSERVATIVE. It flags a key only when the identifier appears NOWHERE in the
// source outside the schema file. Generic names (`id`, `path`, `model`, `enabled`) will always match
// something and are never flagged — that is fine. The check exists to catch the knnMinSim shape: a
// distinctive name, declared, and referenced by nothing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCHEMA = "packages/shared/src/config.schema.ts";

const schema = readFileSync(SCHEMA, "utf8");
// Keys are `  name: z.<type>(...)` — but Biome wraps long chains, so the far more common form is
//
//     rrfK: z
//       .number()
//
// THE-544: the original pattern required `z.` on ONE line and therefore matched 14 of 130 keys —
// and the 14 it matched (path, glob, field, value, model, enabled, name, code, ...) are exactly the
// generic names the header above says "will always match something and are never flagged". The
// check parsed only the keys it was guaranteed to pass on, so it could not fail on any input.
// Accepting `z` followed by a dot OR whitespace covers both formattings.
const declared = [
  ...new Set(
    [...schema.matchAll(/^[ \t]+([a-zA-Z][A-Za-z0-9_]*):[ \t]*z[.\s]/gm)].map((m) => m[1]),
  ),
];
if (declared.length === 0) {
  console.error(
    "config-threading: parsed ZERO keys from the schema — the parser is broken, not the",
  );
  console.error("config. Refusing to report a clean result I cannot stand behind.");
  process.exit(1);
}

// Every tracked .ts that could consume config: source and eval, never the schema itself, never tests
// (a test referencing a key does not mean production code threads it).
const files = execFileSync("git", ["ls-files", "*.ts"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !f.endsWith(SCHEMA) && !/(^|\/)test\//.test(f) && !/\.test\.ts$/.test(f));

const body = files
  .map((f) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");

const orphans = declared.filter((k) => !new RegExp(`\\b${k}\\b`).test(body));

// Sanity check the checker itself: keys we KNOW are consumed must not be flagged. If they are, the
// detector is broken and must not be trusted — an earlier inline version of this reported `rrfK`,
// `tagEdges` and `chunkContext` as orphans, all of which are provably read.
const CANARIES = ["rrfK", "tagEdges", "chunkContext", "derivedWeight"];

// THE-544: the canary must first assert it is ARMED. The `declared.includes(c) && ...` guard below
// silently disarms itself when the parser stops seeing a canary at all — which is precisely what
// happened: none of these four were in `declared`, so the && short-circuited and the
// "DETECTOR IS BROKEN" alarm could never fire. A canary absent from the parse is not a pass, it is
// the loudest possible signal that the parser regressed.
const missingCanaries = CANARIES.filter((c) => !declared.includes(c));
if (missingCanaries.length > 0) {
  console.error(
    "config-threading: DETECTOR IS BROKEN — known-declared canary keys were not parsed from the",
  );
  console.error(`schema at all: ${missingCanaries.join(", ")}`);
  console.error(
    "The key pattern has stopped matching the schema's formatting. Fix the parser; a 'clean'",
  );
  console.error("result from a parser that cannot see its own canaries means nothing.");
  process.exit(1);
}

const falsePositives = CANARIES.filter((c) => declared.includes(c) && orphans.includes(c));
if (falsePositives.length > 0) {
  console.error(
    `config-threading: DETECTOR IS BROKEN — it flagged known-consumed keys as orphans:`,
  );
  console.error(`  ${falsePositives.join(", ")}`);
  console.error(`Fix the checker. Do not trust its output.`);
  process.exit(1);
}

if (orphans.length === 0) {
  console.log(
    `config-threading: clean (${declared.length} declared keys, ${files.length} source files, all reachable)`,
  );
  process.exit(0);
}

console.error(`config-threading: ${orphans.length} DECLARED-BUT-UNREAD config key(s)\n`);
for (const k of orphans) {
  console.error(`  ${k}  — declared in ${SCHEMA}, referenced by no source file`);
}
console.error(
  `\nEither thread it through to the code that should honor it, or delete it from the schema.`,
);
console.error(
  `A config key nothing reads is a promise to the operator that the code does not keep.`,
);
process.exit(1);
