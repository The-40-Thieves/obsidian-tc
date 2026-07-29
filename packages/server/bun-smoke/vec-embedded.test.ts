// THE-663: `createRequire(import.meta.url)` in vec.ts resolves sqlite-vec via node_modules — which
// works from source and the npm dist build, but `bun build --compile` freezes import.meta.url to
// the BUILD MACHINE's path, so every published standalone binary silently lost vec0 and fell back
// to the brute-force cosine scan. loadVec() now falls back to a copy baked into the binary itself
// by scripts/gen-embedded-vec.mjs (see vec-embedded.ts).
//
// This test proves the fallback's MATERIALIZE-THEN-loadExtension mechanism against a real vec0
// binary for this host — the part that is easy to get subtly wrong (sqlite derives the extension's
// entry-point symbol from the materialized file's BASENAME, so it must be exactly "vec0.<ext>", not
// e.g. "vec0-<hash>.<ext>" or any other name; see vec.ts's vecExtension()/materializeEmbeddedVec()).
// It does not need an actual --compile build to do that: it mocks vec-embedded.ts's export (the
// only thing loadVec's fallback branch reads) with the real bytes sqlite-vec already installed for
// this host, then exercises the same materializeEmbeddedVec() the real fallback calls.
//
// The fallback ACTUALLY TRIGGERING inside a compiled binary (i.e. that requireFromHere("sqlite-vec")
// really does throw once the binary leaves the build machine) is proven separately and end-to-end:
// publish.yml's release smoke test asserts `vec_enabled: true` against a real --compile binary run
// in a container with no node_modules and no network.
//
// In bun-smoke, not vitest, for the same reason as vec-recall.test.ts: this exercises
// db.loadExtension, which node:sqlite (the vitest runtime) cannot do at all.
import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { getLoadablePath } from "sqlite-vec";
import { openDatabase } from "../src/db/open";
import { materializeEmbeddedVec } from "../src/search/vec";

// The real vec0 binary sqlite-vec resolved for THIS host — exactly what
// scripts/gen-embedded-vec.mjs would have embedded had this been a --compile build for this
// platform, fetched from the matching sqlite-vec-<platform> package instead of node_modules.
const realVecPath = getLoadablePath();
const realVecBytes = readFileSync(realVecPath);
const realVecExt = extname(realVecPath).slice(1); // "so" | "dylib" | "dll"

mock.module("../src/search/vec-embedded", () => ({
  EMBEDDED_VEC_BASE64: realVecBytes.toString("base64"),
}));

test("materializeEmbeddedVec writes vec0.<ext> (not any other name) and it loads", async () => {
  const out = materializeEmbeddedVec();
  expect(out).toBeDefined();
  if (!out) return; // narrows for TS; asserted above
  // Basename MUST be exactly vec0.<ext> — sqlite derives the dlsym() entry-point symbol from it.
  expect(out.endsWith(`/vec0.${realVecExt}`) || out.endsWith(`\\vec0.${realVecExt}`)).toBe(true);
  expect(readFileSync(out).equals(realVecBytes)).toBe(true);

  const db = await openDatabase(":memory:");
  try {
    // The proof that matters: sqlite can actually dlopen the materialized file and resolve its
    // entry point. A wrong basename fails here with "undefined symbol", not at the write above.
    db.loadExtension?.(out);
    const row = db.prepare("SELECT vec_version() AS v").get() as { v: string };
    expect(row.v).toMatch(/^v\d+\.\d+\.\d+/);
  } finally {
    db.close?.();
  }
});

test("memoizes the materialized path across calls in the same process", () => {
  const first = materializeEmbeddedVec();
  const second = materializeEmbeddedVec();
  expect(second).toBe(first);
});
