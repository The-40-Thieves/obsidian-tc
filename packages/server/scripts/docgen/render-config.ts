// docgen — config renderer (THE-472). ConfigDoc[] -> CommonMark. Groups keys by their top-level
// section and emits one table per section (Key | Type | Default | Required | Description). Pure and
// deterministic; the same output feeds the Astro site, README injection, and the wiki.
import type { ConfigDoc } from "./model";

/** The section a dotted/array path belongs to: the first segment before a "." or "[". */
function sectionOf(path: string): string {
  const m = /^[^.[]+/.exec(path);
  return m ? m[0] : path;
}

/** Markdown-table-safe cell: collapse newlines, escape pipes. */
function cell(v: string): string {
  return v.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function fmtDefault(d: ConfigDoc): string {
  if (!("default" in d)) return "—";
  const v = d.default;
  if (v === undefined) return "—";
  if (typeof v === "string") return `\`"${v}"\``;
  return `\`${JSON.stringify(v)}\``;
}

/** Render the configuration reference: a table per top-level section, sections sorted by name. */
export function renderConfig(config: ConfigDoc[]): string {
  const bySection = new Map<string, ConfigDoc[]>();
  for (const d of config) {
    const s = sectionOf(d.path);
    (bySection.get(s) ?? bySection.set(s, []).get(s) ?? []).push(d);
  }
  const sections = [...bySection.keys()].sort((a, b) => a.localeCompare(b));
  const parts: string[] = [];
  for (const s of sections) {
    const rows = (bySection.get(s) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
    parts.push(`### \`${s}\`\n`);
    parts.push("| Key | Type | Default | Required | Description |");
    parts.push("|---|---|---|---|---|");
    for (const d of rows) {
      parts.push(
        `| \`${cell(d.path)}\` | \`${cell(d.type)}\` | ${fmtDefault(d)} | ${
          d.optional ? "" : "**yes**"
        } | ${cell(d.description ?? "")} |`,
      );
    }
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}
