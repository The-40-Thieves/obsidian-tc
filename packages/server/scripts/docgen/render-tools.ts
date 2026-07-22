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

/** Scope family (the part before the colon), e.g. "write:notes" -> "write". */
function family(scope: string): string {
  const i = scope.indexOf(":");
  return i > 0 ? scope.slice(0, i) : scope;
}

// Ordered so the narrative reads read -> write -> delete -> execute -> admin: increasing blast
// radius. Families outside this list are appended alphabetically rather than dropped, so a new
// scope family can never vanish from the summary.
const FAMILY_ORDER = ["read", "write", "delete", "bulk", "execute", "admin"];

/**
 * Compact capability summary for README / ARCHITECTURE (THE-473).
 *
 * The full reference (`renderTools`) is ~30KB — injecting it into a 260-line README would bury the
 * narrative it exists to support. This groups by scope family and names a few representative tools
 * per family instead.
 *
 * THE-469 is the reason the WRITE row names its tools explicitly: README mentioned none of the write
 * tools, so two external reviews concluded the write surface was "thin" with "no atomic heading
 * edits" — while `patch_note` has done heading- and block-anchored edits since THE-198. A count
 * alone would not have corrected that; the names are the fix.
 */
export function renderToolSummary(tools: ToolDoc[]): string {
  const byFamily = new Map<string, ToolDoc[]>();
  for (const t of tools) {
    // A tool with several scopes is filed under its highest-blast-radius family, so a write tool
    // that also reads is never counted as read-only.
    const fams = t.requiredScopes.map(family);
    const rank = (f: string): number => {
      const i = FAMILY_ORDER.indexOf(f);
      return i === -1 ? FAMILY_ORDER.length : i;
    };
    const primary = fams.length === 0 ? "read" : fams.reduce((a, b) => (rank(b) > rank(a) ? b : a));
    const list = byFamily.get(primary) ?? [];
    list.push(t);
    byFamily.set(primary, list);
  }

  const families = [...byFamily.keys()].sort((a, b) => {
    const ra = FAMILY_ORDER.indexOf(a);
    const rb = FAMILY_ORDER.indexOf(b);
    if (ra === -1 && rb === -1) return a.localeCompare(b);
    if (ra === -1) return 1;
    if (rb === -1) return -1;
    return ra - rb;
  });

  const rows = families.map((f) => {
    const list = (byFamily.get(f) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    // EVERY name, not a sample. An earlier version showed the 6 alphabetically-first per family,
    // which against the real surface omitted `patch_note` and `write_note` — precisely the tools
    // THE-469 found invisible in README. A summary that can silently drop the capability it exists
    // to surface is worse than no summary, so completeness beats brevity here. Names only (no
    // descriptions) keeps this ~2.5KB against the full reference's ~30KB.
    const names = list.map((t) => `\`${t.name}\``).join(", ");
    return `**${cell(f)}** (${list.length}) — ${cell(names)}`;
  });

  return [
    `**${tools.length} governed capabilities**, grouped by access scope.`,
    "",
    ...rows.flatMap((r) => [r, ""]),
  ].join("\n");
}
