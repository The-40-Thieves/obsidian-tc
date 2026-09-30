// THE-523: the published compatibility matrix must be generated from code, so it cannot drift. The
// docs page (docs/wiki/Plugin-Bridges.md) carries a marked region that docgen fills at build time
// (the committed region is canonical-EMPTY, so there is no committed table to go stale or conflict).
// This test asserts (a) the marker pair still exists in the page, and (b) what docgen renders into it
// states exactly SUPPORTED_BRIDGE. Bump the constant and the rendered table follows automatically;
// a renderer that stops reading the constant fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCanonicalEmpty } from "../scripts/docgen/inject";
import { renderBridgeCompat } from "../scripts/docgen/render-bridge-compat";
import { SUPPORTED_BRIDGE } from "../src/bridge/version";

const DOC = join(__dirname, "..", "..", "..", "docs", "wiki", "Plugin-Bridges.md");

describe("THE-523 bridge compatibility matrix stays in sync with code", () => {
  const md = readFileSync(DOC, "utf8");
  const region = renderBridgeCompat();

  it("the page carries the bridge-compat marker pair, committed empty", () => {
    expect(md).toContain("<!-- BEGIN GENERATED: bridge-compat -->");
    expect(md).toContain("<!-- END GENERATED: bridge-compat -->");
    expect(isCanonicalEmpty(md, "bridge-compat")).toBe(true);
  });

  it("renders the current minimum companion plugin version", () => {
    expect(region).toContain(`\`${SUPPORTED_BRIDGE.minPluginVersion}\``);
  });

  it("renders the current minimum Obsidian version", () => {
    expect(region).toContain(`\`${SUPPORTED_BRIDGE.minObsidianVersion}\``);
  });

  it("renders the current companion API major", () => {
    expect(region).toContain(`\`${SUPPORTED_BRIDGE.expectedApi}\``);
  });
});
