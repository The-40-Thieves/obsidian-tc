// docgen stats (homepage "at a glance"): version from package.json + live tool/config counts, so the
// wiki Home page's volatile facts never go stale.
import { describe, expect, it } from "vitest";
import { extractStats } from "../scripts/docgen/extract-stats";
import { renderStats } from "../scripts/docgen/render-stats";

describe("extractStats + renderStats (homepage)", () => {
  it("extracts a semver version and live counts", () => {
    const s = extractStats();
    expect(s.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(s.tools).toBeGreaterThan(100);
    expect(s.configKeys).toBeGreaterThan(100);
  });

  it("renders the facts into a table", () => {
    const md = renderStats({ version: "1.10.0", tools: 143, configKeys: 147 });
    expect(md).toContain("| **Version** | `1.10.0` |");
    expect(md).toContain("143 governed capabilities");
    expect(md).toContain("| **Config keys** | 147 |");
  });
});
