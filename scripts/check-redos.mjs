#!/usr/bin/env node
/**
 * check-redos — every regex that scans UNTRUSTED text in `vault/` (note bodies: links, tags,
 * rewrite) and `experiential/` (memory-defense secret redaction, prompt-injection detection) must
 * be linear-time, not just backtracking-free within one match attempt.
 *
 * WHY THIS EXISTS: `vault/links.ts`'s MDLINK/WIKILINK regexes each ran a full re-scan-to-end-of-line
 * on every FAILED start position, and a crafted note (many `"[a]("` with no closing paren) drove an
 * 80 KB line to 11+ seconds. Neither regex has classic catastrophic (ambiguous nested-quantifier)
 * backtracking — the character classes exclude their own delimiter, so no single match attempt ever
 * backtracks — which is exactly the shape `recheck`'s automaton-based checker classifies as
 * "vulnerable, polynomial degree 2" rather than "safe, linear": this gate would have caught it.
 *
 * FAIL CLOSED: a regex passes only when `recheck` says `status: "safe"`. `vulnerable`, and every
 * "could not decide" outcome (`unknown` with a timeout / unsupported / invalid error, or a thrown
 * exception) FAIL unless the exact pattern is in ALLOWLIST below with its measurement — a checker
 * that gave up is not evidence of linearity, and those are precisely the patterns too large or
 * exotic for the automaton to classify.
 *
 * Regex literals are pulled out with a hand-rolled single-pass scanner (not the TypeScript
 * compiler API — `typescript@7` on this repo's pin ships only the new native/Go-ported AST under
 * `typescript/unstable/ast`, not the classic `ts.createSourceFile`/`ts.SyntaxKind` surface, and no
 * other script here depends on it), matching this repo's other source-scan gates
 * (check-comment-style.mjs, check-embedding-transport-vendor-neutral.mjs): strings are stepped
 * over, `//` and `/* *\/` comments are stepped over too — so a regex embedded in a comment (e.g.
 * redact.ts's documented-but-deliberately-unshipped unbounded PRIVATE KEY example) is never
 * extracted — and a bare `/` is read as a regex literal start only where a regex is syntactically
 * legal: not after an identifier, number, `)`/`]` or a postfix `++`/`--` (division), but yes after
 * the keywords that take an expression (`return`, `typeof`, `case`, ...), including across a
 * newline. Template literals are walked, not skipped: their `${...}` expressions are scanned too.
 * Same pragmatic scope as those gates: not a full lexer, exercised against this codebase's shapes.
 *
 * DYNAMIC REGEXES are reported, never silently skipped: `recheck` needs a literal, so a
 * runtime-built `new RegExp(...)` / `RegExp(...)` call, or a regex literal written inside a
 * template literal's `${...}`, cannot be classified. Each one is a FINDING that fails the gate
 * unless it is in DYNAMIC_ALLOWLIST with a justification (or is refactored into a literal). Not
 * covered: a string passed to `.match()`/`.search()`, which the engine also compiles at runtime —
 * neither tree does that today.
 *
 * SCOPE: every `.ts` under `packages/server/src/vault/` and `packages/server/src/experiential/`.
 * Both trees run their regexes over content that can be caller/attacker-controlled — a note body,
 * an imported memory episode — as opposed to a config key or a CLI flag. Extend SCAN_DIRS if
 * another untrusted-text scanner grows regexes outside those two trees.
 *
 * CLI: `node scripts/check-redos.mjs [--scan-dir DIR]... [--timeout-ms N]`. `--scan-dir` replaces
 * SCAN_DIRS (used by the tests to run the gate against synthetic fixtures); the allowlists still
 * apply, and the stale-allowlist floor is only enforced on a default (whole-repo) run.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the allowlist and fixtures hold literal source text that contains `${...}`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check } from "recheck";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["packages/server/src/vault", "packages/server/src/experiential"];
const CHECK_TIMEOUT_MS = 20_000;

// `recheck`'s automaton checker is exact; its FUZZ checker (used when the automaton gives up on a
// pattern's size, e.g. a `{0,16384}` bound) is a probabilistic heuristic and has produced a
// confirmed false positive here (redact.ts's JWT pattern: recheck says "vulnerable (fuzz)", real
// V8 stays under 1ms at 20KB of adversarial input). A bounded quantifier (`{0,N}`) also caps
// worst-case cost to a fixed constant by construction regardless of what the checker reports —
// that is the documented, deliberate mitigation redact.ts's SECRET_PATTERNS comment already
// describes for the CodeQL js/polynomial-redos finding on the same pattern.
//
// An entry is keyed on the exact file + pattern source and MUST carry `reason` (why the checker's
// verdict is wrong or irrelevant) and `measured` (the real V8 timing that backs it). Every entry
// here was verified against real V8 timing, not just recheck's word. A NEW entry must be measured
// the same way before being added; the allowlist applies to `vulnerable` AND to every "checker
// could not decide" outcome (timeout, unsupported, invalid, thrown).
export const ALLOWLIST = [
  {
    file: "packages/server/src/experiential/poison.ts",
    pattern:
      "<!--[\\s\\S]{0,400}?(?:instruction|ignore|system|prompt|always|remember)[\\s\\S]{0,400}?-->",
    reason: "bounded {0,400} window on both sides caps worst-case cost by construction",
    measured: "<10ms at 150KB of adversarial input",
  },
  {
    file: "packages/server/src/experiential/redact.ts",
    pattern:
      "-----BEGIN [A-Z ]{0,64}PRIVATE KEY-----[\\s\\S]{0,16384}?-----END [A-Z ]{0,64}PRIVATE KEY-----",
    reason: "already documented BOUNDED-on-purpose in this file",
    measured: "<10ms at 800KB",
  },
  {
    file: "packages/server/src/experiential/redact.ts",
    pattern: "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}\\b",
    reason: "recheck fuzz-checker false positive",
    measured: "<1ms at 20KB of adversarial input",
  },
  {
    file: "packages/server/src/experiential/poison.ts",
    pattern: "https?:\\/\\/[^\\s/:]*:[^\\s@]{0,256}@",
    reason:
      "was rewritten here to close a real quadratic DoS (2.4s at 27KB); the {0,256} bound on the " +
      "final group still trips recheck's fuzz checker but caps worst-case cost by construction",
    measured: "<50ms at 6.2MB of adversarial input",
  },
  {
    file: "packages/server/src/experiential/poison.ts",
    pattern: "\\bcurl\\s+(?:-\\w+\\s+){0,20}https?:\\/\\/",
    reason:
      "the {0,20} bound caps the flag-repetition backtracking that the old unbounded form " +
      "suffered; recheck's fuzz checker flags it only intermittently under CPU load (a CI-flaky " +
      "false positive)",
    measured:
      "<=105ms at 3-9MB of adversarial input (long whitespace runs after each 'curl', a " +
      "3M-flag 'curl -a -a ...' line with no URL, 100k repeats of 19 flags), linear in input size",
  },
];

// Dynamic sites (see the header): keyed on file + kind + the exact call/literal source text.
export const DYNAMIC_ALLOWLIST = [
  {
    file: "packages/server/src/experiential/memory-defense.ts",
    kind: "new-regexp",
    text: 'new RegExp(`[${body}]`, "gu")',
    reason:
      "a single character class assembled from the fixed INVISIBLE_SPLICE_RANGES table of " +
      "\\u{..} escapes: one class, no quantifier and no alternation, so every match attempt " +
      "consumes at most one character",
    measured: "constant-size pattern built once at module load; no input-dependent construction",
  },
  {
    file: "packages/server/src/experiential/forget.ts",
    kind: "new-regexp",
    text: "new RegExp(`^prewarm-${esc}-([0-9a-f]{64}|no-acl)\\\\.json$`)",
    reason:
      "anchored (^...$) match over a directory entry name; `esc` is the vault id with every " +
      "regex metacharacter escaped, so it is a literal, and the only quantifier is a fixed {64}",
    measured: "matched against readdir() names only (short, not note content); linear by shape",
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

// A `/` is legal as the START of a regex literal only where the previous significant code token
// is not one that would make it division: an identifier char, digit, `)` or `]` (division/index/
// call results), or a postfix `++`/`--`. Blank at start-of-file counts as legal (no previous
// token). The exception is an identifier that is really a keyword taking an expression operand:
// `return /re/`, `typeof /re/`, `case /re/:` ... — the last character of the keyword looks like
// an identifier, which is how `return /re/.test(x)` was once read as division and never checked.
const DIVISION_LIKE = /[\p{ID_Continue}$)\]]/u;
export const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "instanceof",
]);
const IDENT_START = /[\p{ID_Start}$_]/u;
const IDENT_PART = /[\p{ID_Continue}$]/u;

/** Walk one source file. Returns `literals` (`/pattern/flags` tokens `recheck` can check) and
 *  `dynamic` findings (runtime-built `new RegExp(...)`/`RegExp(...)` calls, and regex literals
 *  written inside a template literal's `${...}`) that it cannot. Both carry a 1-based `line`. */
export function scanSource(source) {
  const literals = [];
  const dynamic = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let templateDepth = 0;

  /** Step over a quoted string; returns the index just past it. Bails at an unescaped newline. */
  const skipQuoted = (quote) => {
    let j = i + 1;
    while (j < n) {
      const ch = source[j];
      if (ch === "\\") {
        if (source[j + 1] === "\n") line++;
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

  /** Source text of the call whose `(` is at `open`, through its matching `)`. */
  const callText = (start, open) => {
    let depth = 0;
    for (let j = open; j < n; j++) {
      const ch = source[j];
      if (ch === '"' || ch === "'" || ch === "`") {
        j++;
        while (j < n && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return source.slice(start, j + 1);
    }
    return source.slice(start, open + 1);
  };

  const scanTemplate = () => {
    i++; // opening backtick
    while (i < n) {
      const ch = source[i];
      if (ch === "\\") {
        if (source[i + 1] === "\n") line++;
        i += 2;
        continue;
      }
      if (ch === "`") {
        i++;
        return;
      }
      if (ch === "$" && source[i + 1] === "{") {
        i += 2;
        templateDepth++;
        scanCode(true);
        templateDepth--;
        continue;
      }
      if (ch === "\n") line++;
      i++;
    }
  };

  /** Scan code until EOF, or (inside a template `${`) until the unmatched closing `}`. */
  function scanCode(stopAtBrace) {
    let braceDepth = 0;
    let last = ""; // last non-whitespace CODE char seen ("" = start)
    let lastWord = ""; // the identifier that ended at `last`, when it is a bare (non-member) one
    let lastWordStart = -1;
    let last2 = ""; // the char before `last`, to recognise postfix ++/--

    const setLast = (ch) => {
      last2 = last;
      last = ch;
      lastWord = "";
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
        line += (source.slice(i, close === -1 ? n : close).match(/\n/g) ?? []).length;
        i = close === -1 ? n : close + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        i = skipQuoted(ch);
        setLast(ch); // a string literal ends like an identifier for `/` disambiguation
        continue;
      }
      if (ch === "`") {
        scanTemplate();
        setLast("`");
        continue;
      }
      if (IDENT_START.test(ch)) {
        const start = i;
        let j = i + 1;
        while (j < n && IDENT_PART.test(source[j])) j++;
        const word = source.slice(start, j);
        const newStart = lastWord === "new" ? lastWordStart : -1;
        const memberAccess = last === ".";
        i = j;
        setLast(word[word.length - 1]);
        if (!memberAccess) {
          lastWord = word;
          lastWordStart = start;
        }
        if (word === "RegExp") {
          let k = j;
          while (k < n && /\s/.test(source[k])) k++;
          const called = source[k] === "(";
          if (called || newStart >= 0) {
            const from = newStart >= 0 ? newStart : start;
            dynamic.push({
              kind: "new-regexp",
              line,
              text: called ? callText(from, k) : source.slice(from, j),
            });
          }
        }
        continue;
      }
      if (ch === "/" && regexAllowed(last, last2, lastWord)) {
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
          if (templateDepth > 0) {
            dynamic.push({ kind: "template-regex", line: startLine, text: `/${pattern}/${flags}` });
          } else {
            literals.push({ pattern, flags, line: startLine });
          }
          i = k;
          setLast("/");
          continue;
        }
        // Not a regex after all (no terminator on this line) — fall through as plain division.
      }
      if (ch === "\n") {
        line++;
        i++;
        continue;
      }
      if (stopAtBrace) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") {
          if (braceDepth === 0) {
            i++;
            return;
          }
          braceDepth--;
        }
      }
      if (!/\s/.test(ch)) setLast(ch);
      i++;
    }
  }

  scanCode(false);
  return { literals, dynamic };
}

/** Whether a `/` after (`last`, `last2`, `lastWord`) opens a regex literal rather than dividing. */
function regexAllowed(last, last2, lastWord) {
  if (lastWord && REGEX_PRECEDING_KEYWORDS.has(lastWord)) return true;
  if (last === "") return true;
  if ((last === "+" || last === "-") && last2 === last) return false; // postfix ++/--
  return !DIVISION_LIKE.test(last);
}

/** Regex literals only (`/pattern/flags`), with their line. Dynamic sites: see `scanSource`. */
export function extractRegexLiterals(_filePath, source) {
  return scanSource(source).literals;
}

/** One regex through `recheck`. */
export async function checkPattern(pattern, flags, timeout = CHECK_TIMEOUT_MS) {
  return check(pattern, flags, { timeout });
}

/** Fail closed: only `status: "safe"` passes. Returns `{ ok, detail }`; `detail` names why not. */
export function classifyResult(result) {
  if (result.status === "safe") return { ok: true, detail: "safe" };
  if (result.status === "vulnerable") {
    return { ok: false, detail: `vulnerable: ${result.complexity?.summary ?? "unknown"}` };
  }
  const error = result.error;
  const why = error ? `${error.kind}${error.message ? ` (${error.message})` : ""}` : "no verdict";
  return { ok: false, detail: `${result.status ?? "no status"}: ${why}` };
}

const oneLine = (text) => text.replace(/\s+/g, " ");

/** Run the gate over `files`. Returns `{ failures, stale, counts }`; the caller decides the exit. */
export async function runGate({
  root = ROOT,
  files,
  allowlist = ALLOWLIST,
  dynamicAllowlist = DYNAMIC_ALLOWLIST,
  timeoutMs = CHECK_TIMEOUT_MS,
  log = () => {},
}) {
  const failures = [];
  const counts = { literals: 0, safe: 0, allowlisted: 0, dynamic: 0, dynamicAllowlisted: 0 };
  const usedAllow = new Set();
  const usedDynamic = new Set();

  for (const filePath of files) {
    const rel = relative(root, filePath);
    const source = readFileSync(filePath, "utf8");
    const { literals, dynamic } = scanSource(source);

    for (const { pattern, flags, line } of literals) {
      counts.literals++;
      const allowed = allowlist.find((a) => a.file === rel && a.pattern === pattern);
      if (allowed) usedAllow.add(allowed); // matched a real site, whatever the checker says
      let verdict;
      try {
        verdict = classifyResult(await checkPattern(pattern, flags, timeoutMs));
      } catch (e) {
        verdict = { ok: false, detail: `checker threw: ${e?.message ?? e}` };
      }
      if (verdict.ok) {
        counts.safe++;
        continue;
      }
      if (allowed) {
        counts.allowlisted++;
        continue;
      }
      failures.push(`${rel}:${line}  /${pattern}/${flags}  (${verdict.detail})`);
    }

    for (const { kind, line, text } of dynamic) {
      counts.dynamic++;
      const flat = oneLine(text);
      const allowed = dynamicAllowlist.find(
        (a) => a.file === rel && a.kind === kind && oneLine(a.text) === flat,
      );
      if (allowed) {
        counts.dynamicAllowlisted++;
        usedDynamic.add(allowed);
        continue;
      }
      failures.push(
        `${rel}:${line}  ${flat}  (dynamic ${kind}: not checkable by recheck — refactor into a ` +
          "regex literal, or add a measured DYNAMIC_ALLOWLIST entry)",
      );
    }
    log(rel);
  }

  const stale = [
    ...allowlist.filter((a) => !usedAllow.has(a)).map((a) => `${a.file}  /${a.pattern}/`),
    ...dynamicAllowlist.filter((a) => !usedDynamic.has(a)).map((a) => `${a.file}  ${a.text}`),
  ];
  return { failures, stale, counts };
}

function parseArgs(argv) {
  const scanDirs = [];
  let timeoutMs = CHECK_TIMEOUT_MS;
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === "--scan-dir") scanDirs.push(argv[++k]);
    else if (argv[k] === "--timeout-ms") timeoutMs = Number(argv[++k]);
    else throw new Error(`unknown argument: ${argv[k]}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be > 0");
  return { scanDirs, timeoutMs };
}

async function main() {
  const { scanDirs, timeoutMs } = parseArgs(process.argv.slice(2));
  const custom = scanDirs.length > 0;
  const dirs = custom ? scanDirs.map((d) => resolve(d)) : SCAN_DIRS.map((d) => join(ROOT, d));
  const files = dirs.flatMap((d) => listTsFiles(d));
  if (files.length === 0) {
    console.error("check-redos: found 0 files under", dirs, "— gate has no floor, failing");
    process.exit(1);
  }

  const { failures, stale, counts } = await runGate({ files, timeoutMs });
  console.error(
    `check-redos: ${counts.literals} regex literal(s) across ${files.length} file(s): ` +
      `${counts.safe} safe, ${counts.allowlisted} allowlisted, ${failures.length} failing; ` +
      `${counts.dynamic} dynamic site(s), ${counts.dynamicAllowlisted} allowlisted`,
  );
  if (counts.literals === 0 && !custom) {
    console.error("check-redos: extracted 0 regex literals from a non-empty tree — failing");
    process.exit(1);
  }
  // A whole-repo run must also notice an allowlist entry whose site moved or was deleted: an
  // entry that matches nothing is a stale exemption that would silently cover a future edit.
  const staleFail = !custom && stale.length > 0;
  if (failures.length > 0 || staleFail) {
    if (failures.length > 0) {
      console.error(
        `check-redos: FAILED — ${failures.length} regex(es) not proven linear-time on untrusted text:`,
      );
      for (const f of failures) console.error(`  ${f}`);
    }
    if (staleFail) {
      console.error(`check-redos: FAILED — ${stale.length} stale allowlist entr(ies):`);
      for (const s of stale) console.error(`  ${s}`);
    }
    process.exit(1);
  }
  console.error("check-redos: OK — every regex is proven safe or allowlisted with a measurement");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("check-redos: unexpected error:", e);
    process.exit(1);
  });
}
