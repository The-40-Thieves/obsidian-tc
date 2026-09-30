// docgen — tools renderer (THE-472). ToolDoc[] -> CommonMark. Emits a single sorted reference table
// (Tool | Access | Profile | Scopes | Description) dense enough for the wiki, and
// complete: every registered tool appears, so the write surface can never silently drop out of the
// docs. THE-1131: the Profile column is generated FROM tool-profiles.ts (the single source of
// truth every other profile-aware gate reads), never hand-marked — a tool moved between profiles
// updates this table on the next `docgen:render`, not by someone remembering to edit prose.
import { isNonCoreTool } from "../../src/mcp/tool-profiles";
import type { ToolDoc } from "./model";
import { toolPageSlug } from "./tool-page-slug";

// Escape backslashes THEN pipes (order matters — a bare `\|` must not become an unescaped pipe that
// breaks the markdown table).
export function cell(v: string): string {
  return v.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").trim();
}

/** Coarse access label from scopes + the destructive flag, for an at-a-glance column. */
export function access(t: ToolDoc): string {
  if (t.destructive) return "destructive";
  const mutating = t.requiredScopes.some((s) => /^(write|admin|delete|bulk|execute):/.test(s));
  return mutating ? "write" : "read";
}

/** "full only" for the tools `toolFacade.profile: "core"` hides; "core, full" (visible/callable
 *  under both) otherwise. */
export function profileCell(name: string): string {
  return isNonCoreTool(name) ? "full only" : "core, full";
}

function nameCell(name: string, pageLinkBase: string | undefined): string {
  const code = `\`${cell(name)}\``;
  return pageLinkBase === undefined ? code : `[${code}](${pageLinkBase}${toolPageSlug(name)}/)`;
}

/** Render the tool reference table (tools sorted by name). With `pageLinkBase` (a URL prefix ending
 *  in `/`) each name links to its generated per-tool page at `<base><name>/`. */
export function renderTools(tools: ToolDoc[], pageLinkBase?: string): string {
  const rows = tools.slice().sort((a, b) => a.name.localeCompare(b.name));
  const parts: string[] = [
    `_${rows.length} tools. Access is a coarse hint; the required scopes are authoritative. Profile ` +
      "is which `toolFacade.profile` value(s) make the tool visible/callable — see [Tool profile](https://obsidian-tc.the40thieves.io/tools/#tool-profile)._",
    "",
    "| Tool | Access | Profile | Scopes | Description |",
    "|---|---|---|---|---|",
  ];
  for (const t of rows) {
    const scopes =
      t.requiredScopes.length > 0 ? t.requiredScopes.map((s) => `\`${s}\``).join(", ") : "—";
    parts.push(
      `| ${nameCell(t.name, pageLinkBase)} | ${access(t)} | ${profileCell(t.name)} | ${scopes} | ${cell(t.description)} |`,
    );
  }
  return parts.join("\n");
}
