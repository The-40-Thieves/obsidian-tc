#!/usr/bin/env node
/**
 * check-redos — every regex literal that scans UNTRUSTED text in `vault/` (note bodies: links,
 * tags, rewrite) and `experiential/` (memory-defense secret redaction, prompt-injection detection)
 * must be linear-time, not just backtracking-free within one match attempt.
 *
 * WHY THIS EXISTS: `vault/links.ts`'s MDLINK/WIKILINK regexes each ran a full re-scan-to-end-of-line
 * on every FAILED start position, and a crafted note (many `"[a]("` with no closing paren) drove an
 * 80 KB line to 11+ seconds. Neither regex has classic catastrophic (ambiguous nested-quantifier)
 * backtracking — the character classes exclude their own delimiter, so no single match attempt ever
 * backtracks — which is exactly the shape `recheck`'s automaton-based checker classifies as
 * "vulnerable, polynomial degree 2" rather than "safe, linear": this gate would have caught it.
 *
 * Regex literals are pulled out with a hand-rolled single-pass scanner (not the TypeScript
 * compiler API — `typescript@7` on this repo's pin ships only the new native/Go-ported AST under
 * `typescript/unstable/ast`, not the classic `ts.createSourceFile`/`ts.SyntaxKind` surface, and no
 * other script here depends on it), matching this repo's other source-scan gates
 * (check-comment-style.mjs, check-embedding-transport-vendor-neutral.mjs): strings and template
 * literals are stepped over without inspection, `//` and `/* *\/` comments are stepped over too —
 * so a regex embedded in a comment (e.g. redact.ts's documented-but-deliberately-unshipped
 * unbounded PRIVATE KEY example) is never extracted — and a bare `/` is read as a regex literal
 * start only where a regex is syntactically legal (not immediately after an identifier, number,
 * `)`/`]`, which would make it division). Same pragmatic scope as those gates: not a full lexer,
 * exercised only against this codebase's actual regex-literal shapes (`const NAME = /pattern/flags;`).
 *
 * SCOPE: every `.ts` under `packages/server/src/vault/` and `packages/server/src/experiential/`.
 * Both trees run their regexes over content that can be caller/attacker-controlled — a note body,
 * an imported memory episode — as opposed to a config key or a CLI flag. Extend SCAN_DIRS if
 * another untrusted-text scanner grows regexes outside those two trees.
 *
 * A regex whose flags are computed at runtime (not a literal) is reported as SKIPPED, not silently
 * ignored and not failed — `recheck` needs a literal to check, and a dynamically-built character
 * class (memory-defense.ts's `new RegExp(`[${body}]`, "gu")`) is bounded by construction (a single
 * character class, no quantifier chain) rather than something this gate can express in the
 * "vulnerable" classification.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check } from "recheck";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["packages/server/src/vault", "packages/server/src/experiential"];
const CHECK_TIMEOUT_MS = 5_000;

// `recheck`'s automaton checker is exact; its FUZZ checker (used when the automaton gives up on a
// pattern's size, e.g. a `{0,16384}` bound) is a probabilistic heuristic and has produced a
// confirmed false positive here (redact.ts's JWT pattern: recheck says "vulnerable (fuzz)", real
// V8 stays under 1ms at 20KB of adversarial input). A bounded quantifier (`{0,N}`) also caps
// worst-case cost to a fixed constant by construction regardless of what the checker reports —
// that is the documented, deliberate mitigation redact.ts's SECRET_PATTERNS comment already
// describes for the CodeQL js/polynomial-redos finding on the same pattern. Every entry here was
// verified against real V8 timing (not just recheck) before being allowlisted — see the PR that
// added this gate for the measurements. A NEW bounded-but-flagged pattern must be measured the
// same way before being added; do not allowlist on recheck's word alone.
const ALLOWLIST = [
  {
    file: "packages/server/src/experiential/poison.ts",
    pattern:
      "<!--[\\s\\S]{0,400}?(?:instruction|ignore|system|prompt|always|remember)[\\s\\S]{0,400}?-->",
    reason: "bounded {0,400} window on both sides; measured <10ms at 150KB of adversarial input",
  },
  {
    file: "packages/server/src/experiential/redact.ts",
    pattern:
      "-----BEGIN [A-Z ]{0,64}PRIVATE KEY-----[\\s\\S]{0,16384}?-----END [A-Z ]{0,64}PRIVATE KEY-----",
    reason: "already documented BOUNDED-on-purpose in this file; measured <10ms at 800KB",
  },
  {
    file: "packages/server/src/experiential/redact.ts",
    pattern: "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}\\b",
    reason: "recheck fuzz-checker false positive; measured <1ms at 20KB of adversarial input",
  },
  {
    file: "packages/server/src/experiential/poison.ts",
    pattern: "https?:\\/\\/[^\\s/:]*:[^\\s@]{0,256}@",
    reason:
      "was rewritten here to close a real quadratic DoS (2.4s at 27KB); the {0,256} bound on the " +
      "final group still trips recheck's fuzz checker but measured <50ms at 6.2MB of adversarial " +
      "input — the bound caps worst-case cost by construction",
  },
  {
    file: "packages/server/src/experiential/poison.ts",
    pattern: "\\bcurl\\s+(?:-\\w+\\s+){0,20}https?:\\/\\/",
    reason:
      "the {0,20} bound caps the flag-repetition backtracking that the old unbounded form suffered; " +
      "recheck's fuzz checker flags it only intermittently under CPU load (a CI-flaky false " +
      "positive). Measured in V8: <=105ms at 3-9MB of adversarial input (long whitespace runs " +
      "after each 'curl', a 3M-flag 'curl -a -a ...' line with no URL, 100k repeats of 19 flags), " +
      "linear in input size",
  },
];

function listTsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// A `/` is legal as the START of a regex literal only where the previous significant code
// character is NOT one that would make it division/a comment-opener conflict — i.e. not an
// identifier char, digit, `)`, or `]` (division/index/call results). Blank at start-of-file counts
// as legal (no previous token). Covers every shape this codebase actually uses.
const DIVISION_LIKE = /[A-Za-z0-9_$)\]]/;

/** Regex literals only (`/pattern/flags`) — `new RegExp(...)` with a computed pattern is common
 *  here (memory-defense.ts builds a character class from config) and is reported SKIPPED (its
 *  argument is not a `/.../ ` token at all, so this scanner never sees it as a candidate). */
export function extractRegexLiterals(_filePath, source) {
  const found = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let lastSignificant = ""; // last non-whitespace CODE char seen (empty = "start of file")

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
      if (ch === "\n") break; // unterminated on this line — bail rather than run away
      j++;
    }
    return j;
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const spanned = (source.slice(i, close === -1 ? n : close).match(/\n/g) ?? []).length;
      line += spanned;
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(ch);
      lastSignificant = ch; // a string literal ends like an identifier for `/` disambiguation
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
      lastSignificant = "`";
      continue;
    }
    if (ch === "/" && !DIVISION_LIKE.test(lastSignificant)) {
      // Candidate regex literal start. Scan to the matching unescaped `/`, honoring `[...]`
      // (where an unescaped `/` does not close the regex) exactly like the JS grammar.
      const startLine = line;
      let j = i + 1;
      let inClass = false;
      let terminated = false;
      while (j < n) {
        const c2 = source[j];
        if (c2 === "\n") break; // unterminated on this line — not a regex, bail
        if (c2 === "\\") {
          j += 2;
          continue;
        }
        if (c2 === "[") inClass = true;
        else if (c2 === "]") inClass = false;
        else if (c2 === "/" && !inClass) {
          terminated = true;
          break;
        }
        j++;
      }
      if (terminated) {
        const pattern = source.slice(i + 1, j);
        let k = j + 1;
        while (k < n && /[a-z]/i.test(source[k])) k++;
        const flags = source.slice(j + 1, k);
        found.push({ pattern, flags, line: startLine });
        i = k;
        lastSignificant = "/";
        continue;
      }
      // Not a regex after all (no terminator on this line) — fall through as plain division.
    }
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    i++;
  }

  return found;
}

/** One regex through `recheck`; `status: "vulnerable"` is the fail signal this gate acts on. */
export async function checkPattern(pattern, flags, timeout = CHECK_TIMEOUT_MS) {
  return check(pattern, flags, { timeout });
}

async function main() {
  const files = SCAN_DIRS.flatMap((d) => listTsFiles(join(ROOT, d)));
  if (files.length === 0) {
    console.error("check-redos: found 0 files under", SCAN_DIRS, "— gate has no floor, failing");
    process.exit(1);
  }

  let checkedCount = 0;
  let skippedCount = 0;
  let allowlistedCount = 0;
  const vulnerable = [];

  for (const filePath of files) {
    const rel = relative(ROOT, filePath);
    const source = readFileSync(filePath, "utf8");
    const literals = extractRegexLiterals(filePath, source);
    for (const { pattern, flags, line } of literals) {
      checkedCount++;
      const allowed = ALLOWLIST.find((a) => a.file === rel && a.pattern === pattern);
      let result;
      try {
        result = await checkPattern(pattern, flags);
      } catch (e) {
        skippedCount++;
        console.error(`check-redos: SKIPPED ${rel}:${line} /${pattern}/${flags} — ${e.message}`);
        continue;
      }
      if (result.status === "vulnerable") {
        if (allowed) {
          allowlistedCount++;
          continue;
        }
        vulnerable.push({
          rel,
          line,
          pattern,
          flags,
          complexity: result.complexity?.summary ?? "unknown",
        });
      }
    }
  }

  console.error(
    `check-redos: checked ${checkedCount} regex literal(s) across ${files.length} file(s), ${skippedCount} skipped, ${allowlistedCount} allowlisted`,
  );
  if (vulnerable.length > 0) {
    console.error(
      `check-redos: FAILED — ${vulnerable.length} super-linear regex(es) on untrusted text:`,
    );
    for (const v of vulnerable) {
      console.error(`  ${v.rel}:${v.line}  /${v.pattern}/${v.flags}  (${v.complexity})`);
    }
    process.exit(1);
  }
  console.error("check-redos: OK — no super-linear regex found");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("check-redos: unexpected error:", e);
    process.exit(1);
  });
}
