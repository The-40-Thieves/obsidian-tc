#!/usr/bin/env node
/**
 * docs/decisions-index.md generator.
 *
 * The comment-style policy (CONTRIBUTING.md "Inline commentary") allows a bare `THE-xxx` ticket
 * suffix in source comments, on the premise that this index resolves it for a reader without
 * access to the private Linear tracker those ids point into. That premise only holds if the index
 * itself cannot drift, so it is generated and drift-gated the same way TREE.md's dependency graph
 * is (`scripts/gen-tree-map.mjs`) — no committed table is trusted here, one is produced from the
 * repo on every run and compared byte-for-byte in `--check` mode.
 *
 * For each distinct THE-xxx cited under packages/*\/src, the best available PUBLIC one-liner is
 * picked in order:
 *   1. The bold summary of the CHANGELOG.md release-note bullet that cites it — CHANGELOG is
 *      public and its bullets already are the "public one-liner" this index needs, written once by
 *      a human rather than mined a second time.
 *   2. Failing that, the title of the first docs/adr/, docs/design/, or docs/superpowers/specs/
 *      file that mentions it, in that search order.
 *   3. Failing both, an explicit internal-reference placeholder — never a guess, never empty.
 *
 * Unlike TREE.md this file has no hand-written prose to preserve, so it is regenerated whole
 * rather than injected into marker regions.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const OUTPUT = "docs/decisions-index.md";
export const DOC_DIRS = ["docs/adr", "docs/design", "docs/superpowers/specs"];
export const FALLBACK_SUMMARY = "_internal planning reference — see repo history_";
export const FALLBACK_LOCATION = "—";
const TICKET_RE = /\bTHE-(\d+)\b/g;

/** Distinct THE-xxx numbers cited in a string, as strings (e.g. "891"). */
export function ticketsIn(text) {
  return new Set([...text.matchAll(TICKET_RE)].map((m) => m[1]));
}

/**
 * CHANGELOG.md -> [{ version, ticketNums: Set<string>, block: string }], one entry per top-level
 * bullet. Top-level bullets start at column 0 (`- `); nested sub-bullets are indented and are
 * folded into their parent's block rather than treated as separate entries — matching how this
 * file's bullets are actually authored (see CHANGELOG.md's THE-891 entries for the nested shape).
 * `version` is the bracket text of the most recent `## [...]` heading seen (e.g. "Unreleased",
 * "1.23.0"), or null for a bullet appearing before any release heading.
 */
export function parseChangelogEntries(text) {
  const lines = text.split("\n");
  const entries = [];
  let version = null;
  let block = null;

  const flush = () => {
    if (block !== null) entries.push({ version, ticketNums: ticketsIn(block), block });
    block = null;
  };

  for (const line of lines) {
    const heading = /^## \[(.+?)\]/.exec(line);
    if (heading) {
      flush();
      version = heading[1];
      continue;
    }
    if (/^# /.test(line)) {
      flush();
      continue;
    }
    if (/^- /.test(line)) {
      flush();
      block = line;
      continue;
    }
    if (block !== null) block += ` ${line.trim()}`;
  }
  flush();
  return entries;
}

/** First `**...**` span in a CHANGELOG bullet block, whitespace-collapsed. Null if none. */
export function boldSummaryOf(block) {
  const m = /\*\*(.+?)\*\*/s.exec(block);
  if (!m) return null;
  return m[1].replace(/\s+/g, " ").trim();
}

/** First `# heading` line of a markdown doc's text, trimmed. Falls back to the path if none. */
export function extractTitle(text, fallbackPath) {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1].trim() : fallbackPath;
}

/** Escapes a string for embedding in a single markdown table cell. Backslashes first, so an
 *  input backslash cannot resurrect a pipe the second replace already escaped (CodeQL
 *  js/incomplete-sanitization). */
export function cell(s) {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Ticket rows -> the full markdown document. Pure function of already-resolved data, so tests can
 * check formatting without touching the filesystem or CHANGELOG parsing.
 */
export function renderDocument(rows, sourceFileCount) {
  const table = [
    "| Ticket | Summary | Where the substance lives | Referencing files |",
    "|---|---|---|---:|",
    ...rows.map((r) => `| ${r.ticket} | ${cell(r.summary)} | ${cell(r.location)} | ${r.count} |`),
  ].join("\n");

  const resolvedCount = rows.filter((r) => r.summary !== FALLBACK_SUMMARY).length;

  return `# Decisions index

This project tracks day-to-day planning work in Linear, a private issue tracker — source comments
and CHANGELOG entries routinely cite a \`THE-xxx\` ticket id as shorthand for "the discussion that
produced this." Those ids are not resolvable outside the maintainer team, which would otherwise
leave every outside contributor who hits one at a dead end. This index closes that gap: for every
\`THE-xxx\` cited under \`packages/*/src\`, it resolves the ticket to the best PUBLIC summary this
repo already has — the CHANGELOG entry that shipped it, or the design/ADR/spec doc that discusses
it — so the repository stays self-contained without anyone needing tracker access.

This file is **generated** — do not hand-edit it. Regenerate with \`bun run docs:decisions-index\`;
\`bun run docs:decisions-index:check\` fails if the committed table has drifted from the source
tree, and runs as part of the docs drift gate in CI.

${table}

${rows.length} distinct ticket(s) across ${sourceFileCount} source file(s) under
\`packages/*/src\`; ${resolvedCount} resolved to a public summary, ${rows.length - resolvedCount}
fall back to the internal-reference placeholder above.
`;
}

function listMarkdown(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return []; // directory does not exist yet (e.g. docs/design/ before its first extraction)
  }
}

function main() {
  const CHECK = process.argv.includes("--check");
  const run = (cmd, args) =>
    execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  // ── 1. distinct tickets + referencing files, from tracked packages/*/src sources ─────────────
  // git ls-files (not a filesystem walk) so gitignored/build output can never contribute a ticket
  // that then has no source justifying it; dist/ is excluded explicitly since a built package can
  // carry copied comments through into its output.
  const sourceFiles = run("git", ["ls-files", "packages/*/src", "packages/*/src/**"])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("/dist/"));

  if (sourceFiles.length === 0) {
    console.error(
      "gen-decisions-index: git ls-files matched no packages/*/src sources — refusing to " +
        "generate from nothing",
    );
    process.exit(1);
  }

  const ticketFiles = new Map(); // ticket number (string) -> Set of referencing file paths
  for (const file of sourceFiles) {
    const text = readFileSync(file, "utf8");
    for (const num of ticketsIn(text)) {
      if (!ticketFiles.has(num)) ticketFiles.set(num, new Set());
      ticketFiles.get(num).add(file);
    }
  }

  if (ticketFiles.size === 0) {
    console.error(
      `gen-decisions-index: found 0 THE-xxx references across ${sourceFiles.length} source ` +
        "file(s) — refusing to emit an empty index",
    );
    process.exit(1);
  }

  // ── 2. CHANGELOG.md: bold summary of the first bullet that cites a ticket ─────────────────────
  const changelogEntries = parseChangelogEntries(readFileSync("CHANGELOG.md", "utf8"));
  const fromChangelog = new Map(); // ticket number -> { summary, location }
  for (const entry of changelogEntries) {
    for (const num of entry.ticketNums) {
      if (fromChangelog.has(num)) continue;
      const summary = boldSummaryOf(entry.block);
      if (!summary) continue;
      fromChangelog.set(num, {
        summary,
        location: `CHANGELOG.md (${entry.version ?? "unreleased"})`,
      });
    }
  }

  // ── 3. doc fallback: docs/adr, docs/design, docs/superpowers/specs, in that search order ──────
  const docsByDir = DOC_DIRS.map((dir) => ({
    dir,
    files: listMarkdown(dir).map((path) => ({ path, text: readFileSync(path, "utf8") })),
  }));
  const fromDocs = (num) => {
    const re = new RegExp(`\\bTHE-${num}\\b`);
    for (const { files } of docsByDir) {
      for (const { path, text } of files) {
        if (re.test(text)) return { summary: extractTitle(text, path), location: path };
      }
    }
    return null;
  };

  // ── 4. assemble + write ────────────────────────────────────────────────────────────────────
  const rows = [...ticketFiles.keys()]
    .sort((a, b) => Number(a) - Number(b))
    .map((num) => {
      const resolved = fromChangelog.get(num) ??
        fromDocs(num) ?? { summary: FALLBACK_SUMMARY, location: FALLBACK_LOCATION };
      return {
        ticket: `THE-${num}`,
        summary: resolved.summary,
        location: resolved.location,
        count: ticketFiles.get(num).size,
      };
    });

  const content = renderDocument(rows, sourceFiles.length);
  const before = (() => {
    try {
      return readFileSync(OUTPUT, "utf8");
    } catch {
      return null;
    }
  })();

  if (before === content) {
    console.log(`gen-decisions-index: up to date (${rows.length} tickets)`);
    process.exit(0);
  }
  if (CHECK) {
    console.error(`gen-decisions-index: ${OUTPUT} is STALE — run \`bun run docs:decisions-index\``);
    process.exit(1);
  }
  writeFileSync(OUTPUT, content);
  console.log(`gen-decisions-index: wrote ${OUTPUT} (${rows.length} tickets)`);
}

// Importing this module (as its test file does, to reach the exported pure functions) must have
// no side effects — no git calls, no filesystem reads, no process.exit. Only run the generator
// when this file is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
