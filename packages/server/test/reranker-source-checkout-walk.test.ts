// THE-1079 (GH #947), cross-vendor review hardening: `resolveSourceCheckoutLocalRerankerPath`'s
// upward walk anchors on `packages/reranker-local/package.json` — these two cases pin the two
// ways an ANCHOR MATCH ALONE would have been wrong to trust:
//
//   1. a `packages/reranker-local/package.json` that exists but names a different package (a
//      decoy in an unrelated tree with a coincidentally identical layout) must be rejected, and
//      the walk must keep going past it to a real anchor further up.
//   2. an executing module whose own path sits under `node_modules` (an npm-installed server) must
//      never walk upward at all — it could otherwise adopt an unrelated monorepo it happens to be
//      vendored into.
//
// Pure filesystem unit tests: no build, no dynamic import, just directory/file scaffolding under a
// throwaway temp dir and direct calls with an injected `startDir` (the function's default reads
// the real `import.meta.url`; tests never touch that).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSourceCheckoutLocalRerankerPath } from "../src/providers/registry";
import { rmTemp } from "./tmp";

const REAL_NAME = "@the-40-thieves/obsidian-tc-reranker-local";

let dir: string;

afterEach(() => {
  try {
    rmTemp(dir);
  } catch {
    // best effort
  }
});

function writeAnchor(root: string, name: string): void {
  const pkgDir = join(root, "packages", "reranker-local");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name }));
}

describe("resolveSourceCheckoutLocalRerankerPath — anchor + node_modules hardening", () => {
  it("rejects a decoy anchor (wrong package name) and keeps walking to the REAL anchor further up", () => {
    dir = mkdtempSync(join(tmpdir(), "obtc-anchor-"));
    // Real anchor two levels up from `start`.
    writeAnchor(dir, REAL_NAME);
    // Decoy one level up from `start` — same file layout, wrong `name`.
    const decoyRoot = join(dir, "fake");
    writeAnchor(decoyRoot, "some-unrelated-package");
    const start = join(decoyRoot, "nested");
    mkdirSync(start, { recursive: true });

    const result = resolveSourceCheckoutLocalRerankerPath(start);
    expect(result.skippedReason).toBeUndefined();
    expect(result.path).toBe(join(dir, "packages", "reranker-local", "dist", "index.js"));
    // The decoy's directory must actually have been tried, not silently skipped over.
    expect(result.candidates).toContain(decoyRoot);
  });

  it("never even walks when the executing module's own path is under node_modules", () => {
    dir = mkdtempSync(join(tmpdir(), "obtc-nm-"));
    // A real, valid anchor exists above — proving the skip is unconditional, not "anchor not found".
    writeAnchor(dir, REAL_NAME);
    const start = join(dir, "node_modules", "some-installed-server", "dist");
    mkdirSync(start, { recursive: true });

    const result = resolveSourceCheckoutLocalRerankerPath(start);
    expect(result.skippedReason).toBe("skipped: running from node_modules");
    expect(result.candidates).toEqual([]);
  });
});
