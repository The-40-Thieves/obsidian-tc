#!/usr/bin/env bun
// Emit a JSON Schema for obsidian-tc.config.json from the Zod schema that already validates it.
//
// WHY THIS IS WORTH DOING AND WHY IT IS CHEAP. The config surface is the customization layer for
// anyone who does not want to write code — toolVisibility, auth.mode, acl, retrieval, embeddings —
// and it is currently undiscoverable: you have to read TypeScript to find out a key exists. The
// descriptions are ALREADY written (187 `.describe()` calls across config.schema.ts); they were
// just never emitted anywhere an editor could read them. Publishing the JSON Schema turns them
// into inline docs and autocomplete in VS Code and every other editor that speaks `$schema`.
//
// Generated, never hand-maintained: the Zod schema stays the single source of truth, so a new key
// with a `.describe()` shows up in the editor automatically. --check makes drift a CI failure
// rather than something discovered when the published schema is already stale.
//
// usage:
//   bun scripts/gen-config-schema.ts            # write docs/obsidian-tc.config.schema.json
//   bun scripts/gen-config-schema.ts --check    # fail if the committed file is stale
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "obsidian-tc.config.schema.json");

// WP1.1: a pinned baseline of the complete emitted bytes (including the trailing newline). The
// staleness check below (comparing regenerated output to the committed file) catches the schema
// going STALE, but regenerating both together would silently hide an unintended CHANGE — this
// hash is the second, independent witness. A deliberate schema change updates this constant in
// its own behavioral PR, not as a side effect of an unrelated refactor.
const CONFIG_SCHEMA_BASELINE_SHA256 =
  "ae8bb2801214f351b12af60e174285f2672a0a72f02c0500725f9badfa976745";

// The CONVERSION lives in packages/shared (configJsonSchema), not here. A script under scripts/
// resolves its imports from its own directory upward, so importing `zod` here only works when the
// workspace happens to hoist it to the root — true locally, false on the CI runner. Importing the
// shared module by absolute path works either way, and it is the module that owns the schema.
const { configJsonSchema } = await import(
  join(ROOT, "packages", "shared", "src", "config.schema.ts")
);

const schema = configJsonSchema();
schema.$schema = "https://json-schema.org/draft/2020-12/schema";
schema.title = "obsidian-tc server config";
schema.description =
  'Configuration for obsidian-tc. Generated from packages/shared/src/config.schema.ts — do not edit by hand. Add `"$schema": "./obsidian-tc.config.schema.json"` to your config for editor autocomplete.';

const json = `${JSON.stringify(schema, null, 2)}\n`;

// A schema that documented nothing would still be valid JSON and would still pass a naive
// "file exists" check, so assert the descriptions actually survived the conversion. This is the
// only property that makes the artifact worth publishing at all.
const described = (JSON.stringify(schema).match(/"description":/g) ?? []).length;
if (described < 100)
  throw new Error(
    `only ${described} descriptions survived into the JSON Schema; config.schema.ts carries ~187 .describe() calls, so the conversion dropped them and the artifact would be useless`,
  );

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error(`config schema missing: ${OUT}\nRun: bun scripts/gen-config-schema.ts`);
    process.exit(1);
  }
  // Two independent checks, reported separately, because regenerating both files together would
  // hide a change that trips ONLY the hash: staleness (committed file vs regenerated output) says
  // nothing about whether that output still matches the pinned baseline.
  const staleFile = current !== json;
  const actualSha256 = createHash("sha256").update(json).digest("hex");
  const staleHash = actualSha256 !== CONFIG_SCHEMA_BASELINE_SHA256;
  if (staleFile || staleHash) {
    if (staleFile) {
      console.error(
        `config schema is STALE: ${OUT}\nThe Zod schema changed without regenerating.\nRun: bun scripts/gen-config-schema.ts`,
      );
    }
    if (staleHash) {
      console.error(
        `config schema HASH MISMATCH: expected ${CONFIG_SCHEMA_BASELINE_SHA256}, got ${actualSha256}\n` +
          "The emitted JSON Schema bytes no longer match the pinned baseline. If this schema change " +
          "is deliberate, update CONFIG_SCHEMA_BASELINE_SHA256 in scripts/gen-config-schema.ts in its " +
          "own behavioral PR — do not update it as a side effect of an unrelated refactor.",
      );
    }
    process.exit(1);
  }
  console.log(`config schema OK (${described} descriptions, up to date, hash ${actualSha256})`);
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT} (${described} descriptions)`);
}
