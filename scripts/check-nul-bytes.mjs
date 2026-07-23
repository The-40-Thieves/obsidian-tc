#!/usr/bin/env node
// Fail the build if a tracked text file contains a literal NUL byte.
//
// WHY THIS EXISTS: three files carried a raw NUL byte in their source — two of them because a
// correct fix (use a NUL as a key delimiter, since it is the one byte that cannot occur in a vault
// id or a note path) was applied by TYPING the byte instead of writing the escape.
//
// The runtime behaviour was right. The tooling consequences were not:
//
//   * `git diff` reports "Binary files a/… and b/… differ" — so every change to those files since
//     #327 shipped WITHOUT A REVIEWABLE DIFF. That is the same failure mode as the vault leak:
//     reviewers audited a diff that could not show them the thing they needed to see.
//   * `grep`/`git grep` treat the file as binary and return no match, so any grep-based guard,
//     codemod, or SAST sweep silently skips it and still reports success.
//   * `file(1)` reports `data`, and editors/diff viewers may refuse to render it.
//
// It also produced a false bug report (#378): a reader saw the NUL render as nothing next to a
// comment saying "NUL delimiter" and reasonably concluded the delimiter was a space.
//
// THE RULE: express control characters as escapes. `\u0000` in a template literal and
// `String.fromCharCode(0)` (what `acl.ts` already does) both yield the identical string at runtime
// while keeping the source plain ASCII text.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

// Binary artifacts are legitimately non-text; only these are expected to be readable source.
const BINARY =
  /\.(png|jpg|jpeg|gif|ico|svgz|woff2?|ttf|eot|node|db|sqlite3?|wasm|pdf|zip|gz|tgz|bin|mcpb|snap)$/i;

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const failures = [];

for (const file of tracked) {
  // NOTE: no self-exemption. check-vault-leak.mjs skips itself because it legitimately holds
  // the patterns it hunts; this guard has no such need, and a NUL checker that cannot flag
  // itself is the same 'structurally cannot fail' defect it was written to prevent.
  if (BINARY.test(file)) continue;
  let buf;
  try {
    if (!statSync(file).isFile()) continue;
    buf = readFileSync(file);
  } catch {
    continue; // a submodule / broken symlink / file deleted since ls-files
  }
  const idx = buf.indexOf(0);
  if (idx === -1) continue;
  // Report the 1-based line so the failure is actionable without a hex editor.
  const line = buf.subarray(0, idx).toString("utf8").split("\n").length;
  const count = buf.filter((b) => b === 0).length;
  failures.push({ file, line, count });
}

if (failures.length > 0) {
  console.error("check-nul-bytes: literal NUL byte in tracked text file\n");
  for (const { file, line, count } of failures) {
    console.error(`  ${file}:${line}  (${count} NUL byte${count === 1 ? "" : "s"})`);
  }
  console.error(
    "\nA raw NUL makes the file binary to git, grep and SAST: diffs become unreviewable and" +
      "\ngrep-based guards silently match nothing." +
      "\n\nFix: write the escape instead — `\\u0000` in a string/template literal, or" +
      "\n`String.fromCharCode(0)`. Both are runtime-identical and keep the source plain text.\n",
  );
  process.exit(1);
}

console.log(`check-nul-bytes: OK (${tracked.length} tracked files scanned, 0 with NUL bytes)`);
