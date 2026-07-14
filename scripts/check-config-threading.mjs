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
// Keys are `  name: z.<type>(...)` inside the schema objects.
const declared = [
  ...new Set([...schema.matchAll(/^[ \t]+([a-zA-Z][A-Za-z0-9_]*):[ \t]*z\./gm)].map((m) => m[1])),
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
