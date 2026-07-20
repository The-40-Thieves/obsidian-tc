// docgen — tools renderer (THE-472). ToolDoc[] -> CommonMark. Emits a single sorted reference table
// (Tool | Access | Scopes | Description) dense enough for the wiki + README, and complete: every
// registered tool appears, so the write surface can never silently drop out of the docs.
import type { ToolDoc } from "./model";

// Escape backslashes THEN pipes (order matters — a bare `\|` must not become an unescaped pipe that
// breaks the markdown table).
function cell(v: string): string {
  return v.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").trim();
}

/** Coarse access label from scopes + the destructive flag, for an at-a-glance column. */
function access(t: ToolDoc): string {
  if (t.destructive) return "destructive";
  const mutating = t.requiredScopes.some((s) => /^(write|admin|delete|bulk|execute):/.test(s));
  return mutating ? "write" : "read";
}

/** Render the tool reference table (tools sorted by name). */
export function renderTools(tools: ToolDoc[]): string {
  const rows = tools.slice().sort((a, b) => a.name.localeCompare(b.name));
  const parts: string[] = [
    `_${rows.length} tools. Access is a coarse hint; the required scopes are authoritative._`,
    "",
    "| Tool | Access | Scopes | Description |",
    "|---|---|---|---|",
  ];
  for (const t of rows) {
    const scopes =
      t.requiredScopes.length > 0 ? t.requiredScopes.map((s) => `\`${s}\``).join(", ") : "—";
    parts.push(`| \`${cell(t.name)}\` | ${access(t)} | ${scopes} | ${cell(t.description)} |`);
  }
  return parts.join("\n");
}
