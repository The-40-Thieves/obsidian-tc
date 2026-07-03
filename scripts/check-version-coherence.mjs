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
