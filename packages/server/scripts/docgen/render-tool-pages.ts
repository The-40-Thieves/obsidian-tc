// docgen — per-tool reference pages. ToolDoc -> one Starlight page each, generated at DOCS BUILD time
// (scripts/docgen/tool-pages.ts, run by `docs`'s build) into a gitignored directory. Nothing here is
// committed per tool: only the combined catalog is, and it links to these pages.

import type { ToolConfirmationDoc, ToolDoc } from "./model";
import { renderRowsTable, schemaRows } from "./render-schema-table";
import { access, profileCell } from "./render-tools";
import { TOOL_PAGES_URL_BASE, toolPageSlug } from "./tool-page-slug";

export { toolPageSlug };

const CATALOG_URL = "/tools/tool-catalog/";
const OUTPUT_MAX_ROWS = 30;
const OUTPUT_MAX_DEPTH = 2;

/** Escape a raw `<` outside code spans so prose like `<path>` is not swallowed as an HTML tag. */
function prose(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/</g, "&lt;")))
    .join("")
    .trim();
}

/** First sentence, capped, for the page's meta description. */
function summary(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const first = end === -1 ? flat : flat.slice(0, end + 1);
  return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}

const yesNo = (b: boolean): string => (b ? "yes" : "no");
const link = (name: string): string =>
  `[\`${name}\`](${TOOL_PAGES_URL_BASE}${toolPageSlug(name)}/)`;

function confirmationSection(c: ToolConfirmationDoc | undefined): string[] {
  if (!c) return [];
  const lines = ["## Confirmation (human in the loop)", ""];
  if (c.required === "never") {
    lines.push("No human confirmation is required to call this tool.");
    return lines;
  }
  lines.push(
    c.required === "always"
      ? "A single-use `elicit_token` (or a transport-verified confirmation) is required on every call."
      : "The handler asks for confirmation only when a call crosses a boundary (for example an overwrite, a folder-boundary crossing or a bulk-cost floor); other calls need none.",
    "",
  );
  const bind: Record<ToolConfirmationDoc["binds"][number], string> = {
    paths:
      "The confirmation binds to the vault paths the call names, which are also checked against the folder ACL.",
    state:
      "The confirmation binds to a fingerprint of the state being approved, so a confirmation given for since-changed state is refused with `replay_drift`.",
    arguments: "The effect is opaque, so the confirmation binds to the argument hash alone.",
  };
  for (const b of c.binds) lines.push(`- ${bind[b]}`);
  return lines;
}

function outputSection(tool: ToolDoc): string[] {
  const lines = ["## Output", ""];
  if (tool.outputSchema === undefined) {
    lines.push(
      "This tool does not advertise an output schema; results are returned as text content.",
    );
    return lines;
  }
  const rows = schemaRows(tool.outputSchema, { maxDepth: OUTPUT_MAX_DEPTH });
  if (rows.length === 0) {
    lines.push("The success payload is an object with no declared fields.");
    return lines;
  }
  const shown = rows.slice(0, OUTPUT_MAX_ROWS);
  lines.push(renderRowsTable(shown, false));
  if (rows.length > shown.length) {
    lines.push(
      "",
      `_${rows.length - shown.length} more field(s) not shown; \`describe_capability\` returns the full output schema._`,
    );
  }
  return lines;
}

/** The full page (frontmatter + body) for `tool`; `all` is the whole surface, for related tools. */
export function renderToolPage(tool: ToolDoc, all: ToolDoc[]): string {
  const params = schemaRows(tool.inputSchema);
  const related = all
    .filter((t) => t.domain !== undefined && t.domain === tool.domain && t.name !== tool.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  const scopes =
    tool.requiredScopes.length > 0 ? tool.requiredScopes.map((s) => `\`${s}\``).join(", ") : "none";
  const tags = tool.tags.length > 0 ? tool.tags.map((t) => `\`${t}\``).join(", ") : "none";
  const a = tool.annotations;

  const out = [
    "---",
    `title: ${JSON.stringify(tool.name)}`,
    `description: ${JSON.stringify(summary(tool.description))}`,
    "editUrl: false",
    "---",
    "",
    prose(tool.description),
    "",
    "| | |",
    "|---|---|",
    `| **Domain** | ${tool.domain ?? "—"} |`,
    `| **Scopes** | ${scopes} |`,
    `| **Access** | ${access(tool)} |`,
    `| **Tags** | ${tags} |`,
    `| **Profile** | ${profileCell(tool.name)} |`,
    "",
    "## Annotations",
    "",
    "| Annotation | Value |",
    "|---|---|",
    ...(a
      ? [
          `| Read-only | ${yesNo(a.readOnly)} |`,
          `| Destructive | ${yesNo(a.destructive)} |`,
          `| Idempotent | ${yesNo(a.idempotent)} |`,
        ]
      : []),
    `| Accepts an idempotency key | ${yesNo(tool.acceptsIdempotencyKey === true)} |`,
    "",
    "`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that",
    "asks for confirmation only on some calls.",
    "",
    ...confirmationSection(tool.confirmation),
    "",
    "## Input",
    "",
    params.length > 0 ? renderRowsTable(params, true) : "This tool takes no parameters.",
    "",
    ...outputSection(tool),
    "",
    "## Related tools",
    "",
    related.length > 0
      ? `Other tools in the \`${tool.domain}\` domain: ${related.map((t) => link(t.name)).join(", ")}.`
      : "No other tools share this domain.",
    "",
    `Back to the [tool catalog](${CATALOG_URL}).`,
    "",
  ];
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
