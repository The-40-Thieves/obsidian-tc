// docgen marker scan (THE-470 hole 1, widened by THE-595). Builds a throwaway repo tree so the
// scan's file-discovery logic is exercised directly, without depending on this repo's own docs
// tree staying a particular shape. Covers the THE-595 widening specifically: docs/*.md must now be
// scanned (the G2 design-doc surface was previously invisible), but TREE.md must stay excluded
// (different generator, gated by `map:check`) and docs/wiki + docs/src/content must not be
// double-walked by the new top-level docs/ pass.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { candidateFiles, findGeneratedMarkers } from "../scripts/docgen/marker-scan";
import { rmTemp } from "./tmp";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "obtc-marker-scan-"));
});

afterEach(() => {
  rmTemp(repoRoot);
});

describe("candidateFiles / findGeneratedMarkers (THE-470, widened THE-595)", () => {
  it("includes top-level docs/*.md (the G2 design-doc surface)", () => {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs/G2.4-observability.md"), "hi");
    const files = candidateFiles(repoRoot);
    expect(files).toContain("docs/G2.4-observability.md");
  });

  it("excludes TREE.md — a different generator, gated separately by map:check", () => {
    writeFileSync(join(repoRoot, "TREE.md"), "hi");
    const files = candidateFiles(repoRoot);
    expect(files).not.toContain("TREE.md");
  });

  it("does not double-scan docs/wiki or docs/src via the new top-level docs/ pass", () => {
    mkdirSync(join(repoRoot, "docs/wiki"), { recursive: true });
    mkdirSync(join(repoRoot, "docs/src/content"), { recursive: true });
    writeFileSync(join(repoRoot, "docs/wiki/Home.md"), "hi");
    writeFileSync(join(repoRoot, "docs/src/content/x.md"), "hi");
    const files = candidateFiles(repoRoot);
    const occurrences = (rel: string) => files.filter((f) => f === rel).length;
    expect(occurrences("docs/wiki/Home.md")).toBe(1);
    expect(occurrences("docs/src/content/x.md")).toBe(1);
  });

  it("survives a missing docs/ directory instead of throwing", () => {
    expect(() => candidateFiles(repoRoot)).not.toThrow();
  });

  it("finds a marker on the widened docs/*.md surface", () => {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(
      join(repoRoot, "docs/G2.4-observability.md"),
      "<!-- BEGIN GENERATED: metrics-catalog -->\nx\n<!-- END GENERATED: metrics-catalog -->\n",
    );
    const markers = findGeneratedMarkers(repoRoot);
    expect(markers).toEqual([{ file: "docs/G2.4-observability.md", marker: "metrics-catalog" }]);
  });
});
