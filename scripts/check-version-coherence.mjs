#!/usr/bin/env node
// Version-coherence gate (THE-256 Phase 1).
// Fails if the version strings across the published packages and the
// distribution metadata disagree. Run in CI (ci-version.yml) and by release.mjs.
// No dependencies; run from the repo root.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  bunLockWorkspaceVersionProblems,
  WORKSPACE_PACKAGE_JSON,
} from "./lib/bun-lock-workspace-versions.mjs";

// Every path below is a hardcoded repo-relative metadata file; this guard keeps
// the reads provably contained to the repo root (defense in depth for tooling).
const ROOT = resolve(".");
const readJson = (p) => {
  const base = resolve(ROOT);
  const target = resolve(base, p);
  // relative() expresses any escape (absolute paths included) as a "../" prefix.
  if (relative(base, target).startsWith("..")) {
    throw new Error(`refusing to read outside repo root: ${p}`);
  }
  return JSON.parse(readFileSync(target, "utf8"));
};
const sources = [];
const add = (label, version) => sources.push({ label, version });

// The core release unit. The companion plugin's Obsidian manifest is asserted separately below;
// it now tracks the repo version in lockstep (decision 2026-07-02). THE-950: the MCPB bundle
// manifest asserted below lives at mcpb/manifest.json — the repo-ROOT manifest.json is the
// plugin's Obsidian manifest now (checked for byte-identity with it further down), not this one.
add("package.json (root)", readJson("package.json").version);
add("packages/server/package.json", readJson("packages/server/package.json").version);
add("packages/native/package.json", readJson("packages/native/package.json").version);
add("packages/shared/package.json", readJson("packages/shared/package.json").version);
// THE-944 review round 1 (F2): packages/reranker-local is not a root workspace member (see its
// own README), but it rejoins the lockstep release.mjs now maintains — without this, the
// publish-reranker-local CI job's F3-style already-published preflight would find the SAME
// version already on npm on every release after the owner's one-time first manual publish, and
// silently skip publishing forever.
add(
  "packages/reranker-local/package.json",
  readJson("packages/reranker-local/package.json").version,
);

const server = readJson("server.json");
add("server.json", server.version);
if (Array.isArray(server.packages)) {
  server.packages.forEach((pkg, i) => {
    add(`server.json packages[${i}]`, pkg.version);
  });
}
add("mcpb/manifest.json", readJson("mcpb/manifest.json").version);

const width = Math.max(...sources.map((s) => s.label.length));
for (const s of sources) console.log(`${s.label.padEnd(width)}  ${s.version ?? "(missing)"}`);

const distinct = [...new Set(sources.map((s) => s.version))];
if (distinct.length !== 1 || distinct[0] == null) {
  console.error(
    `\nFAIL: version drift — ${distinct.length} distinct value(s): ${distinct.join(", ")}`,
  );
  process.exit(1);
}
console.log(`\nOK: all ${sources.length} version strings agree at ${distinct[0]}`);

// THE-947 (from THE-946's report): bun.lock caches its own copy of each workspace's version in
// `workspaces["<path>"].version`, refreshed only when a non-frozen `bun install` touches it. The
// frozen-lockfile install that CI runs everywhere else checks that the lockfile is CONSISTENT with
// package.json's declared dependencies, not that every workspace's version field is a live mirror
// — THE-946 shipped with a stale one that check missed. Compared against each package.json ON DISK
// directly, not folded into the `sources`/`distinct` check above: that check covers only the
// lockstep-release set listed there (root, server, native, shared, reranker-local), and
// packages/plugin's OWN package.json version is deliberately outside that set (only its Obsidian
// manifest.json is, checked below) — bun.lock still needs to agree with IT, not with the release
// version.
// bun.lock is a lenient JSON dialect (bun accepts trailing commas that plain JSON does not).
// WORKSPACE_PACKAGE_JSON and bunLockWorkspaceVersionProblems are shared with
// scripts/lib/bun-lock-workspace-versions.mjs (THE-948), which release.mjs uses to rewrite these
// same fields — one inventory of lockstep workspace paths, and one assertion about them, not two
// of each that can drift apart.
{
  const lockText = readFileSync(resolve(ROOT, "bun.lock"), "utf8");
  const packageVersions = Object.fromEntries(
    Object.entries(WORKSPACE_PACKAGE_JSON).map(([wsPath, pkgPath]) => [
      wsPath,
      readJson(pkgPath).version,
    ]),
  );
  const lockDrift = bunLockWorkspaceVersionProblems(lockText, packageVersions);
  if (lockDrift.length) {
    console.error(`\nFAIL: bun.lock workspace-version drift:\n  ${lockDrift.join("\n  ")}`);
    process.exit(1);
  }
  console.log(
    `bun.lock workspace versions OK (${Object.keys(WORKSPACE_PACKAGE_JSON).length} workspaces)`,
  );
}

// THE-282 + lockstep (decision 2026-07-02): the companion plugin's Obsidian manifest version must
// EQUAL the repo version (it rejoined lockstep), and versions.json must list it (community-store
// requirement). THE-950: the repo-root manifest.json is now this SAME manifest (byte-identical,
// checked below) — the MCPB bundle manifest asserted in the `sources` list above is the one that
// moved, to mcpb/manifest.json.
{
  const { readFileSync: rf } = await import("node:fs");
  const manifest = JSON.parse(
    rf(new URL("../packages/plugin/manifest.json", import.meta.url), "utf8"),
  );
  const versions = JSON.parse(
    rf(new URL("../packages/plugin/versions.json", import.meta.url), "utf8"),
  );
  if (manifest.version !== distinct[0]) {
    console.error(
      `FAIL: companion plugin manifest version (${manifest.version}) does not match the repo version (${distinct[0]}); the plugin is in lockstep.`,
    );
    process.exit(1);
  }
  if (!Object.hasOwn(versions, manifest.version)) {
    console.error(
      `FAIL: packages/plugin/versions.json lacks an entry for manifest version ${manifest.version}`,
    );
    process.exit(1);
  }
  console.log(
    `companion versions.json OK (${manifest.version} -> minAppVersion ${versions[manifest.version]})`,
  );
}

// THE-950: Obsidian's community-directory validator reads manifest.json from the repo's default
// branch, so the plugin's Obsidian manifest must live at the repo root — but it must not become a
// second hand-maintained copy of packages/plugin/manifest.json. release.mjs writes both from one
// source (see its "mirror the bumped plugin manifest onto the repo root" step); this gate is what
// makes a drift between them (a hand-edit to only one side) fail loudly instead of silently
// shipping a stale root manifest to the directory.
{
  const rootManifestRaw = readFileSync(resolve(ROOT, "manifest.json"), "utf8");
  const pluginManifestRaw = readFileSync(resolve(ROOT, "packages/plugin/manifest.json"), "utf8");
  if (rootManifestRaw !== pluginManifestRaw) {
    console.error(
      "\nFAIL: repo-root manifest.json is not byte-identical to packages/plugin/manifest.json " +
        "(THE-950: the root copy IS the plugin's Obsidian manifest, mirrored by release.mjs — " +
        "edit packages/plugin/manifest.json and copy it over, or re-run `bun scripts/release.mjs`).",
    );
    process.exit(1);
  }
  console.log("root manifest.json OK (byte-identical to packages/plugin/manifest.json)");
}

// THE-306: pin the shipped tool-count headline so the docs cannot silently drift from the registry.
// The registry's ACTUAL count is asserted by packages/server/test/tool-count.test.ts
// (REGISTERED_TOOL_COUNT, checked against registry.list().length). Each target is a canonical
// shipped-count phrase; the historical "103 at r2" G2.1 design numbers are intentionally excluded
// (they describe the r2 spec surface, not the shipped surface).
//
// THE-580 fixed two ways this gate could pass while stale:
//
//   1. It matched only the FIRST occurrence per file. In README.md the first hit is hand-written
//      prose ABOVE the docgen-generated marker region, so after docgen wrote a new number into the
//      generated block the gate still agreed with the prose eleven lines above and reported OK. A
//      number could stay stale indefinitely as long as it stayed CONSISTENTLY stale — precisely the
//      failure a coherence check exists to prevent. Now every occurrence is checked, with line
//      numbers in the failure.
//   2. EXPECTED_TOOL_COUNT was a hand-kept duplicate of REGISTERED_TOOL_COUNT, "kept in lockstep"
//      by remembering. Remembering is not a mechanism. It is now DERIVED from that constant, so the
//      two cannot diverge; the test still checks that constant against the live registry, which
//      keeps the whole chain anchored to reality rather than to a literal.
//
// This gate is NOT redundant with docgen:facts-check, despite overlapping. facts-check sweeps every
// narrative surface for generic phrasings but DELIBERATELY excludes bare "(\d+)-tool" (the
// legitimate "3-tool facade" is a different fact). Verified by experiment: corrupting
// ARCHITECTURE.md's "150-tool G2.1 surface" and README's "| 150 (3-tool facade) |" table cell leaves
// facts-check reporting "no narrative drift" while this gate fails on both. The precise file+phrase
// anchors here cover exactly what a global sweep cannot safely match.
{
  // Derived, not duplicated (THE-580). Parsed rather than imported because this script runs under
  // plain node (ci-version.yml) and the authority lives in a TypeScript test.
  // THE-548: moved out of tool-count.test.ts, which used to hold it AND a second copy lived in
  // tool-facade-domain-coverage.test.ts that this gate never read. Both tests now import from here,
  // so the number this gate checks and the number the suite asserts cannot diverge.
  const TOOL_COUNT_SOURCE = "packages/server/test/registered-tool-count.ts";
  const EXPECTED_TOOL_COUNT = (() => {
    const src = readFileSync(resolve(ROOT, TOOL_COUNT_SOURCE), "utf8");
    const m = src.match(/const\s+REGISTERED_TOOL_COUNT\s*=\s*(\d+)/);
    if (!m) {
      console.error(
        `\nFAIL: could not read REGISTERED_TOOL_COUNT from ${TOOL_COUNT_SOURCE} — the tool-count gate has no authority to check against, so it must not report OK.`,
      );
      process.exit(1);
    }
    return Number(m[1]);
  })();
  const readText = (p) => {
    const target = resolve(ROOT, p);
    if (relative(ROOT, target).startsWith("..")) {
      throw new Error(`refusing to read outside repo root: ${p}`);
    }
    return readFileSync(target, "utf8");
  };
  const targets = [
    ["README.md", /~?(\d+) governed capabilities/],
    ["README.md", /\*\*~?(\d+) tools across 31 domains\*\*/],
    // comparison-table cell — was a stale "~123" outside the inventory until the 2026-07-15 audit.
    ["README.md", /\*\*obsidian-tc\*\* \| ~?(\d+) \(3-tool facade\)/],
    ["packages/server/README.md", /\((\d+) tools across 31 domains/],
    ["ARCHITECTURE.md", /(\d+)-tool G2\.1 surface/],
    ["docs/src/content/docs/index.md", /~?(\d+) typed tools/],
    ["docs/src/content/docs/getting-started/concepts.md", /~?(\d+) typed tools/],
    ["docs/src/content/docs/tools/index.md", /~?(\d+)-tool surface/],
    ["docs/src/content/docs/roadmap.md", /(\d+) tools across 31 domains/],
  ];
  const drift = [];
  let occurrences = 0;
  for (const [file, re] of targets) {
    let text;
    try {
      text = readText(file);
    } catch {
      drift.push(`${file}: not found`);
      continue;
    }
    // EVERY occurrence, not just the first (THE-580). Scanned line by line so a failure names the
    // exact line, and so one stale copy cannot hide behind a correct one earlier in the file.
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let matched = 0;
    for (const [lineNo, line] of text.split("\n").entries()) {
      for (const m of line.matchAll(global)) {
        matched += 1;
        if (Number(m[1]) !== EXPECTED_TOOL_COUNT) {
          drift.push(
            `${file}:${lineNo + 1}: headline says ${m[1]}, expected ${EXPECTED_TOOL_COUNT}`,
          );
        }
      }
    }
    // A pattern that matches nothing is itself drift: the phrase was reworded or deleted, and a
    // silent zero-match would quietly retire the anchor while the gate kept reporting OK.
    if (matched === 0) drift.push(`${file}: no tool-count headline matched ${re}`);
    occurrences += matched;
  }
  if (drift.length) {
    console.error(`\nFAIL: tool-count headline drift (THE-306):\n  ${drift.join("\n  ")}`);
    process.exit(1);
  }
  console.log(
    `tool-count headline OK (${EXPECTED_TOOL_COUNT} from ${TOOL_COUNT_SOURCE}; ${occurrences} occurrence(s) across ${targets.length} anchors)`,
  );
}

// Version-prose coherence: the docs that state the shipped version as prose must match the package.
// NOTE: every file anchored below MUST also appear in release.mjs's PROSE_FILES, or a cut fails
// here with the version files already rewritten (that is exactly what blocked 1.10.0). The two
// lists are hand-kept in sync today; folding them into one shared module is the durable fix.
// version (they drift otherwise — swept by hand at 1.3.3). release.mjs bumps these on every cut.
{
  const version = distinct[0];
  const readText = (p) => {
    const target = resolve(ROOT, p);
    if (relative(ROOT, target).startsWith("..")) {
      throw new Error(`refusing to read outside repo root: ${p}`);
    }
    return readFileSync(target, "utf8");
  };
  const anchors = [
    ["README.md", /Shipped v(\d+\.\d+\.\d+)/],
    ["packages/server/README.md", /Shipped\D+v(\d+\.\d+\.\d+)/],
    ["docs/src/content/docs/index.md", /v(\d+\.\d+\.\d+) is the current release/],
    ["docs/src/content/docs/roadmap.md", /Shipped \(current: v(\d+\.\d+\.\d+)\)/],
    // THE-598: docs/wiki/Home.md's "Shipped — **v1.10.0**" sat nine lines below a generated block
    // saying 1.11.0 with NO gate catching it — this file was never anchored here at all. The
    // literal `Shipped v(\d+\.\d+\.\d+)` pattern above would not have matched even if it had been
    // listed: Home.md's prose is "Shipped — **vX.Y.Z**" (em dash + bold), a different shape from
    // every other anchor's plain "Shipped vX.Y.Z".
    ["docs/wiki/Home.md", /Shipped\s*(?:—|-)?\s*\*\*v(\d+\.\d+\.\d+)\*\*/],
  ];
  const vdrift = [];
  for (const [file, re] of anchors) {
    const m = readText(file).match(re);
    if (!m) vdrift.push(`${file}: no current-version prose matched ${re}`);
    else if (m[1] !== version) vdrift.push(`${file}: prose says ${m[1]}, package is ${version}`);
  }
  if (vdrift.length) {
    console.error(`\nFAIL: version-prose drift:\n  ${vdrift.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`version-prose OK (${version} across ${anchors.length} doc anchors)`);
}

// SECURITY.md supported-version table coherence (THE-562 regression fix). SECURITY.md previously
// appeared in NO script and NO workflow — not this gate's anchors, not release.mjs's prose bump —
// so nothing caught it when the table kept advertising "1.10.x" after v1.11.0 shipped. Anchored on
// the SUPPORTED row specifically (":white_check_mark:"), not a loose file-wide version match: a
// loose match would pass as long as *some* version string in the file happened to be current, even
// if the actual supported-version claim were stale. SECURITY.md advertises support by MINOR
// ("1.11.x" covers every patch of that minor — see the "Security fixes land on the latest minor"
// sentence above the table), so this compares against the package's major.minor, not the full
// x.y.z the version-prose block above checks. release.mjs bumps this table in a dedicated step
// (search "SECURITY.md supported-version"), not the literal-string PROSE_FILES loop, because a
// literal full-version replace would never match a minor-only "X.Y.x" cell.
{
  const version = distinct[0];
  const minor = version.split(".").slice(0, 2).join(".");
  const target = resolve(ROOT, "SECURITY.md");
  const text = readFileSync(target, "utf8");
  const m = text.match(/\|\s*(\d+\.\d+)\.x\s*\|\s*:white_check_mark:\s*\|/);
  if (!m) {
    console.error(
      "\nFAIL: SECURITY.md has no supported-version table row matching /X.Y.x | :white_check_mark:/.",
    );
    process.exit(1);
  }
  if (m[1] !== minor) {
    console.error(
      `\nFAIL: SECURITY.md supported-version drift — table advertises ${m[1]}.x as supported, package minor is ${minor}.`,
    );
    process.exit(1);
  }
  console.log(`SECURITY.md supported-version OK (${m[1]}.x matches package minor ${minor})`);
}
