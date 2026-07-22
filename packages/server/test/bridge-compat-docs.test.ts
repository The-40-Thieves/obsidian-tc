// THE-523: the published compatibility matrix must be generated from code, so it cannot drift. The
// docs page (docs/wiki/Plugin-Bridges.md) carries a marked table of the bridge contract; this test
// asserts the numbers in that marked region are exactly SUPPORTED_BRIDGE. Bump the constant without
// updating the doc and CI fails here — the drift gate THE-476 established, applied to the bridge matrix.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUPPORTED_BRIDGE } from "../src/bridge/version";

const DOC = join(__dirname, "..", "..", "..", "docs", "wiki", "Plugin-Bridges.md");

function generatedRegion(md: string): string {
  const begin = md.indexOf("<!-- BEGIN GENERATED: bridge-compat -->");
  const end = md.indexOf("<!-- END GENERATED: bridge-compat -->");
  expect(begin, "bridge-compat generated markers must exist in Plugin-Bridges.md").toBeGreaterThan(
    -1,
  );
  expect(end).toBeGreaterThan(begin);
  return md.slice(begin, end);
}

describe("THE-523 bridge compatibility matrix stays in sync with code", () => {
  const md = readFileSync(DOC, "utf8");
  const region = generatedRegion(md);

  it("documents the current minimum companion plugin version", () => {
    expect(region).toContain(`\`${SUPPORTED_BRIDGE.minPluginVersion}\``);
  });

  it("documents the current minimum Obsidian version", () => {
    expect(region).toContain(`\`${SUPPORTED_BRIDGE.minObsidianVersion}\``);
  });

  it("documents the current companion API major", () => {
    expect(region).toContain(`\`${SUPPORTED_BRIDGE.expectedApi}\``);
  });
});
