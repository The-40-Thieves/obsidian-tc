// docgen renderers (THE-472): DocsModel slices -> CommonMark. Structural assertions (not full golden
// files, which would churn as tools/config evolve); the drift gate (THE-476) pins the committed pages.
import { describe, expect, it } from "vitest";
import type { ConfigDoc, MetricDoc, ToolDoc } from "../scripts/docgen/model";
import { renderConfig } from "../scripts/docgen/render-config";
import { renderMetrics } from "../scripts/docgen/render-metrics";
import { renderTools } from "../scripts/docgen/render-tools";

describe("renderConfig (THE-472)", () => {
  const config: ConfigDoc[] = [
    { path: "cacheDir", type: "string", default: ".obsidian-tc", optional: true },
    { path: "auth.mode", type: "enum(none|jwt)", default: "none", optional: true },
    { path: "vaults[].id", type: "string", optional: false },
  ];
  const md = renderConfig(config);

  it("groups keys under a section heading and renders a table", () => {
    expect(md).toContain("### `auth`");
    expect(md).toContain("| Key | Type | Default | Required | Description |");
    expect(md).toContain('| `auth.mode` | `enum(none\\|jwt)` | `"none"` |  |');
  });

  it("marks a required key and quotes a string default", () => {
    expect(md).toMatch(/`vaults\[\]\.id`.*\*\*yes\*\*/);
    expect(md).toContain('`".obsidian-tc"`');
  });

  it("sorts sections alphabetically", () => {
    expect(md.indexOf("### `auth`")).toBeLessThan(md.indexOf("### `cacheDir`"));
  });
});

describe("renderTools (THE-472)", () => {
  const tools: ToolDoc[] = [
    {
      name: "patch_note",
      description: "Anchored edit.",
      requiredScopes: ["write:notes"],
      tags: [],
      destructive: false,
      inputSchema: {},
    },
    {
      name: "read_note",
      description: "Read a note.",
      requiredScopes: ["read:notes"],
      tags: [],
      destructive: false,
      inputSchema: {},
    },
    {
      name: "reset_vault_cache",
      description: "Drop cache.",
      requiredScopes: ["admin:vault"],
      tags: [],
      destructive: true,
      inputSchema: {},
    },
  ];
  const md = renderTools(tools);

  it("renders a complete table with a count line", () => {
    expect(md).toContain("3 tools");
    expect(md).toContain("| Tool | Access | Scopes | Description |");
  });

  it("classifies access from scopes + destructive flag", () => {
    expect(md).toMatch(/`patch_note` \| write \| `write:notes`/);
    expect(md).toMatch(/`read_note` \| read \| `read:notes`/);
    expect(md).toMatch(/`reset_vault_cache` \| destructive \|/);
  });

  it("escapes pipes and newlines in descriptions", () => {
    const out = renderTools([
      {
        name: "x",
        description: "a | b\nc",
        requiredScopes: [],
        tags: [],
        destructive: false,
        inputSchema: {},
      },
    ]);
    expect(out).toContain("a \\| b c");
    expect(out).toContain("| `x` | read | — |");
  });

  it("escapes backslashes before pipes so a bare \\| cannot break the table (CodeQL)", () => {
    const out = renderTools([
      {
        name: "y",
        description: "a\\|b",
        requiredScopes: [],
        tags: [],
        destructive: false,
        inputSchema: {},
      },
    ]);
    // backslash -> \\  then pipe -> \|  ==> a\\\|b  (renders as literal  a\|b )
    expect(out).toContain("a\\\\\\|b");
  });
});

describe("renderMetrics (THE-595)", () => {
  const metrics: MetricDoc[] = [
    { name: "obsidian_tc_tool_calls_total", type: "counter", help: "Calls.", labels: ["vault"] },
    {
      name: "obsidian_tc_tool_duration_seconds",
      type: "histogram",
      help: "Duration.",
      labels: ["vault"],
      buckets: [0.1, 0.5, 1],
    },
    { name: "obsidian_tc_active_sessions", type: "gauge", help: "Sessions.", labels: [] },
  ];
  const md = renderMetrics(metrics);

  it("derives the catalog-shape summary from the actual counts", () => {
    expect(md).toContain("**1 counters, 1 histograms, 1 gauges**");
  });

  it("gives histograms a Buckets column carrying the real bounds, and no other type one", () => {
    expect(md).toContain("| Name | Labels | Buckets | Help |");
    expect(md).toMatch(/`obsidian_tc_tool_duration_seconds`.*\| 0\.1, 0\.5, 1 \|/);
    // Counters/gauges keep the original three-column shape — no stray "—" bucket column.
    expect(md).toContain("| Name | Labels | Help |");
  });

  it("renders '—' for a histogram with no bucket bounds instead of dropping the column", () => {
    const out = renderMetrics([
      { name: "obsidian_tc_x", type: "histogram", help: "H.", labels: [] },
    ]);
    expect(out).toMatch(/`obsidian_tc_x` \| — \| — \| H\. \|/);
  });
});
