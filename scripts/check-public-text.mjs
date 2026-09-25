#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// check-public-text — obsidian-tc is a public repo (The-40-Thieves org). A bare Linear ticket id
// (THE-<digits>) or a linear.app URL leaking into user-facing text exposes the private planning
// plane on the public one, and the link is dead for anyone outside that workspace anyway. This
// scans the surfaces a reader actually lands on — the root README, the public docs site content,
// the top-level package READMEs, and the two MCP manifests — for either shape and fails naming
// the file and line. Where a Linear id documented *provenance* (which release something shipped
// in), the fix is a CHANGELOG.md anchor link instead — CHANGELOG.md is itself allowlisted below,
// since release history legitimately cites tickets and is not the same surface as a user guide.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// "packages/*/README.md" means one level deep — the top-level package READMEs a reader actually
// browses to (packages/plugin, packages/native, ...) — not every README anywhere under packages/.
// git's own pathspec `*` crosses `/` (see check-comment-style.mjs), which would also sweep in
// packages/server/eval/README.md and packages/server/scripts/docgen/README.md: contributor/
// operator instructions for the private eval harness and dev tooling, a different audience and
// out of this gate's scope. Enumerated with readdirSync instead of a git pathspec for that reason.
function listPackageReadmes() {
  const packagesDir = resolve(ROOT, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `packages/${e.name}/README.md`)
    .filter((rel) => existsSync(resolve(ROOT, rel)));
}

// git's pathspec `*` DOES cross `/`, which is exactly what is wanted here — every page under the
// docs-site content collection, at any depth, in one pattern. Same for the published GitHub wiki
// (docs/wiki/*.md, republished by ci-wiki.yml on every merge to main) — it is a reader-facing
// surface, not internal notes, even though it lives under docs/.
function listDocsSitePages() {
  return run("git", ["ls-files", "-z", "docs/src/content/docs/*"]).split("\0").filter(Boolean);
}

function listWikiPages() {
  return run("git", ["ls-files", "-z", "docs/wiki/*.md"]).split("\0").filter(Boolean);
}

function listScannedFiles() {
  const files = new Set([
    "README.md",
    "mcpb/manifest.json",
    "server.json",
    ...listDocsSitePages(),
    ...listWikiPages(),
    ...listPackageReadmes(),
  ]);
  return [...files].filter((rel) => existsSync(resolve(ROOT, rel))).sort();
}

// Genuinely internal or historical documents that are allowed to name a ticket: CHANGELOG.md
// (release history, not a user-facing guide — this is where provenance belongs instead),
// EVALUATION.md (methodology doc that narrates its own history), the superpowers planning tree
// (internal working notes, never the shipped surface), the generated decisions index (it exists
// ONLY to list ticket references), and the pre-ship G2/MCP-COMPATIBILITY design docs. Most of
// these currently fall outside listScannedFiles() above, so for them this allowlist is a
// defensive floor for when the scan set widens — but `roadmap.md` below IS load-bearing today: it
// falls inside the scanned `docs/src/content/docs/*` set and the entry actively suppresses real
// findings, not a hypothetical future one.
const ALLOWLIST_EXACT = new Set([
  "CHANGELOG.md",
  "docs/EVALUATION.md",
  "docs/decisions-index.md",
  // TEMPORARY — docs/src/content/docs/roadmap.md still carries several bare ticket ids and was
  // out of scope for this pass (it was being edited concurrently by a sibling change touching its
  // top section). Remove this entry in the follow-up that cleans that page's ticket references;
  // it is a real gap in this gate until then, called out explicitly rather than silently covered.
  "docs/src/content/docs/roadmap.md",
]);
const ALLOWLIST_PREFIXES = ["docs/superpowers/"];
const ALLOWLIST_GLOBS = [/^docs\/G2[^/]*\.md$/, /^docs\/MCP-[^/]*\.md$/];

function isAllowlisted(path) {
  if (ALLOWLIST_EXACT.has(path)) return true;
  if (ALLOWLIST_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (ALLOWLIST_GLOBS.some((re) => re.test(path))) return true;
  return false;
}

// Case-insensitive so a lower-cased `the-998` cannot evade the gate — but `The-40-Thieves` (the
// GitHub org, appearing in nearly every link in this repo) case-insensitively matches the SAME
// shape (THE-<digits>), so the negative lookahead excludes exactly that one org-name pattern and
// no other. A real ticket id happening to be followed by literal "-Thieves" is not a real risk.
const TICKET_RE = /\bTHE-\d+\b(?!-Thieves)/gi;
const LINEAR_URL_RE = /linear\.app/gi;

/**
 * Pure: scan already-loaded {path, content} pairs and return every violation as
 * {path, line, match, text}. No filesystem or git involved, so this is directly unit-testable —
 * mirrors check-mcp-name.mjs's mcpNameProblems shape. Files already covered by the allowlist are
 * skipped entirely rather than filtered per-match, so a legitimately internal document is never
 * partially flagged.
 */
export function findPublicTextViolations(fileContents) {
  const violations = [];
  for (const { path, content } of fileContents) {
    if (isAllowlisted(path)) continue;
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      const matches = [...(line.match(TICKET_RE) || []), ...(line.match(LINEAR_URL_RE) || [])];
      for (const match of matches) {
        violations.push({ path, line: i + 1, match, text: line.trim() });
      }
    });
  }
  return violations;
}

// Floor: a broken pathspec/enumeration must fail loudly, not silently scan nothing. 47 files are
// in scope as of this writing (1 README + 26 docs-site pages + mcpb/manifest.json + server.json +
// 5 top-level package READMEs + 13 wiki pages; more of any of these only raises this count).
const MIN_EXPECTED_FILES = 42;

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
