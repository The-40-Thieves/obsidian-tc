#!/usr/bin/env node
/**
 * THE-598 — config-path existence gate (source-scan regression guard).
 *
 * Four config keys (`traceDetail`, `tracesSampleRate`, `tracesDays`, `morgianaEventsDays`) were
 * deliberately deleted from `packages/shared/src/config.schema.ts` because nothing read them —
 * the schema has no `.strict()`, so Zod silently strips unknown keys, meaning a config that still
 * sets them validates cleanly and does nothing. Docs kept describing them as live across five
 * files. This gate closes the class: every backticked DOTTED path (`a.b.c`) mentioned in narrative
 * prose — including inside a fenced ```json/```yaml config example — must resolve against the
 * REAL schema, so a doc cannot silently drift back onto a key that does not exist.
 *
 * Ground truth, not hand-maintained: `docs/wiki/Configuration.md`'s generated reference table
 * (`BEGIN GENERATED: config` .. `END GENERATED: config`) is rebuilt from
 * `packages/shared/src/config.schema.ts` by `bun run docgen:render` (`ci-docgen.yml` already fails
 * the build if it is stale). Parsing that table — rather than re-implementing Zod introspection in
 * a plain-node script — means this gate is automatically current with the schema and needs no
 * bun/TypeScript runtime, matching this repo's other `check:*` source-scan gates.
 *
 * CANDIDATE DEFINITION (the false-positive problem). A huge number of backticked dotted-looking
 * strings in this repo are NOT config paths: `packages/server/src`, `node:sqlite`,
 * `obsidian-tc.config.json`, `d.help`, `Array.prototype.map`, a bare version number, a filename
 * (`config.schema.ts`, `server.json`, `render.ts`). A gate that flags those is unusable. So a
 * candidate must pass TWO independent filters:
 *
 *   1. SHAPE: the ENTIRE backtick span (not a substring) is a chain of 2+ plain identifier
 *      segments (`[A-Za-z][A-Za-z0-9]*`, each optionally suffixed `[]` for an array field),
 *      joined by dots, with nothing else in the span (no colons, spaces, hyphens, slashes). This
 *      alone kills filenames with extensions containing a hyphen (`obsidian-tc.config.json`),
 *      protocol-prefixed names (`node:sqlite`), paths (`packages/server/src`), version numbers
 *      (a leading digit fails "starts with a letter"), and any span that embeds a value
 *      (`` `retention.morgiana_events_days: 90` `` has a colon+space, so it does not match at all —
 *      which also means EXPLANATORY prose like "a `foo.bar` key was removed" only trips this gate
 *      when `foo.bar` is quoted bare, not when it carries `: <value>`).
 *   2. ANCHOR: the candidate's first segment must be a segment name that appears SOMEWHERE in the
 *      real schema (derived from the generated table, never hardcoded) — this is what excludes
 *      `config.schema.ts` (no schema segment is named "config"), `attrs.ts`, `server.json`,
 *      `package.json`, `manifest.json`, `Array.prototype.map` (case-sensitive; no segment "Array"),
 *      and `d.help`.
 *
 * A candidate that clears both filters must then be a contiguous, in-order run of the real
 * schema's segments (e.g. `otel.endpoint` is valid as a suffix of `observability.otel.endpoint`,
 * matching the abbreviated style this repo's own docs already use once inside an `## observability`
 * section) — anything else is a genuine violation.
 *
 * Floors, both a hard failure rather than a silent pass (this repo's established convention,
 * check-dev-dep-imports.mjs / check-perf-timing-scope.mjs): a broken generated-table parse (zero
 * valid paths) or a broken file glob (zero files scanned) must FAIL, not read as a clean sweep.
 *
 * Escape hatches (mirroring docgen/facts-check.ts's `facts-check:ignore` convention):
 *   <!-- config-path:ignore -->       on a line, to skip just that line
 *   <!-- config-path:ignore-file -->  anywhere in a file, to skip the whole file
 * plus a narrow ALLOWLIST below for a genuine collision (anchor-filter false positive) that no
 * amount of shape-tightening can resolve.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG_DOC = resolve(ROOT, "docs/wiki/Configuration.md");

const IGNORE_LINE = "config-path:ignore";
const IGNORE_FILE = "config-path:ignore-file";

// A dotted candidate that clears the shape+anchor filters below but is a KNOWN non-config
// collision, keyed by the exact backtick contents. Both entries are SQLite filenames whose first
// "segment" happens to collide with a real schema segment name purely by coincidence:
// `experiential` is itself a real top-level config key (experiential.logRetrievals, ...), and
// `cache` is a real nested segment (retrieval.cache.enabled, ...) — but neither schema location has
// a child named `db`, so "the file `cache.db`" and "the file `experiential.db`" read exactly like a
// two-segment config path to the shape+anchor filters. Confirmed by dry run against the full tree
// (see this gate's PR description for the false-positive-rate report) — no other collision exists.
const ALLOWLIST = new Set(["cache.db", "experiential.db"]);

// ---- 1. Ground truth: parse the generated config reference table -----------------------------

function extractValidPaths() {
  const text = readFileSync(CONFIG_DOC, "utf8");
  const start = text.indexOf("<!-- BEGIN GENERATED: config -->");
  const end = text.indexOf("<!-- END GENERATED: config -->");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `could not find the "BEGIN/END GENERATED: config" markers in ${CONFIG_DOC} — has the ` +
        "generated-reference section been renamed or removed? This gate has no ground truth without it.",
    );
  }
  const block = text.slice(start, end);
  const paths = [];
  const recordPaths = [];
  // Table rows look like: | `acl.rules[].scopes` | `array<string>` | `[]` |  | ... |
  const ROW = /^\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|/gm;
  for (const m of block.matchAll(ROW)) {
    paths.push(m[1]);
    // A `record` leaf (e.g. observability.otel.headers, plur config's apiPrefix's siblings) is
    // `z.record(string, string)`: the schema itself declares its keys are caller-chosen, so ANY
    // sub-key beneath it (an HTTP header name like "Authorization") is legitimate and not itself
    // part of the schema — do not require it to resolve.
    if (m[2] === "record") recordPaths.push(m[1]);
  }
  return { paths, recordPaths };
}

function segmentsOf(path) {
  // Strip the array marker so `vaults[].bridges.timeoutMs` and a prose reference that dropped the
  // brackets (`vaults.bridges.timeoutMs`) both resolve to the same segment chain.
  return path.replace(/\[\]/g, "").split(".").filter(Boolean);
}

const { paths: validPaths, recordPaths } = extractValidPaths();
const recordSegmentPrefixes = recordPaths.map((p) => segmentsOf(p));
const MIN_EXPECTED_PATHS = 100; // the real table carries ~160 rows; a broken parse looks nothing like this
if (validPaths.length < MIN_EXPECTED_PATHS) {
  console.error(
    `config-paths gate: only parsed ${validPaths.length} row(s) out of the generated config table ` +
      `(expected >= ${MIN_EXPECTED_PATHS}). This almost certainly means the table format changed or ` +
      "docgen:render is stale. Refusing to pass a check that saw (near-)nothing.",
  );
  process.exit(1);
}

// firstSegments anchors the INLINE single-backtick scan (§4): this repo's own docs already
// abbreviate a path to a suffix once a heading provides the section context (e.g. `otel.endpoint`
// under an "## observability" heading), so any segment appearing anywhere in the schema is a
// legitimate start. topLevelKeys is the stricter set used by looksLikeConfigDoc (§3) to decide
// whether a fenced JSON/YAML block IS a config example at all — a single shared field name like
// `id` (real at `vaults[].id`) is too weak a signal there and would misclassify an unrelated
// JSON-RPC envelope `{jsonrpc, id, method, params}` as a config document.
const firstSegments = new Set();
const topLevelKeys = new Set();
const validJoined = new Set();
for (const p of validPaths) {
  const segs = segmentsOf(p);
  topLevelKeys.add(segs[0]);
  for (let i = 0; i < segs.length; i++) {
    firstSegments.add(segs[i]);
    for (let j = i; j < segs.length; j++) {
      validJoined.add(segs.slice(i, j + 1).join("."));
    }
  }
}

// ---- 2. Candidate shapes -----------------------------------------------------------------------

// A whole backtick span: 2+ bare identifier segments (each optionally array-suffixed), dots only.
const DOTTED = /^[A-Za-z][A-Za-z0-9]*(?:\[\])?(?:\.[A-Za-z][A-Za-z0-9]*(?:\[\])?){1,}$/;
const BACKTICK_SPAN = /`([^`\n]+)`/g;

/** True if `segs` starts with a (possibly abbreviated, suffix-of) known `record`-typed leaf —
 *  the schema itself says the keys beneath that point are caller-chosen (e.g. an HTTP header name
 *  under `observability.otel.headers`), so nothing past it is checkable. Suffix-tolerant for the
 *  same reason `validJoined` is: prose may drop a leading section qualifier a heading implies. */
function isUnderRecordLeaf(segs) {
  return recordSegmentPrefixes.some((prefix) =>
    // Try every suffix of the record path (full path, then dropping leading segments one at a
    // time) as the required prefix of the candidate.
    prefix.some(
      (_, k) => segs.length > prefix.length - k && prefix.slice(k).every((s, i) => segs[i] === s),
    ),
  );
}

/** Is `candidate` a real (possibly abbreviated) config path? */
function isValidCandidate(candidate) {
  if (ALLOWLIST.has(candidate)) return true;
  const segs = segmentsOf(candidate);
  if (validJoined.has(segs.join("."))) return true;
  return isUnderRecordLeaf(segs);
}

/** Scan one file's already-known-narrative text. `out.violations` gets every candidate that does
 *  NOT resolve; `out.candidates` counts every anchored dotted-path candidate seen (valid or not),
 *  independent of the fenced-block flattener below, for the "did the scan run" floor. */
function scanNarrative(text) {
  const stats = { violations: [], candidates: 0 };
  if (text.includes(IGNORE_FILE)) return stats;
  const lines = text.split("\n");
  const out = stats.violations;
  let inFence = false;
  let fenceLang = "";
  let fenceStart = -1;
  let fenceBuf = [];
  let inGenerated = false;

  const flushFence = () => {
    // A `# config-path:ignore` (or HTML `<!-- config-path:ignore -->`) comment ANYWHERE inside the
    // fence opts the whole block out — for a design-era example (e.g. a G2.2/G2.3 proposal that
    // predates the shipped schema) that is not this gate's business to adjudicate line-by-line.
    if (fenceBuf.some((l) => l.includes(IGNORE_LINE))) {
      fenceBuf = [];
      return;
    }
    if (fenceLang === "json" || fenceLang === "jsonc") {
      checkJsonFence(fenceBuf.join("\n"), fenceStart, out);
    } else if (fenceLang === "yaml" || fenceLang === "yml") {
      checkYamlFence(fenceBuf, fenceStart, out);
    }
    fenceBuf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s*```\s*([A-Za-z]*)/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = fenceMatch[1].toLowerCase();
        fenceStart = i + 1;
        fenceBuf = [];
      } else {
        flushFence();
        inFence = false;
        fenceLang = "";
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      continue;
    }
    if (line.includes("<!-- BEGIN GENERATED:")) {
      inGenerated = true;
      continue;
    }
    if (line.includes("<!-- END GENERATED:")) {
      inGenerated = false;
      continue;
    }
    if (inGenerated) continue;
    if (line.includes(IGNORE_LINE)) continue;

    for (const m of line.matchAll(BACKTICK_SPAN)) {
      const candidate = m[1];
      if (!DOTTED.test(candidate)) continue;
      const first = segmentsOf(candidate)[0];
      if (!firstSegments.has(first)) continue; // anchor filter
      stats.candidates++;
      if (isValidCandidate(candidate)) continue;
      out.push({ line: i + 1, candidate });
    }
  }
  return stats;
}

// ---- 3. Fenced-block flattening (json/yaml config examples) ------------------------------------

// A "looks like a config document" gate for a parsed object: at least one of its top-level keys
// must be a real ServerConfigSchema top-level key (itself a member of firstSegments, since every
// top-level key is segment [0] of some real path). This is what lets the CloudEvents `data shape`
// jsonc example (vault_id/tool/caller_hash/...) through untouched — none of its keys are a real
// top-level config key — while still catching a `"observability": { "traceDetail": ... }` example.
function looksLikeConfigDoc(keys) {
  return keys.some((k) => topLevelKeys.has(k));
}

function flattenObject(obj, prefix, out) {
  if (Array.isArray(obj) || obj === null || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flattenObject(value, path, out);
    } else {
      out.push(path);
    }
  }
}

function checkJsonFence(rawBlock, startLine, out) {
  // Strip `// comment` line-endings so a ```jsonc block (used for the CloudEvents examples) still
  // parses with plain JSON.parse; block comments are not used anywhere in these fences.
  const stripped = rawBlock
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n")
    // Trailing commas before a closing brace/bracket appear in a couple of hand-written examples.
    .replace(/,(\s*[}\]])/g, "$1");
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return; // not parseable JSON -- not a candidate for this check, not a violation either
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const topKeys = Object.keys(parsed);
  if (!looksLikeConfigDoc(topKeys)) return;
  const flat = [];
  flattenObject(parsed, "", flat);
  for (const path of flat) {
    if (!DOTTED.test(path.replace(/\[\d*\]/g, "[]"))) continue;
    if (isValidCandidate(path)) continue;
    out.push({ line: startLine, candidate: path });
  }
}

// Minimal indentation-based YAML object flattener — sufficient for this repo's config examples,
// which are plain nested `key:` / `key: value` maps with 2-space indents and no lists-of-objects.
function checkYamlFence(rawLines, startLine, out) {
  const stack = []; // [{indent, key}]
  const topKeys = [];
  for (const raw of rawLines) {
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) continue; // a list item, a bare scalar continuation, etc. -- not this gate's shape
    const indent = m[1].length;
    const key = m[2];
    const value = m[3].trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length === 0) topKeys.push(key);
    if (value === "" || value === "{}") {
      stack.push({ indent, key });
    }
  }
  if (!looksLikeConfigDoc(topKeys)) return;
  // Re-walk to emit every leaf path now that we know this block is in scope.
  const stack2 = [];
  for (const raw of rawLines) {
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2];
    const value = m[3].trim();
    while (stack2.length && stack2[stack2.length - 1].indent >= indent) stack2.pop();
    const path = [...stack2.map((s) => s.key), key].join(".");
    if (value === "" || value === "{}") {
      stack2.push({ indent, key });
      continue;
    }
    if (!DOTTED.test(path)) continue;
    if (isValidCandidate(path)) continue;
    out.push({ line: startLine, candidate: path });
  }
}

// ---- 4. File scope -------------------------------------------------------------------------------

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function narrativeFiles() {
  const explicit = [
    "README.md",
    "ARCHITECTURE.md",
    "packages/server/README.md",
    "docs/G2.1-tools.md",
    "docs/G2.2-architecture.md",
    "docs/G2.3-storage.md",
    "docs/G2.4-observability.md",
    "docs/G2.4-security.md",
    "docs/G2.5-release-engineering.md",
    "docs/WHY.md",
    "docs/QUICKSTART.md",
  ];
  const tracked = run("git", ["ls-files", "docs/wiki", "docs/src/content"])
    .split("\n")
    .filter((f) => /\.(md|mdx)$/i.test(f));
  return [...new Set([...explicit, ...tracked])];
}

// ---- 5. Main ---------------------------------------------------------------------------------

const files = narrativeFiles();
const MIN_EXPECTED_FILES = 40;
if (files.length < MIN_EXPECTED_FILES) {
  console.error(
    `config-paths gate: only ${files.length} narrative file(s) matched (expected >= ${MIN_EXPECTED_FILES}).\n` +
      "This almost certainly means the file-list glob broke. Refusing to pass a check that scanned (near-)nothing.",
  );
  process.exit(1);
}

let candidateCount = 0;
const violations = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, file), "utf8");
  } catch {
    continue;
  }
  const { violations: found, candidates } = scanNarrative(text);
  candidateCount += candidates;
  for (const v of found) violations.push({ file, ...v });
}

const MIN_EXPECTED_CANDIDATES = 20;
if (candidateCount < MIN_EXPECTED_CANDIDATES) {
  console.error(
    `config-paths gate: only ${candidateCount} anchored dotted-path candidate(s) found across ` +
      `${files.length} files (expected >= ${MIN_EXPECTED_CANDIDATES}). A real sweep of this many ` +
      "docs should find far more legitimate references (auth.mode, retrieval.rrfK, ...); this " +
      "looks like the candidate regex broke, not a clean tree.",
  );
  process.exit(1);
}

console.log(
  `config-paths gate: ${files.length} file(s) scanned, ${validPaths.length} known schema paths, ` +
    `${candidateCount} candidate(s) checked, ${violations.length} violation(s)`,
);
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}  \`${v.candidate}\` does not resolve in ServerConfigSchema`);
}

if (violations.length > 0) {
  console.error(
    "\nconfig-paths gate: a narrative doc references a config path that does not exist in " +
      "packages/shared/src/config.schema.ts. The schema has no .strict(), so a config setting a " +
      "dead key like this validates cleanly and silently does nothing (THE-598). Fix the doc, or " +
      "if this really is a deliberate historical/design mention, mark the line " +
      `<!-- ${IGNORE_LINE} --> (or the file <!-- ${IGNORE_FILE} -->).`,
  );
  process.exit(1);
}

process.exit(0);
