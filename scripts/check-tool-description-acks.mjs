#!/usr/bin/env node
// Gate: an advertised tool description that changed versus the base ref must be acknowledged by
// `tool-description-change: <tool>[, <tool>]` in a changes/ fragment (the same mechanism as
// `config-schema-change:`). Usage: node scripts/check-tool-description-acks.mjs [--base <ref>]
// (default origin/main). Pure data: it compares the committed snapshot file, not the live registry;
// the vitest suite test/tool-description-snapshot.test.ts proves the snapshot is the live text.
//
// Fails closed on an unresolvable ref (a check that cannot read its baseline compared nothing).
// A snapshot absent at a RESOLVABLE ref is the PR that introduces it: reported, not failed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFragments } from "./lib/changes.mjs";
import { unacknowledgedDescriptionChanges } from "./lib/tool-descriptions.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
// `--root` exists for the gate's own tests (a throwaway repo); production runs use the checkout.
const ROOT = flag("--root") ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = "packages/server/test/tool-descriptions.snapshot.json";
/** An empty parse means the reader broke, not that nothing is advertised (cf. the 150-name floor). */
const MIN_ENTRIES = 150;

const baseRef = argv.includes("--base") ? flag("--base") : "origin/main";
if (!baseRef) {
  console.error("tool descriptions: --base needs a ref");
  process.exit(1);
}

const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

try {
  git("rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`);
} catch {
  console.error(
    `tool descriptions: cannot resolve base ref "${baseRef}". Fetch it, or pass --base.`,
  );
  process.exit(1);
}

const head = JSON.parse(readFileSync(join(ROOT, SNAPSHOT), "utf8"));
if (Object.keys(head).length < MIN_ENTRIES) {
  console.error(
    `tool descriptions: snapshot has ${Object.keys(head).length} entries (floor ${MIN_ENTRIES})`,
  );
  process.exit(1);
}

let baseText;
try {
  baseText = git("show", `${baseRef}:${SNAPSHOT}`);
} catch {
  console.log(`tool descriptions OK (no snapshot at ${baseRef}: this change introduces it)`);
  process.exit(0);
}
const base = JSON.parse(baseText);

const acknowledged = readFragments(ROOT).flatMap((f) => f.toolDescriptionChange);
const bad = unacknowledgedDescriptionChanges(base, head, acknowledged);
if (bad.length > 0) {
  console.error(
    `tool descriptions: ${bad.length} advertised description(s) changed vs ${baseRef} without acknowledgement ` +
      '(claude.ai keys "Always allow" to the description hash, so users must re-approve each):\n' +
      bad.map((b) => `  ${b.key}: ${b.reason}`).join("\n") +
      "\nIf deliberate, add `tool-description-change: <tool>[, <tool>]` to the front matter of this change's " +
      "changes/<slug>.md fragment. If not, revert the wording.",
  );
  process.exit(1);
}
const changed = Object.keys(head).filter((k) => k in base && base[k] !== head[k]).length;
console.log(
  `tool descriptions OK (${Object.keys(head).length} entries; ${changed} changed vs ${baseRef}, all acknowledged)`,
);
