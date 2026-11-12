// 2.0 renamed obsidian-tc to reliquary-tc. The old name may appear only where it is kept on
// purpose: a wire contract that must not change, a compatibility path that accepts the old name,
// history, or text that tells users about the rename. Anything else is a missed rename.
//
// Every allowed occurrence is either a PROTECTED token (removed before the scan, wherever it is) or
// a file on ALLOWED_FILES with the reason it keeps the old name. Adding to either list needs that
// reason; a new compatibility path should read its names from packages/shared/src/legacy-names.ts
// instead of spelling them out.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OLD = /obsidian[-_ ]?tc/i;

/** Tokens that keep the old spelling wherever they occur. */
const PROTECTED = [
  /obsidian_tc_version/g, // schema_migrations column, created by shipped (immutable) migrations
  /obsidian-tc\.the40thieves\.io/g, // docs domain: redirected by the distribution change
  /\/obsidian-tc\/v\d/g, // companion plugin API route prefix, a versioned contract
  /obsidianTcApiVersion/g, // companion plugin /probe field, the same versioned contract
  /The-40-Thieves_obsidian-tc/g, // SonarQube Cloud project key, renamed on the Sonar side
  /\.obsidian-tc\/traces/g, // per-vault folder that still holds pre-migration session traces
];

/** Whole files or trees that keep the old name, and why. Paths use forward slashes. */
const ALLOWED_FILES = new Map([
  ["CHANGELOG.md", "release history"],
  ["docs/superpowers/", "dated plans and specs, kept as written"],
  ["packages/server/src/migrations/", "shipped migrations are checksum-pinned"],
  ["packages/server/src/db/migrations-embedded.ts", "generated from the shipped migrations"],
  ["packages/plugin/legacy/", "the pre-tc-bridge plugin build, kept for its migration"],
  ["packages/plugin/src/migration.ts", "migrates settings from the old plugin id"],
  ["packages/plugin/test/legacy-notice.test.ts", "pins the old plugin id's sunset build"],
  ["packages/shared/src/legacy-names.ts", "the single list of old names"],
  ["packages/shared/test/legacy-names.test.ts", "tests the old names"],
  ["packages/server/src/legacy-env-install.ts", "maps the old env prefix"],
  ["packages/server/src/home-dir.ts", "falls back to the old home folder"],
  ["packages/server/src/provenance/stamp.ts", "reserves the old commit-trailer prefix"],
  ["packages/server/package.json", "installs the old command as an alias"],
  ["bun.lock", "records the alias command"],
  ["packages/server/test/rename-compat.test.ts", "tests old-name compatibility"],
  ["packages/server/test/metrics-legacy-names.test.ts", "tests old metric names"],
  ["packages/server/test/setup-legacy-entry.test.ts", "tests old client entries"],
  ["docs/UPGRADING-2.0.md", "the upgrade guide"],
  ["README.md", "the rename notice"],
  ["NOTICE", "names the former project"],
  ["packages/server/NOTICE", "copy of the root NOTICE"],
  ["packages/shared/NOTICE", "copy of the root NOTICE"],
  ["packages/native/NOTICE", "copy of the root NOTICE"],
  ["packages/embedder-local/NOTICE", "copy of the root NOTICE"],
  ["packages/reranker-local/NOTICE", "copy of the root NOTICE"],
  ["changes/rename-reliquary-tc.md", "the release note for the rename"],
  ["scripts/rename-mapping.test.mjs", "this gate"],
]);

const allowed = (path) =>
  [...ALLOWED_FILES.keys()].some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry,
  );

const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .map((p) => p.split("\\").join("/"));

function readText(path) {
  try {
    const buf = readFileSync(join(ROOT, path));
    if (buf.includes(0)) return undefined; // binary
    return buf.toString("utf8");
  } catch {
    return undefined; // a symlink to a directory, or deleted in the working tree
  }
}

test("the tree is large enough for the scan to mean something (non-empty floor)", () => {
  assert.ok(files.length > 1000, `only ${files.length} tracked files`);
  const renamed = files.filter((p) => /reliquary[-_]tc/i.test(readText(p) ?? ""));
  assert.ok(renamed.length > 500, `only ${renamed.length} files carry the new name`);
});

test("no tracked path still carries the old name", () => {
  const paths = files.filter((p) => OLD.test(p) && !allowed(p));
  assert.deepEqual(paths, []);
});

test("the old name appears only in protected tokens and allowed files", () => {
  const misses = [];
  for (const path of files) {
    if (allowed(path)) continue;
    const text = readText(path);
    if (text === undefined || !OLD.test(text)) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      for (const token of PROTECTED) line = line.replace(token, "");
      if (OLD.test(line)) misses.push(`${path}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(misses, [], `old name outside the allowlist:\n${misses.join("\n")}`);
});

test("every allowed file still exists, so the allowlist cannot rot", () => {
  for (const entry of ALLOWED_FILES.keys()) {
    const hit = entry.endsWith("/")
      ? files.some((p) => p.startsWith(entry))
      : files.includes(entry);
    assert.ok(hit, `allowlist entry no longer matches a tracked file: ${entry}`);
  }
});
