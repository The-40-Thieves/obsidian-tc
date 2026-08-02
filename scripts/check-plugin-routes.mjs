#!/usr/bin/env node
/**
 * THE-703 — companion-plugin route table drift gate.
 *
 * ARCHITECTURE.md §3.1 documents the companion plugin's HTTP surface as a hand-maintained fenced
 * block. On 2026-08-02 it was found 11 routes and 6 families behind the code (`git`,
 * `remotely-save`, `omnisearch`, `datacore`, `metadata-menu`, `daily-notes` were all undocumented),
 * and three routes it DID list carried the wrong verb — `/commands/list`, `/templater/list` and
 * `/quickadd/actions` are documented GET and ship POST, so the block was not merely stale, it was
 * unusable as a client reference. `docs/wiki/FAQ.md` and `Installation.md` were already correct;
 * this was a single-file miss, which is exactly why it survived review.
 *
 * Every other structural fact in this repo is either generated (TREE.md, the config schema, the
 * docgen marker regions) or pinned by a parsed constant (REGISTERED_TOOL_COUNT, read by
 * check-version-coherence.mjs). The route block is prose that happens to look like a spec, and
 * nothing could tell it apart from one. This gate is that difference.
 *
 * Invariant: the set of (METHOD, path) pairs declared as `RouteDef` object literals under
 * packages/plugin/src/routes(.ts|/*.ts) is EXACTLY the set documented in ARCHITECTURE.md §3.1 —
 * same paths, same verbs, no extras on either side.
 *
 * DERIVED on both sides, not a hardcoded list: a sixteenth route family added later is covered
 * automatically rather than silently exempt, and the doc side is re-parsed from the file rather
 * than from a snapshot, so editing the block is the only way to satisfy it.
 *
 * Two floors, per THE-544/THE-585's lesson that a check which can pass by finding nothing is not a
 * check. Zero route files, zero parsed code routes, or a missing/empty fenced block in
 * ARCHITECTURE.md all mean the SCAN broke (a rename, a moved directory, a reworded heading) rather
 * than that the surface shrank to nothing — each exits non-zero with its own message instead of
 * reporting a vacuous success. The doc-side floor is the one that matters most: a regex that
 * silently matches zero lines would otherwise make an empty documented set trivially "equal" to
 * nothing, which is the precise shape of a green check that verified nothing.
 *
 * Comment-aware, but deliberately NOT string-aware: unlike check-ingest-telemetry-wiring.mjs, the
 * values this gate reads ARE string literals (`method: "post"`, `path: "/git/status"`), so blanking
 * them would erase the very thing being scanned. `blankComments` therefore skips over string and
 * template literals verbatim (so a `//` inside "http://…" never opens a comment) and blanks only
 * real comments — which is what stops a commented-out or illustrative route in a doc comment from
 * being counted as shipped.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROUTE_FILE_GLOBS = ["packages/plugin/src/routes.ts", "packages/plugin/src/routes/*.ts"];
const DOC_FILE = "ARCHITECTURE.md";

/** The block is located by this marker rather than by a line number or a section heading, so
 *  reflowing the prose around it does not break the gate. Must match ARCHITECTURE.md §3.1. */
const DOC_BLOCK_MARKER = "**Routes (as shipped";

/** Documented paths carry the mount prefix; the RouteDef literals do not. Stripped before compare,
 *  and a documented line missing it is an error rather than a silent normalization. */
const ROUTE_PREFIX = "/obsidian-tc/v1";

const MIN_EXPECTED_ROUTE_FILES = 2;
const MIN_EXPECTED_CODE_ROUTES = 10;
const MIN_EXPECTED_DOC_ROUTES = 10;

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Blanks `//` line comments and block comments with spaces, byte-offset- and newline-preserving,
 * while copying string and template literals through UNTOUCHED.
 *
 * The asymmetry with check-ingest-telemetry-wiring.mjs's `blankNonCode` is deliberate and is the
 * whole reason this is a separate function: there, string contents are noise to be erased; here
 * they are the payload. Skipping over a literal rather than blanking it also fixes the case that
 * would otherwise break naive comment stripping — a `"http://example"` whose `//` would open a
 * comment that swallows the rest of the line, taking a real `path:` with it.
 *
 * A literal left unterminated at EOF (malformed source) stops at the newline rather than
 * swallowing the file; diagnosing a syntax error is not this gate's job, and failing to parse
 * shows up as a route-count floor violation, which is loud.
 */
export function blankComments(source) {
  const n = source.length;
  const out = new Array(n);
  let i = 0;

  while (i < n) {
    const c = source[i];

    if (c === "/" && source[i + 1] === "/") {
      let j = i;
      while (j < n && source[j] !== "\n") j++;
      for (let k = i; k < j; k++) out[k] = " ";
      i = j;
      continue;
    }

    if (c === "/" && source[i + 1] === "*") {
      const closeAt = source.indexOf("*/", i + 2);
      const end = closeAt === -1 ? n : closeAt + 2;
      for (let k = i; k < end; k++) out[k] = source[k] === "\n" ? "\n" : " ";
      i = end;
      continue;
    }

    // String literal — copied verbatim, escapes respected. A raw newline before the closing quote
    // means it was never valid TS, so stop there rather than treating the rest of the file as one
    // giant string.
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < n && source[j] !== quote && source[j] !== "\n") {
        j += source[j] === "\\" ? 2 : 1;
      }
      if (j < n && source[j] === quote) j++;
      for (let k = i; k < j && k < n; k++) out[k] = source[k];
      i = Math.min(j, n);
      continue;
    }

    // Template literal — copied verbatim. No `${...}` depth tracking is needed here because this
    // function never has to find structure INSIDE the literal, only its end, and a backtick inside
    // an interpolation is rare enough that the failure direction (ending the template early, so
    // some real code is scanned as real code) is harmless for this gate.
    if (c === "`") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "`") {
          j++;
          break;
        }
        j++;
      }
      for (let k = i; k < j && k < n; k++) out[k] = source[k];
      i = Math.min(j, n);
      continue;
    }

    out[i] = c;
    i++;
  }

  return out.join("");
}

/**
 * Extracts (method, path) pairs from `RouteDef` object literals in one already-comment-blanked
 * source.
 *
 * The literals are uniformly shaped `{ method: "post", path: "/git/status", handler: ... }`, so
 * this walks `method:` / `path:` key matches in source order and pairs each `path:` with the
 * `method:` immediately preceding it. That ordering assumption is not left implicit: a `path:` with
 * no pending `method:`, or a second `method:` before its `path:`, is returned as a structured
 * error rather than silently dropped — a route the parser cannot read must fail the gate, never
 * quietly shrink the scanned set (which would let a real drift pass).
 *
 * TYPE positions are excluded by the `|` lookahead: `RouteDef` itself is declared
 * `{ method: "get" | "post"; path: string; ... }` in routes/types.ts, whose `"get"` is a
 * string-literal union member, not a value — and whose `path: string` is unquoted, so it never
 * pairs. The first run of this gate flagged exactly that as a trailing unpaired `method:`, which is
 * the discriminator working: a single-literal annotation (`method: "get";`) would still be reported
 * rather than guessed at, and being told loudly is the correct failure direction for a parser that
 * must not under-count.
 */
export function parseRouteDefs(file, blankedSource) {
  const routes = [];
  const errors = [];
  let pendingMethod = null;

  for (const m of blankedSource.matchAll(/\b(method|path)\s*:\s*"([^"]*)"/g)) {
    const [, key, value] = m;
    const line = blankedSource.slice(0, m.index).split("\n").length;

    if (key === "method") {
      // `method: "get" | "post"` — a type-union member, not a RouteDef value.
      if (/^\s*\|/.test(blankedSource.slice(m.index + m[0].length))) continue;
      if (pendingMethod !== null) {
        errors.push(
          `${file}:${pendingMethod.line}  \`method: "${pendingMethod.value}"\` is followed by ` +
            `another \`method:\` at line ${line} with no \`path:\` between them — this gate pairs ` +
            "each path with the method directly above it, and cannot read that shape.",
        );
      }
      pendingMethod = { value, line };
      continue;
    }

    if (pendingMethod === null) {
      errors.push(
        `${file}:${line}  \`path: "${value}"\` has no \`method:\` before it in the same object ` +
          "literal — this gate cannot determine its verb.",
      );
      continue;
    }

    routes.push({
      file,
      line,
      method: pendingMethod.value.toUpperCase(),
      path: value,
    });
    pendingMethod = null;
  }

  if (pendingMethod !== null) {
    errors.push(
      `${file}:${pendingMethod.line}  trailing \`method: "${pendingMethod.value}"\` with no ` +
        "following `path:`.",
    );
  }

  return { routes, errors };
}

/**
 * Extracts the documented (method, path) pairs from ARCHITECTURE.md's §3.1 fenced block.
 *
 * Locating the block by marker then by the NEXT two fences is load-bearing: the obvious
 * `sed '/marker/,/```/'` range terminates on the block's own OPENING fence and yields nothing,
 * which during development of this gate produced a comparison of 28 code routes against 0
 * documented ones that looked, at a glance, like a legitimate diff. Every failure to locate the
 * block is therefore returned as an explicit error, never as an empty set.
 */
export function parseDocRoutes(docSource) {
  const markerAt = docSource.indexOf(DOC_BLOCK_MARKER);
  if (markerAt === -1) {
    return {
      routes: [],
      errors: [
        `${DOC_FILE}: could not find the route-block marker ${JSON.stringify(DOC_BLOCK_MARKER)}. ` +
          "The block was renamed or removed — this gate has nothing to compare against and will " +
          "not report success over it.",
      ],
    };
  }

  const openFence = docSource.indexOf("```", markerAt);
  if (openFence === -1) {
    return {
      routes: [],
      errors: [`${DOC_FILE}: route-block marker found but no opening \`\`\` fence follows it.`],
    };
  }
  const closeFence = docSource.indexOf("```", openFence + 3);
  if (closeFence === -1) {
    return {
      routes: [],
      errors: [`${DOC_FILE}: route block's opening fence is never closed.`],
    };
  }

  const block = docSource.slice(openFence + 3, closeFence);
  const routes = [];
  const errors = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    const m = line.match(/^([A-Z]+)\s+(\S+)/);
    if (!m) {
      errors.push(
        `${DOC_FILE}: unparseable line in the route block: ${JSON.stringify(line)} — expected ` +
          "`METHOD /obsidian-tc/v1/... → description`.",
      );
      continue;
    }

    const [, method, docPath] = m;
    if (!docPath.startsWith(ROUTE_PREFIX)) {
      errors.push(
        `${DOC_FILE}: documented route ${method} ${docPath} does not start with the mount prefix ` +
          `${ROUTE_PREFIX}.`,
      );
      continue;
    }

    routes.push({ method, path: docPath.slice(ROUTE_PREFIX.length) });
  }

  return { routes, errors };
}

/** Stable "METHOD path" key, so both sides sort and compare identically regardless of file order. */
export function routeKey(route) {
  return `${route.method} ${route.path}`;
}

/** Set difference in both directions plus duplicate detection, as sorted key lists. */
export function diffRoutes(codeRoutes, docRoutes) {
  const codeKeys = codeRoutes.map(routeKey);
  const docKeys = docRoutes.map(routeKey);
  const codeSet = new Set(codeKeys);
  const docSet = new Set(docKeys);

  const dupe = (keys) => [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))].sort();

  return {
    undocumented: [...codeSet].filter((k) => !docSet.has(k)).sort(),
    phantom: [...docSet].filter((k) => !codeSet.has(k)).sort(),
    duplicateInCode: dupe(codeKeys),
    duplicateInDoc: dupe(docKeys),
  };
}

function main() {
  const files = run("git", ["ls-files", ...ROUTE_FILE_GLOBS])
    .split("\n")
    .filter(Boolean)
    // git ls-files already prints '/'-separated paths on every OS including windows-latest, where
    // the lint job also runs; this documents that invariant rather than fixing an observed case.
    .map((f) => f.replaceAll("\\", "/"));

  if (files.length < MIN_EXPECTED_ROUTE_FILES) {
    console.error(
      `plugin-routes gate: git ls-files matched ${files.length} file(s) under ` +
        `packages/plugin/src/routes (expected >= ${MIN_EXPECTED_ROUTE_FILES}). The routes ` +
        "directory was moved or renamed — refusing to report success over a check that examined " +
        "nothing.",
    );
    process.exit(1);
  }

  const codeRoutes = [];
  const parseErrors = [];
  for (const file of files) {
    const { routes, errors } = parseRouteDefs(file, blankComments(readFileSync(file, "utf8")));
    codeRoutes.push(...routes);
    parseErrors.push(...errors);
  }

  const docSource = readFileSync(DOC_FILE, "utf8");
  const { routes: docRoutes, errors: docErrors } = parseDocRoutes(docSource);
  parseErrors.push(...docErrors);

  if (codeRoutes.length < MIN_EXPECTED_CODE_ROUTES) {
    console.error(
      `plugin-routes gate: parsed ${codeRoutes.length} RouteDef literal(s) from ${files.length} ` +
        `file(s) (expected >= ${MIN_EXPECTED_CODE_ROUTES}). The RouteDef shape changed — refusing ` +
        "to compare a set the parser could not read.",
    );
    process.exit(1);
  }
  if (docRoutes.length < MIN_EXPECTED_DOC_ROUTES) {
    console.error(
      `plugin-routes gate: parsed ${docRoutes.length} route(s) from ${DOC_FILE} §3.1 (expected ` +
        `>= ${MIN_EXPECTED_DOC_ROUTES}). An empty documented set would compare "equal" to nothing ` +
        "and pass vacuously — failing instead.",
    );
    process.exit(1);
  }

  console.log(
    `plugin-routes gate: ${files.length} route file(s) scanned, ${codeRoutes.length} RouteDef ` +
      `literal(s), ${docRoutes.length} route(s) documented in ${DOC_FILE} §3.1`,
  );

  const { undocumented, phantom, duplicateInCode, duplicateInDoc } = diffRoutes(
    codeRoutes,
    docRoutes,
  );

  const violations = [...parseErrors];

  for (const key of undocumented) {
    const site = codeRoutes.find((r) => routeKey(r) === key);
    violations.push(
      `${site.file}:${site.line}  ${key} is registered but absent from ${DOC_FILE} §3.1 (a ` +
        "route, or a route whose verb changed — the block records the verb, not just the path).",
    );
  }
  for (const key of phantom) {
    violations.push(
      `${DOC_FILE}: ${key} is documented in §3.1 but no RouteDef declares it — it was removed, ` +
        "renamed, or its verb changed.",
    );
  }
  for (const key of duplicateInCode) {
    violations.push(`${key} is declared by more than one RouteDef — the later one shadows.`);
  }
  for (const key of duplicateInDoc) {
    violations.push(`${DOC_FILE}: ${key} is listed twice in §3.1.`);
  }

  if (violations.length > 0) {
    console.error(
      `\nplugin-routes gate: ${DOC_FILE} §3.1 no longer matches the shipped route surface:\n` +
        `${violations.map((v) => `  ${v}`).join("\n")}\n\n` +
        `Fix by editing the fenced block under "${DOC_BLOCK_MARKER}" in ${DOC_FILE} so it lists ` +
        `exactly the registered routes, each as \`METHOD ${ROUTE_PREFIX}/... → description\`.`,
    );
    process.exit(1);
  }

  process.exit(0);
}

// Importing this module (as its test file does, to reach the exported functions) must have no side
// effects — no git calls, no filesystem reads, no process.exit. Only run the gate when this file is
// the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
