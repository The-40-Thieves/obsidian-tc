#!/usr/bin/env node
// THE-1122 — generates a small, deterministic, synthetic vault on DISK (real markdown files, not
// the in-memory fixtures eval/perf/harness.ts seeds directly into a DB) so the cold-start budget
// check below can index it through the REAL `obsidian-tc index` CLI path with the REAL "local"
// embeddings provider — the perf harness itself deliberately uses a fake, zero-I/O provider (see
// its own header comment) precisely so it never depends on network/model behaviour, which is
// exactly the axis this script measures instead. Not reusing eval/perf/scenarios.ts's generator:
// that one targets the in-memory DB-seeding path, not real files on disk, and duplicating ~500
// small deterministic notes here is simpler than adapting it.
//
// usage: node scripts/gen-cold-start-vault.mjs <dir> [noteCount]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const noteCount = Number(process.argv[3] ?? 500);
if (!dir) {
  console.error("usage: node scripts/gen-cold-start-vault.mjs <dir> [noteCount]");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

// A small deterministic PRNG (mulberry32) — no dependency, reproducible across runs/platforms.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x5eed);
const TOPICS = [
  "retrieval",
  "indexing",
  "embeddings",
  "graph search",
  "chunking",
  "access control",
  "provenance",
  "activation",
  "consolidation",
  "citation",
];

for (let i = 0; i < noteCount; i++) {
  const topic = TOPICS[i % TOPICS.length];
  const linkTarget = i > 0 ? `note-${String(Math.floor(rand() * i)).padStart(4, "0")}` : undefined;
  const body = [
    `# Note ${i} — ${topic}`,
    "",
    `This is a synthetic note about ${topic}, generated deterministically for a CI cold-start`,
    "timing check. It carries two sections so it chunks the same way every other perf fixture",
    "does: a body section and a links section.",
    "",
    "## Links",
    "",
    linkTarget
      ? `See also [[${linkTarget}]] for related material on ${topic}.`
      : "No related notes yet.",
  ].join("\n");
  writeFileSync(join(dir, `note-${String(i).padStart(4, "0")}.md`), body);
}
console.log(`wrote ${noteCount} notes to ${dir}`);
