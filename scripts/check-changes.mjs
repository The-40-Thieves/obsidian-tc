#!/usr/bin/env node
// Validates changes/*.md: every fragment parses (type, bullet body) and none is a stray file.
// Shares parseFragment with release.mjs, so the gate and the release refuse the same inputs.
import { existsSync, readdirSync } from "node:fs";
import { FRAGMENT_DIR, readFragments } from "./lib/changes.mjs";

const root = process.argv[2] ?? ".";
try {
  const fragments = readFragments(root);
  const stray = existsSync(`${root}/${FRAGMENT_DIR}`)
    ? readdirSync(`${root}/${FRAGMENT_DIR}`).filter(
        (f) => !f.endsWith(".md") && f !== ".gitkeep",
      )
    : [];
  if (stray.length > 0) {
    console.error(`changes: non-markdown file(s) in ${FRAGMENT_DIR}/: ${stray.join(", ")}`);
    process.exit(1);
  }
  console.log(`changes OK (${fragments.length} fragment(s))`);
} catch (err) {
  console.error(`changes: ${err.message}`);
  process.exit(1);
}
