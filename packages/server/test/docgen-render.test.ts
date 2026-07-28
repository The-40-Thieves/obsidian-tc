// docgen renderers (THE-472): DocsModel slices -> CommonMark. Structural assertions (not full golden
// files, which would churn as tools/config evolve); the drift gate (THE-476) pins the committed pages.
import { describe, expect, it } from "vitest";
import type { ConfigDoc, ErrorDoc, MetricDoc, ToolDoc } from "../scripts/docgen/model";
import { renderConfig } from "../scripts/docgen/render-config";
import { renderErrors } from "../scripts/docgen/render-errors";
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

describe("renderErrors (THE-470)", () => {
  const errors: ErrorDoc[] = [
    { code: "forbidden", description: "scope or ACL denied", recovery: "Re-authenticate." },
    // No `recovery` — the taxonomy declares `null` for codes where guidance would only restate
    // the message. That is a considered omission, and the renderer must SAY so rather than leave
    // a blank cell a reader would take for a gap.
    { code: "internal", description: "internal error" },
    // Pipes and backslashes in either column must not break the table. Escaping backslashes
    // AFTER pipes would let the inserted `\` pair with the one just added — the CodeQL finding
    // render-metrics.ts and render-config.ts both carry a note about.
    { code: "pipe_case", description: "a|b", recovery: "use \\ or |" },
  ];
  const md = renderErrors(errors);

  it("renders a three-column table with the code as a literal", () => {
    expect(md).toContain("| Code | Default message | Recovery |");
    expect(md).toContain("| `forbidden` | scope or ACL denied | Re-authenticate. |");
  });

  it("counts the codes AND how many carry a hint", () => {
    // The second number is the point: it distinguishes "no hint declared" from "hints missing",
    // which is exactly the ambiguity the em dash below resolves per-row.
    expect(md).toContain("**3**");
    expect(md).toMatch(/\*\*2\*\* of which ship a recovery hint/);
  });

  it("renders an em dash for a code with no declared hint", () => {
    expect(md).toContain("| `internal` | internal error | — |");
  });

  it("escapes pipes and backslashes so the table survives", () => {
    const row = md.split("\n").find((l) => l.startsWith("| `pipe_case`"));
    expect(row).toBeDefined();
    // Exactly three data cells — an unescaped pipe would split this into more.
    expect((row as string).split(" | ").length).toBe(3);
    expect(row).toContain("a\\|b");
    expect(row).toContain("\\\\");
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
