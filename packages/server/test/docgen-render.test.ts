// docgen renderers (THE-472): DocsModel slices -> CommonMark. Structural assertions (not full golden
// files, which would churn as tools/config evolve); the drift gate (THE-476) pins the committed pages.
import { describe, expect, it } from "vitest";
import type { ConfigDoc, ToolDoc } from "../scripts/docgen/model";
import { renderConfig } from "../scripts/docgen/render-config";
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
});
