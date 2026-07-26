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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "obsidian-tc.config.schema.json");

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
  if (current !== json) {
    console.error(
      `config schema is STALE: ${OUT}\nThe Zod schema changed without regenerating.\nRun: bun scripts/gen-config-schema.ts`,
    );
    process.exit(1);
  }
  console.log(`config schema OK (${described} descriptions, up to date)`);
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT} (${described} descriptions)`);
}
