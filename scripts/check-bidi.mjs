#!/usr/bin/env node
// Fail if a tracked text file holds a literal bidi control or a zero-width character.
//
// WHY THIS EXISTS: a bidi override (U+202A-U+202E, U+2066-U+2069) or a zero-width character
// (U+200B-U+200F, U+2060, U+FEFF) is invisible in an editor and in a diff viewer, so a reader sees
// one string and the compiler gets another. That is the Trojan Source class. The detectors in
// packages/server need these characters, so they are written as `\uXXXX` escapes, which read as
// text and cannot be mistaken for the character.
//
// THE RULE:
//   * bidi controls fail in every tracked text file, prose included;
//   * zero-width characters fail everywhere except Markdown. A Markdown page may quote one when it
//     explains the attack (CHANGELOG.md does); source and config have no reason to carry one.
//     Note that U+200D (zero-width joiner) is in the U+200B-U+200F range and is reported too: the
//     repo has no emoji sequence that needs a literal one.
//
// Binary files (anything with a NUL byte) are skipped: check-nul-bytes.mjs already fails those.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/gu;
const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/gu;

// The scan must cover the whole tracked tree. This repo tracks about 2900 files, so a count below
// this floor means the file list came back empty or truncated, and a clean result would prove
// nothing.
export const MIN_SCANNED_FILES = 1000;

const PROSE = /\.(md|mdx)$/i;

const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Pure: list the literal bidi controls and zero-width characters in one file's text. Returns
 * `{ line, codepoint, kind }` per hit, in source order. `path` decides whether zero-width counts.
 */
export function scanText(path, text) {
  const hits = [];
  const patterns = [["bidi control", BIDI_CONTROL]];
  if (!PROSE.test(path)) patterns.push(["zero-width", ZERO_WIDTH]);
  for (const [kind, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      hits.push({ line, codepoint: hex(match[0]), kind });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** Pure: the problem line for a scan that saw too few files, or null when the floor is met. */
export function floorProblem(scanned, min = MIN_SCANNED_FILES) {
  if (scanned > min) return null;
  return `check-bidi: scanned ${scanned} tracked files, need more than ${min}; the file list is wrong, so a clean result would prove nothing.`;
}

function main() {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

  const failures = [];
  let scanned = 0;
  for (const file of tracked) {
    let buf;
    try {
      if (!statSync(file).isFile()) continue;
      buf = readFileSync(file);
    } catch {
      continue; // a submodule / broken symlink / file deleted since ls-files
    }
    if (buf.includes(0)) continue; // binary: check-nul-bytes.mjs owns it
    scanned += 1;
    for (const hit of scanText(file, buf.toString("utf8"))) {
      failures.push({ file, ...hit });
    }
  }

  const floor = floorProblem(scanned);
  if (floor) {
    console.error(floor);
    process.exit(1);
  }

  if (failures.length > 0) {
    console.error("check-bidi: literal bidi or zero-width character in tracked text\n");
    for (const { file, line, codepoint, kind } of failures) {
      console.error(`  ${file}:${line}  ${codepoint} (${kind})`);
    }
    console.error(
      "\nWrite the character as its escape instead: `\\u202E` inside a regex class or a string" +
        "\nliteral is the same value at runtime and cannot hide in an editor or a diff.\n",
    );
    process.exit(1);
  }

  console.log(`check-bidi: OK (${scanned} tracked text files scanned, 0 literal bidi/zero-width)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
