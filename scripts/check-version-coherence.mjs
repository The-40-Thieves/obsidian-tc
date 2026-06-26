#!/usr/bin/env node
// Version-coherence gate (THE-256 Phase 1).
// Fails if the version strings across the published packages and the
// distribution metadata disagree. Run in CI (ci-version.yml) and by release.mjs.
// No dependencies; run from the repo root.
import { readFileSync } from "node:fs";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const sources = [];
const add = (label, version) => sources.push({ label, version });

add("package.json (root)", readJson("package.json").version);
add("packages/server/package.json", readJson("packages/server/package.json").version);
add("packages/native/package.json", readJson("packages/native/package.json").version);
add("packages/shared/package.json", readJson("packages/shared/package.json").version);

const server = readJson("server.json");
add("server.json", server.version);
if (Array.isArray(server.packages)) {
  server.packages.forEach((pkg, i) => add(`server.json packages[${i}]`, pkg.version));
}
add("manifest.json", readJson("manifest.json").version);

const width = Math.max(...sources.map((s) => s.label.length));
for (const s of sources) console.log(`${s.label.padEnd(width)}  ${s.version ?? "(missing)"}`);

const distinct = [...new Set(sources.map((s) => s.version))];
if (distinct.length !== 1 || distinct[0] == null) {
  console.error(`\nFAIL: version drift — ${distinct.length} distinct value(s): ${distinct.join(", ")}`);
  process.exit(1);
}
console.log(`\nOK: all ${sources.length} version strings agree at ${distinct[0]}`);
