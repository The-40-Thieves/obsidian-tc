#!/usr/bin/env node
// Version-coherence gate (THE-256 Phase 1).
// Fails if the version strings across the published packages and the
// distribution metadata disagree. Run in CI (ci-version.yml) and by release.mjs.
// No dependencies; run from the repo root.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

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
// it now tracks the repo version in lockstep (decision 2026-07-02). Note the root manifest.json
// added below is the MCPB server bundle manifest, not the plugin's Obsidian manifest.
add("package.json (root)", readJson("package.json").version);
add("packages/server/package.json", readJson("packages/server/package.json").version);
add("packages/native/package.json", readJson("packages/native/package.json").version);
add("packages/shared/package.json", readJson("packages/shared/package.json").version);

const server = readJson("server.json");
add("server.json", server.version);
if (Array.isArray(server.packages)) {
  server.packages.forEach((pkg, i) => {
    add(`server.json packages[${i}]`, pkg.version);
  });
}
add("manifest.json", readJson("manifest.json").version);

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

// THE-282 + lockstep (decision 2026-07-02): the companion plugin's Obsidian manifest version must
// EQUAL the repo version (it rejoined lockstep), and versions.json must list it (community-store
// requirement). The root manifest.json above is the MCPB server bundle manifest, not this one.
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

// THE-306: pin the shipped tool-count headline so the docs cannot silently drift from the registry.
// The registry's ACTUAL count is asserted by packages/server/test/tool-count.test.ts
// (REGISTERED_TOOL_COUNT); keep EXPECTED_TOOL_COUNT in lockstep with that constant. Each target is a
// canonical shipped-count phrase; the historical "103 at r2" G2.1 design numbers are intentionally
// excluded (they describe the r2 spec surface, not the shipped surface).
{
  const EXPECTED_TOOL_COUNT = 144;
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
  for (const [file, re] of targets) {
    let text;
    try {
      text = readText(file);
    } catch {
      drift.push(`${file}: not found`);
      continue;
    }
    const m = text.match(re);
    if (!m) drift.push(`${file}: no tool-count headline matched ${re}`);
    else if (Number(m[1]) !== EXPECTED_TOOL_COUNT) {
      drift.push(`${file}: headline says ${m[1]}, expected ${EXPECTED_TOOL_COUNT}`);
    }
  }
  if (drift.length) {
    console.error(`\nFAIL: tool-count headline drift (THE-306):\n  ${drift.join("\n  ")}`);
    process.exit(1);
  }
  console.log(
    `tool-count headline OK (${EXPECTED_TOOL_COUNT} across ${targets.length} doc surfaces)`,
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
