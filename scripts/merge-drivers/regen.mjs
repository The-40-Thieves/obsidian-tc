#!/usr/bin/env node
/**
 * `regen` — a git merge driver that merges a GENERATED file by regenerating it, not by splicing
 * text. Named for the .gitattributes entry `merge=regen`; defined in this clone's git config by
 * scripts/setup-git-merge-driver.mjs (a driver's definition lives in .git/config, which git never
 * commits or clones).
 *
 * Covers packages/server/src/db/migrations-embedded.ts: two PRs that each add a migration both
 * insert a line at the end of the same object literal, which a text merge can only call a
 * conflict. The driver instead reads the three versions as DATA (filename -> SQL), merges them per
 * entry, and renders the result with the same function `bun run migrations:embed` uses, so the
 * merged file is byte-identical to a fresh regeneration over the merged set of migrations.
 *
 * WHY IT DOES NOT SHELL OUT TO THE GENERATOR (the failure an earlier driver here was written to
 * avoid): git runs a driver for each conflicting path BEFORE the other side's single-side changes
 * exist in the working tree, so `bun run migrations:embed` mid-merge would read a migrations/
 * directory that is missing the other branch's .sql files and report success over a wrong result.
 * The three temp files git hands over are the only inputs guaranteed complete, and they are all
 * this driver reads.
 *
 * Anything it cannot merge safely (the same migration edited two different ways, a conflict-marked
 * input, a path it does not know) exits non-zero with a real conflict, never a guess.
 *
 * Invoked by git as: regen.mjs %O %A %B %P
 *   %O ancestor, %A ours (the driver writes the result here), %B theirs, %P repo-relative path.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mergeEmbedded, parseEmbedded, renderEmbedded } from "../lib/embedded-migrations.mjs";

const EMBEDDED = "packages/server/src/db/migrations-embedded.ts";
const [ancestorPath, currentPath, otherPath, mergedPath] = process.argv.slice(2);

if (!ancestorPath || !currentPath || !otherPath) {
  console.error(
    "regen: expected %O %A %B %P — check merge.regen.driver in this clone's git config.",
  );
  process.exit(2);
}

function textMerge() {
  // Unknown path or unparseable input: behave like git's default driver (markers, non-zero exit).
  try {
    execFileSync("git", ["merge-file", currentPath, ancestorPath, otherPath], { stdio: "ignore" });
    return 0;
  } catch (err) {
    return typeof err.status === "number" && err.status > 0 ? 1 : 2;
  }
}

if (mergedPath !== EMBEDDED) {
  console.error(`regen: no regenerator for ${mergedPath ?? "(unknown path)"}; text merge.`);
  process.exit(textMerge());
}

try {
  const read = (p) => parseEmbedded(readFileSync(p, "utf8"));
  const base = read(ancestorPath);
  const ours = read(currentPath);
  const theirs = read(otherPath);
  // Existence floor: a parse that yields nothing is a broken parse, not an empty schema.
  if (ours.length === 0 || theirs.length === 0) {
    throw new Error("an input side holds zero migrations — refusing to merge over nothing");
  }
  const merged = mergeEmbedded(base, ours, theirs);
  if (merged.conflicts) {
    console.error(
      `regen: ${mergedPath}: both sides changed the same migration differently: ${merged.conflicts.join(", ")}`,
    );
    process.exit(1);
  }
  writeFileSync(currentPath, renderEmbedded(merged.entries));
  console.error(
    `regen: ${mergedPath} regenerated from ${merged.entries.length} migrations (ours ${ours.length}, theirs ${theirs.length}).`,
  );
  process.exit(0);
} catch (err) {
  console.error(`regen: ${mergedPath}: ${err.message}; text merge.`);
  process.exit(textMerge());
}
