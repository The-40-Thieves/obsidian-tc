#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// check-public-text — obsidian-tc is a public repo (The-40-Thieves org). A bare Linear ticket id
// (THE-<digits>) or a linear.app URL leaking into user-facing text exposes the private planning
// plane on the public one, and the link is dead for anyone outside that workspace anyway. This
// scans every git-tracked Markdown file (any depth), the two MCP manifests, and the string literals
// of the CLI sources (packages/server/src/cli/**/*.ts — printed operator text, not code comments)
// for either shape and fails naming the file and line. Where a Linear id documented *provenance*
// (which release something shipped in), the fix is a CHANGELOG.md anchor link instead — CHANGELOG.md
// and changes/ are the only allowlisted paths, since release history legitimately cites tickets and
// is not the same surface as a user guide.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// Git's pathspec `*` DOES cross `/`, so `*.md` is every tracked Markdown file at any depth (docs
// site, wiki, package READMEs, eval and fixture notes, contributor docs). The CLI pathspec covers
// every .ts under packages/server/src/cli/ at any depth.
const CLI_TS_RE = /^packages\/server\/src\/cli\/.*\.ts$/;

function listTrackedCandidates() {
  return run("git", [
    "ls-files",
    "-z",
    "*.md",
    "mcpb/manifest.json",
    "server.json",
    "packages/server/src/cli/*.ts",
  ])
    .split("\0")
    .filter(Boolean);
}

// CHANGELOG.md (release history, not a user-facing guide — this is where provenance belongs
// instead) and changes/ (the CHANGELOG fragments that scripts/release.mjs folds into CHANGELOG.md,
// so it is CHANGELOG text) are the only exemptions. No other path may name a ticket.
const ALLOWLIST_EXACT = new Set(["CHANGELOG.md"]);
const ALLOWLIST_PREFIXES = ["changes/"];

function isAllowlisted(path) {
  if (ALLOWLIST_EXACT.has(path)) return true;
  if (ALLOWLIST_PREFIXES.some((p) => path.startsWith(p))) return true;
  return false;
}

/**
 * Pure: is this tracked path in the scan set? Markdown anywhere, the two manifests, CLI sources,
 * and nothing that is allowlisted. Exported so the scan set itself is unit-testable.
 */
export function isScannedPath(path) {
  if (isAllowlisted(path)) return false;
  return (
    path.endsWith(".md") ||
    path === "mcpb/manifest.json" ||
    path === "server.json" ||
    CLI_TS_RE.test(path)
  );
}

function listScannedFiles() {
  const files = new Set(listTrackedCandidates().filter(isScannedPath));
  return [...files].filter((rel) => existsSync(resolve(ROOT, rel))).sort();
}

// Case-insensitive so a lower-cased `the-998` cannot evade the gate — but `The-40-Thieves` (the
// GitHub org, appearing in nearly every link in this repo) case-insensitively matches the SAME
// shape (THE-<digits>), so the negative lookahead excludes exactly that one org-name pattern and
// no other. A real ticket id happening to be followed by literal "-Thieves" is not a real risk.
const TICKET_RE = /\bTHE-\d+\b(?!-Thieves)/gi;
const LINEAR_URL_RE = /linear\.app/gi;

/**
 * Pure: keep only the characters of string literals ('…', "…", `…`), blanking everything else
 * (code, comments, identifiers) to spaces. Newlines are kept so line numbers still line up. A
 * `//` or `/* *\/` inside a string is string text, not a comment. Not a full TypeScript lexer:
 * a regex literal containing a quote character is read as a string up to the end of its line.
 */
export function stringLiteralsOnly(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < source.length) {
        out += "  ";
        i += 2;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\n" && c !== "`") break;
        if (source[i] === "\\" && i + 1 < source.length) {
          out += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        out += source[i];
        i++;
      }
      if (i < source.length && source[i] === c) {
        out += c;
        i++;
      }
    } else {
      out += c === "\n" ? "\n" : " ";
      i++;
    }
  }
  return out;
}

/**
 * Pure: scan already-loaded {path, content} pairs and return every violation as
 * {path, line, match, text}. No filesystem or git involved, so this is directly unit-testable —
 * mirrors check-mcp-name.mjs's mcpNameProblems shape. Files already covered by the allowlist are
 * skipped entirely rather than filtered per-match, so a legitimately internal document is never
 * partially flagged. CLI sources are scanned through stringLiteralsOnly, so only printed text
 * counts; their code comments are out of scope.
 */
export function findPublicTextViolations(fileContents) {
  const violations = [];
  for (const { path, content } of fileContents) {
    if (isAllowlisted(path)) continue;
    const originalLines = content.split("\n");
    const scanned = CLI_TS_RE.test(path) ? stringLiteralsOnly(content) : content;
    scanned.split("\n").forEach((line, i) => {
      const matches = [...(line.match(TICKET_RE) || []), ...(line.match(LINEAR_URL_RE) || [])];
      for (const match of matches) {
        violations.push({ path, line: i + 1, match, text: originalLines[i].trim() });
      }
    });
  }
  return violations;
}

// Floor: a broken pathspec/enumeration must fail loudly, not silently scan nothing. 254 files are
// in scope as of this writing (every tracked .md except CHANGELOG.md and changes/, plus
// mcpb/manifest.json, server.json and the 72 CLI .ts sources; more of any of these only raises this
// count). The floor sits a little below that so ordinary deletions do not trip it.
const MIN_EXPECTED_FILES = 240;

function main() {
  const files = listScannedFiles();
  if (files.length < MIN_EXPECTED_FILES) {
    console.error(
      `check-public-text: FAIL — only ${files.length} file(s) matched the scan set (expected ` +
        `>= ${MIN_EXPECTED_FILES}). This almost certainly means the enumeration is broken, not ` +
        "that the public docs surface shrank that far.",
    );
    process.exit(1);
  }

  const fileContents = files.map((path) => ({
    path,
    content: readFileSync(resolve(ROOT, path), "utf8"),
  }));

  const violations = findPublicTextViolations(fileContents);

  if (violations.length > 0) {
    console.error(`check-public-text: FAIL — ${violations.length} finding(s):`);
    for (const v of violations) {
      console.error(`  ${v.path}:${v.line}: "${v.match}" — ${v.text}`);
    }
    console.error(
      "\nLinear ticket ids and linear.app URLs are internal — obsidian-tc is a public repo. " +
        "Replace with a plain description of the behaviour, or a CHANGELOG.md anchor link if " +
        "provenance (which release it shipped in) genuinely matters.",
    );
    process.exit(1);
  }

  console.log(`check-public-text: OK — ${files.length} file(s) scanned, 0 findings.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
