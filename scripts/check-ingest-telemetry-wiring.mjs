#!/usr/bin/env node
/**
 * THE-590 — ingest telemetry wiring gate (source-scan regression guard).
 *
 * THE-590 found that the MCP `index_vault` tool path called `indexVault()` and then only updated
 * an in-memory health field — it never reached `recordIngestStats()` (metrics/ingest-stats.ts),
 * so agent-triggered indexing (the normal production path) emitted zero Prometheus counters and no
 * `event_log` row. The fix threaded the existing `recordIngestStatsFor` closure through the
 * `onIndexVaultComplete` sink. Nothing stops a future edit from quietly deleting that one line
 * again — vitest cannot catch it, because the test that proves the mechanism works constructs its
 * OWN `onIndexVaultComplete` callback (packages/server/test/m2-helpers.ts), not cli.ts's. This gate
 * is the thing that would actually notice.
 *
 * Invariant: every production call to `indexVault()` under packages/server/src/ has its returned
 * IndexStats reach a `recordIngestStats*(...)` call — either directly in the same enclosing block,
 * through a `.then(...)` continuation, or by delegating to the `onIndexVaultComplete` sink, in
 * which case the sink's OWN construction (wherever `onIndexVaultComplete: (...) => { ... }` is
 * assigned as a value, not just declared as a type) must itself call `recordIngestStats*(...)`.
 *
 * DERIVED, not a hardcoded list of three: both `indexVault(` call sites and `onIndexVaultComplete:`
 * sink assignments are found by scanning the source, so a fourth caller or a second sink added
 * later is covered automatically rather than silently exempt.
 *
 * Deliberately a bracket-matching scan, not a full AST parse (this repo's other source-scan gates
 * are plain regex — check-dev-dep-imports.mjs, check-perf-timing-scope.mjs — but the relationship
 * here is one level removed from the call site for the MCP path, so a fixed-line-window heuristic
 * would either miss the real continuation or false-positive on unrelated later code). Matching
 * parens/braces by depth from a well-defined start point (the call's own opening paren, or a sink
 * assignment's opening brace) is unambiguous and requires no magic window size.
 *
 * Two floors, per THE-544/THE-585's lesson that a check which can pass by finding nothing is not a
 * check: zero `indexVault(` call sites or zero `onIndexVaultComplete:` sink assignments both mean
 * the scan itself broke (a rename, a moved file), not that the codebase shrank to nothing.
 *
 * NOT comment/string-aware originally — that was a real bug, twice observed as a false positive
 * (prose containing `indexVault(` counted as a call site, #598 and again after a reword) and, more
 * seriously, as a false negative (a comment mentioning `recordIngestStats` near a genuinely
 * uninstrumented call made `consumerTextAfterCall`'s regex test pass on comment text). Every scan
 * now runs against `blankNonCode(source)`, which replaces line and block comments and '...'/"..."
 * string literals with spaces (newlines preserved) before either the call/sink scan or the
 * consumer-text check. Template literals are deliberately left untouched — see blankNonCode's own
 * comment for why blanking is the conservative failure direction and over-eager blanking is not.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SOURCE_GLOBS = ["packages/server/src/*.ts", "packages/server/src/**/*.ts"];
const MIN_EXPECTED_CALL_SITES = 1;
const MIN_EXPECTED_SINK_ASSIGNMENTS = 1;

export const RECORD_CALL_RE = /\brecordIngestStats\w*\s*\(/;
export const SINK_DELEGATE_RE = /\bonIndexVaultComplete\s*\?\.\s*\(/;

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Replaces `//` line comments, block comments, and '...'/"..." string literals
 * with spaces, byte-offset-preserving (same length, newlines kept as newlines) so every downstream
 * index — `matchParen`, `matchBrace`, `restOfEnclosingBlock`, and the `source.slice(0,
 * i).split("\n").length` line-number computation — stays valid against the blanked text exactly as
 * it was against the raw text.
 *
 * Template literals are deliberately NOT blanked. Correctly finding a template literal's true end
 * requires tracking `${...}` interpolation nesting — and a nested interpolation can itself contain
 * a backtick, a comment, or a string. This function tracks `${...}` brace depth well enough to
 * find the common-case end, but does not fully re-enter this same state machine for content inside
 * an interpolation. Getting that wrong in either direction has a cost, and the costs are NOT
 * symmetric: under-blanking (treating some comment/string text as if it were code) reproduces the
 * existing false-positive failure mode — loud, already the status quo, cheap to reword around.
 * Over-blanking (erasing a real call site because it sat inside what looked like a template
 * literal) would hide a genuine violation — silent, and exactly the worse failure this gate exists
 * to prevent. So the rule is: when in doubt, leave template-literal content as real code rather
 * than risk blanking an actual `indexVault(` or `recordIngestStats(` call sitting in a `${...}`
 * interpolation.
 */
export function blankNonCode(source) {
  const n = source.length;
  const out = new Array(n);
  let i = 0;

  while (i < n) {
    const c = source[i];

    // `//` line comment: blank through (not including) the newline that ends it.
    if (c === "/" && source[i + 1] === "/") {
      let j = i;
      while (j < n && source[j] !== "\n") j++;
      for (let k = i; k < j; k++) out[k] = " ";
      i = j;
      continue;
    }

    // `/* ... */` block comment. Unterminated (unbalanced source) blanks to EOF rather than
    // throwing — a syntax error here is not this gate's job to diagnose.
    if (c === "/" && source[i + 1] === "*") {
      const closeAt = source.indexOf("*/", i + 2);
      const end = closeAt === -1 ? n : closeAt + 2;
      for (let k = i; k < end; k++) out[k] = source[k] === "\n" ? "\n" : " ";
      i = end;
      continue;
    }

    // '...' or "..." string literal. Respects `\` escapes. A raw newline before the closing quote
    // means the string was never valid JS/TS to begin with — stop blanking at the newline rather
    // than swallowing the rest of the file.
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < n && source[j] !== quote && source[j] !== "\n") {
        j += source[j] === "\\" ? 2 : 1;
      }
      if (j < n && source[j] === quote) j++; // include the closing quote
      for (let k = i; k < j; k++) out[k] = " ";
      i = j;
      continue;
    }

    // Template literal: copy verbatim, untouched — see the function doc comment for why. Tracks
    // `${...}` brace depth so a `}` or backtick inside an interpolation doesn't end the template
    // early in the common case; does not recurse into nested templates inside an interpolation.
    if (c === "`") {
      let j = i + 1;
      let exprDepth = 0;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (exprDepth === 0 && source[j] === "`") {
          j++;
          break;
        }
        if (exprDepth === 0 && source[j] === "$" && source[j + 1] === "{") {
          exprDepth = 1;
          j += 2;
          continue;
        }
        if (exprDepth > 0) {
          if (source[j] === "{") exprDepth++;
          else if (source[j] === "}") exprDepth--;
        }
        j++;
      }
      for (let k = i; k < j; k++) out[k] = source[k];
      i = j;
      continue;
    }

    out[i] = c;
    i++;
  }

  return out.join("");
}

/** Forward paren-depth match: `source[openParenIndex]` must be '('. Returns the index of its
 *  matching ')', or -1 if the source ends unbalanced (malformed input — caller treats as "no
 *  match" rather than throwing, since a syntax error here is not this gate's job to diagnose). */
export function matchParen(source, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Forward brace-depth match: `source[openBraceIndex]` must be '{'. Returns the index of its
 *  matching '}', or -1 if unbalanced. */
export function matchBrace(source, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Everything from `fromIndex` up to (excluding) the point where brace depth first goes NEGATIVE —
 *  i.e. the rest of the innermost block that already contains `fromIndex`. Unlike scanning
 *  backward for the enclosing `{`, this needs no assumption about what precedes fromIndex: depth
 *  starts at 0 and going negative is an unambiguous "we just exited our own block" signal. */
export function restOfEnclosingBlock(source, fromIndex) {
  let depth = 0;
  let i = fromIndex;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth < 0) break;
    }
  }
  return source.slice(fromIndex, i);
}

/** A textual match of `indexVault(` is a real call to the imported indexer function unless it is
 *  either the function's own declaration (`...function indexVault(`) or a property/method call on
 *  some other value (`deps.indexVault(...)`, the M1 add_vault hook of the same name — a different
 *  symbol entirely, see cli.ts's `indexVault: async (vaultId) => { const s = await indexVault(...) }`
 *  where the OUTER key is that hook and the INNER call is the real indexer). */
export function isRealCallSite(source, matchIndex) {
  const before = source.slice(Math.max(0, matchIndex - 40), matchIndex);
  if (/\.\s*$/.test(before)) return false;
  if (/\bfunction\s*$/.test(before)) return false;
  return true;
}

/** `blankedSource` must already have comments/strings blanked (see blankNonCode) — this scans raw
 *  text with no awareness of what is prose vs code. Line numbers are computed against the same
 *  blanked text, which is safe because blanking never changes the newline positions. */
export function findIndexVaultCallSites(file, blankedSource) {
  const sites = [];
  for (const m of blankedSource.matchAll(/\bindexVault\s*\(/g)) {
    if (!isRealCallSite(blankedSource, m.index)) continue;
    const line = blankedSource.slice(0, m.index).split("\n").length;
    const openParen = m.index + m[0].length - 1;
    const callEnd = matchParen(blankedSource, openParen);
    if (callEnd === -1) {
      sites.push({ file, line, ok: false, reason: "unbalanced parens after the call" });
      continue;
    }
    sites.push({ file, line, callEnd });
  }
  return sites;
}

/** Given the position right after an `indexVault(...)` call's own closing paren, find the text
 *  whose presence proves the stats got somewhere: the `.then(...)` continuation's body when
 *  chained, else the rest of the enclosing block (the `const s = await indexVault(...)` form).
 *  `blankedSource` must already have comments/strings blanked — otherwise a comment mentioning
 *  `recordIngestStats` right after an uninstrumented call would make this look wired (THE-590's
 *  gate itself missing the thing it exists to catch). */
export function consumerTextAfterCall(blankedSource, callEnd) {
  const after = blankedSource.slice(callEnd + 1);
  const thenMatch = after.match(/^\s*\.then\s*\(/);
  if (thenMatch) {
    const thenOpenParen = callEnd + 1 + thenMatch[0].length - 1;
    const thenClose = matchParen(blankedSource, thenOpenParen);
    if (thenClose !== -1) return blankedSource.slice(thenOpenParen, thenClose + 1);
  }
  return restOfEnclosingBlock(blankedSource, callEnd + 1);
}

/** Every place `onIndexVaultComplete` is assigned an actual function VALUE with a `{ ... }` body —
 *  as opposed to `onIndexVaultComplete?: (...) => void;`, the optional-property TYPE declaration in
 *  tools/m2/index.ts (no `?`, and the arrow must have a brace body, which a bare type-ending
 *  `=> void;` does not). `blankedSource` must already have comments/strings blanked. */
export function findSinkAssignments(file, blankedSource) {
  const sinks = [];
  for (const m of blankedSource.matchAll(
    /\bonIndexVaultComplete\s*:\s*(?:async\s*)?\([^()]*\)\s*=>\s*\{/g,
  )) {
    const line = blankedSource.slice(0, m.index).split("\n").length;
    const openBrace = m.index + m[0].length - 1;
    const closeBrace = matchBrace(blankedSource, openBrace);
    if (closeBrace === -1) {
      sinks.push({ file, line, ok: false, reason: "unbalanced braces in the sink body" });
      continue;
    }
    const body = blankedSource.slice(openBrace, closeBrace + 1);
    sinks.push({ file, line, wired: RECORD_CALL_RE.test(body) });
  }
  return sinks;
}

function main() {
  const files = run("git", ["ls-files", ...SOURCE_GLOBS])
    .split("\n")
    .filter(Boolean)
    // POSIX-normalize: git ls-files already prints '/'-separated paths on every OS (including
    // windows-latest, where this gate also runs), so this is a defensive no-op documenting that
    // invariant rather than a fix for an observed case.
    .map((f) => f.replaceAll("\\", "/"));

  if (files.length === 0) {
    console.error(
      "ingest-telemetry-wiring gate: git ls-files matched no files under packages/server/src — " +
        "refusing to report success over a check that examined nothing.",
    );
    process.exit(1);
  }

  const blankedByFile = new Map();
  const callSites = [];
  const sinkAssignments = [];
  for (const file of files) {
    const blanked = blankNonCode(readFileSync(file, "utf8"));
    blankedByFile.set(file, blanked);
    callSites.push(...findIndexVaultCallSites(file, blanked));
    sinkAssignments.push(...findSinkAssignments(file, blanked));
  }

  if (callSites.length < MIN_EXPECTED_CALL_SITES) {
    console.error(
      `ingest-telemetry-wiring gate: found ${callSites.length} indexVault() call site(s) under ` +
        "packages/server/src (expected >= 1). This almost certainly means the scan itself broke " +
        "(indexVault renamed or moved) — refusing to pass a check that found nothing to verify.",
    );
    process.exit(1);
  }
  if (sinkAssignments.length < MIN_EXPECTED_SINK_ASSIGNMENTS) {
    console.error(
      `ingest-telemetry-wiring gate: found ${sinkAssignments.length} onIndexVaultComplete sink ` +
        "assignment(s) under packages/server/src (expected >= 1). This almost certainly means the " +
        "scan itself broke — refusing to pass a check that found nothing to verify.",
    );
    process.exit(1);
  }

  console.log(
    `ingest-telemetry-wiring gate: ${files.length} source file(s) scanned, ${callSites.length} ` +
      `indexVault() call site(s), ${sinkAssignments.length} onIndexVaultComplete sink assignment(s)`,
  );

  const violations = [];

  for (const site of callSites) {
    if (site.ok === false) {
      violations.push(`${site.file}:${site.line}  ${site.reason}`);
      continue;
    }
    const blanked = blankedByFile.get(site.file);
    const consumerText = consumerTextAfterCall(blanked, site.callEnd);
    const reachesRecordCall = RECORD_CALL_RE.test(consumerText);
    const delegatesToSink = SINK_DELEGATE_RE.test(consumerText);
    console.log(
      `  ${site.file}:${site.line}  ${reachesRecordCall ? "-> recordIngestStats*" : delegatesToSink ? "-> onIndexVaultComplete sink" : "UNINSTRUMENTED"}`,
    );
    if (!reachesRecordCall && !delegatesToSink) {
      violations.push(
        `${site.file}:${site.line}  indexVault() call whose stats reach neither a ` +
          "recordIngestStats*(...) call nor the onIndexVaultComplete sink — this indexing pass would " +
          "emit no ingest telemetry (no Prometheus counters, no event_log row).",
      );
    }
  }

  for (const sink of sinkAssignments) {
    if (sink.ok === false) {
      violations.push(`${sink.file}:${sink.line}  ${sink.reason}`);
      continue;
    }
    console.log(
      `  ${sink.file}:${sink.line}  onIndexVaultComplete sink ${sink.wired ? "wired" : "NOT WIRED"}`,
    );
    if (!sink.wired) {
      violations.push(
        `${sink.file}:${sink.line}  onIndexVaultComplete sink body does not call a ` +
          "recordIngestStats*(...) — a caller that delegates to this sink (e.g. the MCP index_vault " +
          "tool path, tools/m2/index-tools.ts) emits no ingest telemetry. This is exactly THE-590: " +
          "the sink used to only update indexHealth.lastChunksUpserted.",
      );
    }
  }

  if (violations.length > 0) {
    console.error(
      "\ningest-telemetry-wiring gate: an indexVault() call path does not feed ingest telemetry:\n" +
        violations.map((v) => `  ${v}`).join("\n"),
    );
    process.exit(1);
  }

  process.exit(0);
}

// Importing this module (as its test file does, to reach the exported functions) must have no
// side effects — no git calls, no filesystem reads, no process.exit. Only run the gate when this
// file is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
