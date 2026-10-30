// Note-parsing hot path: every indexed note goes through frontmatter parsing, chunking, link and
// tag extraction, and wikilink resolution against the vault index.
import { test } from "vitest";
import { chunkNote } from "../src/search/chunk";
import { parseNote } from "../src/vault/frontmatter";
import { buildVaultIndex, extractLinks, resolveTarget } from "../src/vault/links";
import { contentHash } from "../src/vault/paths";
import { extractInlineTags } from "../src/vault/tags";
import { makeNote, makePaths } from "./fixtures";

const smallNote = makeNote(2, 1);
const largeNote = makeNote(60, 2);
const smallBody = parseNote(smallNote).body;
const largeBody = parseNote(largeNote).body;

// Warm node's lazy digest init so it cannot land inside a measured bench body. `chunkNote` hashes
// every chunk (makeChunk -> contentHash -> createHash("sha256")) and this is the only bench file
// whose measured path reaches node:crypto; node builds its digest tables on the process's first
// createHash, at a cost of two syscalls. Whichever bench hashed first absorbed that, which under
// CodSpeed's Simulation instrument made `chunkNote::small note` bimodal - ~511us with sysCount 0,
// ~718us with sysCount 2, surfacing as a ~29% regression on PRs that touched no markdown code (GH
// #1448, an OAuth state fix). Each mode was otherwise reproducible to within 0.1us and the entire
// ~211us gap sat in contentHash's own self time. Hashing once at module load keeps the hot loops
// pure CPU work, so this file stays on the same Simulation instrument as the rest of the suite
// instead of moving to Walltime. Called directly, not via a throwaway chunkNote(), so it cannot
// silently stop warming if the chunker ever short-circuits on trivial input.
contentHash("warm node:crypto");

test("parseNote", async ({ bench }) => {
  await bench("small note", () => {
    parseNote(smallNote, "small.md");
  }).run();
  await bench("large note", () => {
    parseNote(largeNote, "large.md");
  }).run();
});

test("chunkNote", async ({ bench }) => {
  await bench("small note", () => {
    chunkNote(smallBody);
  }).run();
  await bench("large note", () => {
    chunkNote(largeBody);
  }).run();
  await bench("large note, 128-token chunks", () => {
    chunkNote(largeBody, { maxTokens: 128 });
  }).run();
});

test("extract links and tags", async ({ bench }) => {
  await bench("extractLinks (large note)", () => {
    extractLinks(largeBody);
  }).run();
  await bench("extractInlineTags (large note)", () => {
    extractInlineTags(largeBody);
  }).run();
});

test("wikilink resolution", async ({ bench }) => {
  const resolve = resolveTarget;
  const paths = makePaths(5_000, 3);
  const index = buildVaultIndex(paths);
  const targets = [
    ...paths.slice(0, 200).map((p) => p.replace(/\.md$/, "")),
    ...paths.slice(200, 400).map((p) => p.slice(p.lastIndexOf("/") + 1)),
    "vault hub",
    "missing note",
    "https://example.com",
  ];

  await bench("buildVaultIndex (5k notes)", () => {
    buildVaultIndex(paths);
  }).run();
  await bench("resolveTarget x403 (5k notes)", () => {
    for (const t of targets) resolve(index, t);
  }).run();
});
