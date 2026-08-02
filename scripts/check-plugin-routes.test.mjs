// Tests for scripts/check-plugin-routes.mjs — the THE-703 gate that ARCHITECTURE.md §3.1's fenced
// route block matches the RouteDef literals under packages/plugin/src/routes. Exercises the pure
// functions directly (blankComments, parseRouteDefs, parseDocRoutes, diffRoutes) rather than
// shelling out to git — none of them touch the filesystem or a subprocess. See
// check-boundaries.test.mjs for why this repo's scripts/ tests use node:test rather than vitest.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  blankComments,
  diffRoutes,
  parseDocRoutes,
  parseRouteDefs,
  routeKey,
} from "./check-plugin-routes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------
// 1. blankComments: erases comments, PRESERVES string literals (the inverse of blankNonCode).
// ---------------------------------------------------------------------------------------------

test("blankComments: same length as input", () => {
  const source = `// a comment\nconst x = { method: "post", path: "/a" };\n/* block\n comment */\n`;
  assert.equal(blankComments(source).length, source.length);
});

test("blankComments: same line count as input", () => {
  const source = `l1\n// c\nl3\n/* multi\nline\ncomment */\nlast\n`;
  const blanked = blankComments(source);
  assert.equal(blanked.split("\n").length, source.split("\n").length);
});

test("blankComments: string literal contents survive — they are this gate's payload", () => {
  const source = `{ method: "post", path: "/git/status" }`;
  assert.equal(blankComments(source), source);
});

test("blankComments: a `//` inside a string does not open a comment", () => {
  // The failure this prevents: naive comment stripping treats the `//` in a URL as a line comment
  // and blanks the rest of the line, taking a real `path:` with it — a silent under-count, which
  // for a set-difference gate means a real drift passes.
  const source = `const doc = "https://example.test/x";\nconst r = { method: "get", path: "/probe" };\n`;
  const blanked = blankComments(source);
  assert.match(blanked, /path: "\/probe"/);
  const { routes } = parseRouteDefs("f.ts", blanked);
  assert.deepEqual(routes.map(routeKey), ["GET /probe"]);
});

test("blankComments: a commented-out route is not counted as shipped", () => {
  const source = `// { method: "post", path: "/git/blame" }\nconst r = { method: "get", path: "/probe" };\n`;
  const { routes, errors } = parseRouteDefs("f.ts", blankComments(source));
  assert.deepEqual(errors, []);
  assert.deepEqual(routes.map(routeKey), ["GET /probe"]);
});

// ---------------------------------------------------------------------------------------------
// 2. parseRouteDefs: pairing, verb normalization, and the shapes it must refuse to guess at.
// ---------------------------------------------------------------------------------------------

test("parseRouteDefs: pairs each path with the method above it and upper-cases the verb", () => {
  const source = `
    return [
      { method: "post", path: "/git/status", handler: h },
      { method: "get", path: "/probe", handler: h },
    ];
  `;
  const { routes, errors } = parseRouteDefs("routes/git.ts", blankComments(source));
  assert.deepEqual(errors, []);
  assert.deepEqual(routes.map(routeKey), ["POST /git/status", "GET /probe"]);
});

test("parseRouteDefs: reports the declaring file and line, so a failure names the RouteDef", () => {
  const source = `line1\nline2\n{ method: "post", path: "/x" }\n`;
  const { routes } = parseRouteDefs("routes/x.ts", blankComments(source));
  assert.equal(routes[0].file, "routes/x.ts");
  assert.equal(routes[0].line, 3);
});

test("parseRouteDefs: skips a string-literal union in a TYPE position", () => {
  // routes/types.ts really declares `interface RouteDef { method: "get" | "post"; path: string; }`.
  // The first run of this gate against the real tree flagged it as a trailing unpaired `method:`.
  const source = `export interface RouteDef {\n  method: "get" | "post";\n  path: string;\n}\n`;
  const { routes, errors } = parseRouteDefs("routes/types.ts", blankComments(source));
  assert.deepEqual(routes, []);
  assert.deepEqual(errors, []);
});

test("parseRouteDefs: an unpaired path is an ERROR, never a silent drop", () => {
  // Silently dropping a route the parser cannot read shrinks the scanned set, and a smaller set
  // compares equal more easily — the exact way a set-difference gate passes over a real drift.
  const source = `{ path: "/orphan", handler: h }`;
  const { routes, errors } = parseRouteDefs("routes/x.ts", blankComments(source));
  assert.deepEqual(routes, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no `method:` before it/);
});

test("parseRouteDefs: two methods with no path between them is an ERROR", () => {
  const source = `{ method: "get", method: "post", path: "/x" }`;
  const { errors } = parseRouteDefs("routes/x.ts", blankComments(source));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /another `method:`/);
});

test("parseRouteDefs: a trailing method with no path is an ERROR", () => {
  const source = `{ method: "post" }`;
  const { errors } = parseRouteDefs("routes/x.ts", blankComments(source));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /trailing `method:/);
});

// ---------------------------------------------------------------------------------------------
// 3. parseDocRoutes: locating the block, and refusing to return an empty set quietly.
// ---------------------------------------------------------------------------------------------

const DOC_FIXTURE = [
  "prose before",
  "",
  "**Routes (as shipped — assembled by `buildRoutes`):**",
  "",
  "```",
  "GET    /obsidian-tc/v1/probe            → capability discovery",
  "POST   /obsidian-tc/v1/git/status       → working-tree status",
  "```",
  "",
  "prose after, mentioning ``` fences elsewhere",
].join("\n");

test("parseDocRoutes: reads the fenced block that follows the marker", () => {
  const { routes, errors } = parseDocRoutes(DOC_FIXTURE);
  assert.deepEqual(errors, []);
  assert.deepEqual(routes.map(routeKey), ["GET /probe", "POST /git/status"]);
});

test("parseDocRoutes: strips the mount prefix so both sides compare on the same path", () => {
  const { routes } = parseDocRoutes(DOC_FIXTURE);
  assert.ok(routes.every((r) => r.path.startsWith("/") && !r.path.includes("obsidian-tc")));
});

test("parseDocRoutes: a missing marker is an ERROR, not an empty set", () => {
  // The regression this pins: `sed '/marker/,/```/'` terminates on the block's own OPENING fence
  // and yields nothing, which produced a 28-vs-0 comparison that looked like a legitimate diff.
  // An empty documented set must never be mistaken for "the doc says there are no routes".
  const { routes, errors } = parseDocRoutes("no marker anywhere\n```\nGET /x\n```\n");
  assert.deepEqual(routes, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not find the route-block marker/);
});

test("parseDocRoutes: an unclosed fence is an ERROR", () => {
  const { errors } = parseDocRoutes(
    "**Routes (as shipped:**\n```\nGET /obsidian-tc/v1/probe → x\n",
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /never closed/);
});

test("parseDocRoutes: a documented route missing the mount prefix is an ERROR", () => {
  const doc = "**Routes (as shipped:**\n```\nGET    /probe    → x\n```\n";
  const { routes, errors } = parseDocRoutes(doc);
  assert.deepEqual(routes, []);
  assert.match(errors[0], /does not start with the mount prefix/);
});

// ---------------------------------------------------------------------------------------------
// 4. diffRoutes: both directions, including the verb-only drift that started THE-703.
// ---------------------------------------------------------------------------------------------

test("diffRoutes: identical sets produce no findings", () => {
  const both = [{ method: "GET", path: "/probe" }];
  const d = diffRoutes(both, both);
  assert.deepEqual(d.undocumented, []);
  assert.deepEqual(d.phantom, []);
});

test("diffRoutes: a registered route absent from the doc is undocumented", () => {
  const d = diffRoutes(
    [
      { method: "GET", path: "/probe" },
      { method: "POST", path: "/git/status" },
    ],
    [{ method: "GET", path: "/probe" }],
  );
  assert.deepEqual(d.undocumented, ["POST /git/status"]);
  assert.deepEqual(d.phantom, []);
});

test("diffRoutes: a documented route with no RouteDef is phantom", () => {
  const d = diffRoutes(
    [{ method: "GET", path: "/probe" }],
    [
      { method: "GET", path: "/probe" },
      { method: "POST", path: "/git/blame" },
    ],
  );
  assert.deepEqual(d.phantom, ["POST /git/blame"]);
});

test("diffRoutes: a wrong VERB on a documented path is caught in both directions", () => {
  // THE-703's actual bug: /commands/list, /templater/list and /quickadd/actions were documented
  // GET while shipping POST. A path-only comparison would have called that set equal.
  const d = diffRoutes(
    [{ method: "POST", path: "/commands/list" }],
    [{ method: "GET", path: "/commands/list" }],
  );
  assert.deepEqual(d.undocumented, ["POST /commands/list"]);
  assert.deepEqual(d.phantom, ["GET /commands/list"]);
});

test("diffRoutes: duplicates are reported on whichever side carries them", () => {
  const dupe = [
    { method: "GET", path: "/probe" },
    { method: "GET", path: "/probe" },
  ];
  const d = diffRoutes(dupe, [{ method: "GET", path: "/probe" }]);
  assert.deepEqual(d.duplicateInCode, ["GET /probe"]);
  assert.deepEqual(d.duplicateInDoc, []);
});

// ---------------------------------------------------------------------------------------------
// 5. Against the real tree: the gate's own subject matter, so a refactor that breaks the parser
//    fails here too rather than only in CI.
// ---------------------------------------------------------------------------------------------

test("real tree: ARCHITECTURE.md §3.1 parses to a non-trivial documented route set", () => {
  const { routes, errors } = parseDocRoutes(readFileSync(join(ROOT, "ARCHITECTURE.md"), "utf8"));
  assert.deepEqual(errors, []);
  assert.ok(routes.length >= 10, `expected >= 10 documented routes, got ${routes.length}`);
  assert.ok(routes.some((r) => r.path === "/probe"));
});

test("real tree: routes/types.ts contributes no RouteDef values", () => {
  const src = readFileSync(join(ROOT, "packages/plugin/src/routes/types.ts"), "utf8");
  const { routes, errors } = parseRouteDefs("types.ts", blankComments(src));
  assert.deepEqual(routes, []);
  assert.deepEqual(errors, []);
});
