#!/usr/bin/env node
// THE-578: inline every migration .sql into a generated TypeScript module.
//
// The migration SQL used to be read from disk at runtime via
// `readFileSync(new URL("../migrations/", import.meta.url))`. That works from source and from the
// npm dist build, but it is BROKEN in the standalone binaries: `bun build --compile` resolves
// import.meta.url to the BUILD-TIME path and does not embed the .sql files, so every published
// binary died at module load with
//   ENOENT ... '/home/runner/work/obsidian-tc/obsidian-tc/packages/server/src/db/migrations/...'
// — the CI runner's directory, baked into the executable. It could not even print --version.
//
// Why codegen rather than Bun's own asset embedding: `import sql from "./x.sql" with { type: "text" }`
// is the idiomatic Bun answer and it works under bun, but the test suite runs under VITEST, whose
// rollup-based parser rejects the import attribute outright (verified: parseAstAsync throws). A
// generated .ts module is plain TypeScript, so it works identically under vitest, `bun run`, the npm
// dist build, and --compile — one code path for every runtime, which is the property that matters
// here. It also removes the filesystem from the provisioning path entirely.
//
// Run `bun run migrations:embed`; CI runs `--check` and fails on drift.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderEmbedded } from "./lib/embedded-migrations.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "packages/server/src/migrations");
const OUT = join(ROOT, "packages/server/src/db/migrations-embedded.ts");

const check = process.argv.includes("--check");

const files = readdirSync(SRC)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// A silent empty generation would produce a module that compiles, provisions nothing, and fails
// only much later as "table does not exist". Make it a hard error instead.
if (files.length === 0) {
  console.error(`gen-embedded-migrations: no .sql files found under ${SRC} — refusing to emit`);
  process.exit(1);
}

const banner = renderEmbedded(files.map((f) => [f, readFileSync(join(SRC, f), "utf8")]));

const existing = (() => {
  try {
    return readFileSync(OUT, "utf8");
  } catch {
    return null;
  }
})();

if (check) {
  if (existing !== banner) {
    console.error(
      "gen-embedded-migrations: migrations-embedded.ts is STALE — run `bun run migrations:embed`",
    );
    process.exit(1);
  }
  console.log(`gen-embedded-migrations: up to date (${files.length} migrations)`);
} else {
  writeFileSync(OUT, banner);
  console.log(`gen-embedded-migrations: wrote migrations-embedded.ts (${files.length} migrations)`);
}
