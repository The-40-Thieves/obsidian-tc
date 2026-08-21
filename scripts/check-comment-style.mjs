#!/usr/bin/env node
/**
 * check-comment-style — enforces CONTRIBUTING.md's "Inline commentary" section (#850) against
 * every TypeScript file under a package's `src/` tree (recursively): no dated ticket-thread
 * banners, no first-person narrative, plus a ratchet against re-accumulating oversized comment
 * blocks. #851/#852 swept the tree clean of the banned register; this gate is what keeps it that
 * way.
 *
 * COMMENT CONTENT ONLY. A dated banner or "I found" inside a STRING LITERAL — a fixture asserting
 * on comment text, a log message — is not this policy's business (CONTRIBUTING.md exempts test
 * fixtures explicitly). Source is parsed with a small hand-rolled scanner rather than a full AST:
 * string/template literals are walked and skipped first so nothing inside one can ever reach the
 * comment extractor, then `//` and `/* *\/` spans are pulled out with their real line numbers.
 * Regex-based, not an AST walk — matching this repo's other source-scan gates
 * (check-embedding-transport-vendor-neutral.mjs, check-config-paths.mjs). Known gap shared with
 * those: a regex literal containing `//` or `/*` is not distinguished from a real comment start.
 * None do in this codebase's package source trees today (checked against the current tree);
 * acceptable for the same reason it is acceptable there.
 *
 * TWO HARD-FAIL CLASSES, BOTH TUNED AGAINST THE REAL TREE (iterated until 0 hits, not authored
 * blind):
 *
 *   1. BANNER — a capitalized register word directly attached to a YEAR-shaped number. The
 *      literal `KEYWORD\s+20\d\d` shape over-matches: `packages/server/src/mcp/registry/types.ts`
 *      has legitimate prose reading "a transport-VERIFIED 2026-era HITL confirmation", where
 *      "2026" is an adjectival era reference, not a banner date. The one banner #851 actually
 *      removed was shaped `CORRECTED 2026-08-04:` — a real date, digits before AND after the
 *      first hyphen. A trailing `(?!-[a-z])` excludes exactly the "-era"/"-ish" adjectival suffix
 *      shape without narrowing the match to a full `YYYY-MM-DD`, so a bare `CORRECTED 2026:`
 *      banner (no day/month) still trips it.
 *   2. FIRST-PERSON — "I"/"we" + a narrative verb. Over-matches quoted reported speech:
 *      `packages/server/src/search/llm-edges.ts` glosses an empty result as `("I looked and found
 *      nothing")` — the model's imagined self-report, not the comment author's. Double-quoted
 *      spans are blanked out of the comment text before this rule runs, the same way string
 *      literals are blanked out of source before the comment extractor runs — quoted prose gets
 *      the same "not the author's own voice" treatment as a string literal does.
 *
 * RATCHET, not a hard cap on any one file: the count of files whose total comment-line count
 * (line + block, combined) is >= COMMENT_LINE_THRESHOLD must not EXCEED the checked-in baseline
 * (scripts/comment-style-baseline.json). A file can still carry a long, dense comment block — the
 * policy already tolerates that when it earns its keep — this only stops the NUMBER of such files
 * from silently growing. Same shape as .jscpd.json's duplication threshold: a ceiling that ratchets
 * down as the tree improves, never up.
 *
 * EXEMPTIONS: a file whose first 5 lines mention "GENERATED" (this repo's convention — see
 * migrations-embedded.ts, sqlite-embedded.ts, vec-embedded.ts) is skipped entirely, matching
 * CONTRIBUTING.md's migration/generated-file carve-out. Test-fixture strings are already excluded
 * by construction: this gate only ever looks at comment content, never string content. There is no
 * per-file allowlist for the two error classes — the tree is clean and CONTRIBUTING.md gives no
 * exemption besides migrations/generated files, so a violation here is always a real one.
 *
 * Floors, per this repo's other source-scan gates (check-boundaries.mjs,
 * check-perf-timing-scope.mjs, check-embedding-transport-vendor-neutral.mjs): finding zero files
 * to scan is a broken glob, not a clean sweep, and must FAIL rather than pass silently.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const BASELINE_PATH = resolve(ROOT, "scripts/comment-style-baseline.json");

const MIN_EXPECTED_FILES = 300; // the real scope is ~428 files; a broken glob looks nothing like this

// Dated ticket-thread banner. The trailing negative lookahead excludes an adjectival "-era"/"-ish"
// suffix (a real hyphen followed by a lowercase letter) without requiring a full YYYY-MM-DD — see
// the docblock above for the exact false positive this was tuned against.
const BANNER_RE =
  /\b(CORRECTED|VERIFIED|MEASURED|DECIDED|RE-CHECKED|RETARGETED|SUPERSEDED|UNPARKED)\s+20\d\d(?!-[a-z])/;

// First-person narrative. Run only after double-quoted spans have been blanked from the comment
// text (see stripQuotedProse) so a quoted gloss of someone else's voice — a model's, a user's —
// cannot trip the comment AUTHOR's-own-voice rule.
const FIRST_PERSON_RE =
  /\b(I|we)\s+(had\s+)?(asserted|claimed|measured|verified|assumed|believed|found|wrote|thought)\b/i;

const GENERATED_HEADER_LINES = 5;

/** Blank a double-quoted span (`"..."`, may itself span multiple lines — a parenthetical gloss
 *  wrapping in a ~100-column comment block routinely does) to spaces, preserving every newline so
 *  a line number taken after this call still lines up with the original comment text. Quoted
 *  reported speech ("I looked and found nothing") gets the same "not the author's own voice"
 *  treatment string literals already get by never reaching the comment extractor in the first
 *  place. Applied to the WHOLE comment text, not line by line — a per-line version would miss a
 *  quote whose closing `"` falls on a later line than its opening one. */
export function stripQuotedProse(text) {
  return text.replace(/"[^"]*"/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Walk `source` once, character by character, and return every line and block comment with its
 * real 1-based start line. String and template literals are recognized and stepped over WITHOUT
 * ever being inspected for comment-looking text inside them — this is what keeps a template string
 * containing the literal text "banner-shaped prose" from being misread as an actual comment.
 *
 * Deliberately not a full lexer: backslash-escapes are honored inside quotes/templates, but a
 * `${...}` interpolation inside a template literal is not parsed as code — a nested backtick or
 * comment-opening sequence inside an interpolation is treated as still part of the template. Not
 * exercised anywhere in this codebase's package source trees today; acceptable for the same
 * pragmatic reason check-embedding-transport-vendor-neutral.mjs's comment stripper does not parse
 * regex literals.
 */
export function extractComments(source) {
  const comments = [];
  const n = source.length;
  let i = 0;
  let line = 1;

  const skipQuoted = (quote) => {
    let j = i + 1;
    while (j < n) {
      const ch = source[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === quote) {
        j++;
        break;
      }
      if (ch === "\n") break; // unterminated on this line -- bail rather than run away
      j++;
    }
    return j;
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      const startLine = line;
      let j = i + 2;
      while (j < n && source[j] !== "\n") j++;
      comments.push({ type: "line", text: source.slice(i + 2, j), startLine, endLine: startLine });
      i = j;
      continue;
    }

    if (ch === "/" && next === "*") {
      const startLine = line;
      const close = source.indexOf("*/", i + 2);
      const contentEnd = close === -1 ? n : close;
      const text = source.slice(i + 2, contentEnd);
      const spanned = (text.match(/\n/g) ?? []).length;
      comments.push({ type: "block", text, startLine, endLine: startLine + spanned });
      line += spanned;
      i = close === -1 ? n : close + 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const j = skipQuoted(ch);
      i = j;
      continue;
    }

    if (ch === "`") {
      let j = i + 1;
      let spanned = 0;
      while (j < n) {
        const c2 = source[j];
        if (c2 === "\\") {
          j += 2;
          continue;
        }
        if (c2 === "`") {
          j++;
          break;
        }
        if (c2 === "\n") spanned++;
        j++;
      }
      line += spanned;
      i = j;
      continue;
    }

    if (ch === "\n") line++;
    i++;
  }

  return comments;
}

/** Total line count (line comments count 1 each, block comments count every line they span) --
 *  the quantity the ratchet in comment-style-baseline.json is measured against. */
export function commentLineCount(comments) {
  let total = 0;
  for (const c of comments) total += c.endLine - c.startLine + 1;
  return total;
}

/** Scan every comment for BANNER_RE / FIRST_PERSON_RE and return every match with its absolute
 *  source line. Quoted prose is stripped across the WHOLE comment text before splitting into
 *  lines (see stripQuotedProse) so a quote that wraps onto a second line is still caught. */
export function findViolations(comments) {
  const violations = [];
  for (const comment of comments) {
    const lines = stripQuotedProse(comment.text).split("\n");
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      const sourceLine = comment.startLine + k;
      const banner = BANNER_RE.exec(line);
      if (banner) violations.push({ rule: "banner", line: sourceLine, match: banner[0] });
      const firstPerson = FIRST_PERSON_RE.exec(line);
      if (firstPerson)
        violations.push({ rule: "first-person", line: sourceLine, match: firstPerson[0] });
    }
  }
  return violations;
}

/** True when the leading `GENERATED_HEADER_LINES` lines mention "GENERATED" -- this repo's
 *  existing convention (migrations-embedded.ts, sqlite-embedded.ts, vec-embedded.ts). */
export function isGeneratedFile(source) {
  const head = source.split("\n", GENERATED_HEADER_LINES).join("\n");
  return /GENERATED/.test(head);
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** `packages/*\/src/**\/*.ts` needs TWO git pathspecs: `**\/*.ts` alone does not match a file
 *  directly under `src/` (e.g. `packages/server/src/index.ts`) because `**` requires at least one
 *  intervening path segment. Verified empirically: the single-pattern form silently dropped 19
 *  files, including index.ts and cli.ts, off a 428-file scope. */
export function scopeFiles() {
  const a = run("git", ["ls-files", "packages/*/src/*.ts"]).split("\n").filter(Boolean);
  const b = run("git", ["ls-files", "packages/*/src/**/*.ts"]).split("\n").filter(Boolean);
  return [...new Set([...a, ...b])].sort();
}

export function loadBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

/** Pure ratchet decision: `oversizedCount` (files at/over `baseline.threshold` comment lines) vs
 *  `baseline.maxFiles`. Split out from main() so the over/under/at-baseline cases are testable
 *  without a subprocess or a throwaway baseline file on disk. */
export function evaluateRatchet(oversizedCount, baseline) {
  if (oversizedCount > baseline.maxFiles) return { status: "over", failed: true };
  if (oversizedCount < baseline.maxFiles) return { status: "under", failed: false };
  return { status: "at", failed: false };
}

export function main() {
  const files = scopeFiles();
  if (files.length < MIN_EXPECTED_FILES) {
    console.error(
      `comment-style gate: only ${files.length} file(s) matched packages/*/src/**/*.ts ` +
        `(expected >= ${MIN_EXPECTED_FILES}). This almost certainly means the git pathspec glob ` +
        "broke. Refusing to pass a check that scanned (near-)nothing.",
    );
    process.exit(1);
  }

  const baseline = loadBaseline();
  const violations = [];
  let oversizedCount = 0;
  let scanned = 0;

  for (const file of files) {
    let source;
    try {
      source = readFileSync(resolve(ROOT, file), "utf8");
    } catch {
      continue; // deleted between ls-files and read -- not this gate's business
    }
    if (isGeneratedFile(source)) continue;
    scanned++;

    const comments = extractComments(source);
    for (const v of findViolations(comments)) violations.push({ file, ...v });
    if (commentLineCount(comments) >= baseline.threshold) oversizedCount++;
  }

  console.log(
    `comment-style gate: ${scanned} file(s) scanned, ${violations.length} banned-pattern ` +
      `violation(s), ${oversizedCount} file(s) at/over the ${baseline.threshold}-line comment ` +
      `threshold (baseline ${baseline.maxFiles})`,
  );
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}  [${v.rule}]  "${v.match}"`);
  }

  let failed = false;

  if (violations.length > 0) {
    console.error(
      "\ncomment-style gate: a comment in packages/*/src uses a form CONTRIBUTING.md's \"Inline " +
        'commentary" section (#850) disallows there -- a dated ticket-thread banner (CORRECTED ' +
        '2026-08-04:, VERIFIED 2026-...) or first-person narrative ("I found", "we measured"). ' +
        "Rewrite as a present-tense invariant/why statement; if the history, measurement or " +
        "correction narrative is worth keeping, move it to docs/design/, docs/adr/, or " +
        "docs/superpowers/specs/ and leave a one-line pointer in the comment instead.",
    );
    failed = true;
  }

  const ratchet = evaluateRatchet(oversizedCount, baseline);
  if (ratchet.status === "over") {
    console.error(
      `\ncomment-style gate: ${oversizedCount} file(s) now carry >= ${baseline.threshold} comment ` +
        `lines, exceeding the checked-in baseline of ${baseline.maxFiles} in ` +
        "scripts/comment-style-baseline.json. This is a ratchet, not a per-file cap: a file may " +
        "still carry a long comment block, but the COUNT of such files may not grow. Either trim " +
        "the new/grown block(s) back under the threshold, or -- if the growth is deliberate and " +
        "load-bearing -- raise maxFiles in the baseline file and explain why in the PR.",
    );
  } else if (ratchet.status === "under") {
    console.log(
      `\ncomment-style gate: only ${oversizedCount} file(s) are at/over the threshold now, below ` +
        `the baseline of ${baseline.maxFiles} -- lower maxFiles in scripts/comment-style-baseline.json ` +
        "to lock in the improvement.",
    );
  }

  process.exit(failed || ratchet.failed ? 1 : 0);
}

// Importing this module (as the test file does, to reach the exported functions) must have no
// side effects -- only run the gate when this file is the process entry point. Same guard as
// check-boundaries.mjs / check-embedding-transport-vendor-neutral.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
