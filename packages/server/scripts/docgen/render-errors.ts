// docgen — error-catalog renderer (THE-470). ErrorDoc[] -> CommonMark: a one-line shape summary
// plus one table of every canonical error code.
//
// WHY THIS EXISTS: extract-errors.ts has worked and been tested since THE-471, but its output
// reached NOTHING. Its only consumer was build-model.ts, which writes JSON to stdout; the resulting
// docs-model.json is committed nowhere and invoked by no workflow. So 35 documented error codes —
// the ones every MCP client has to branch on — existed as a tested extractor feeding no surface.
// THE-470 framed the choice as "render it or delete the extractor". This renders it: an MCP
// server's error vocabulary is exactly the kind of fact a caller needs and cannot infer.
//
// Codes come from the `err` factory map in @the-40-thieves/obsidian-tc-shared, not from a
// hand-listed enum, so a code added there appears here on the next `docgen:render` and the drift
// gate fails until the page is regenerated.
import type { ErrorDoc } from "./model";

/** Markdown-table-safe cell. Escapes backslashes BEFORE pipes — reversing that order lets an
 *  inserted `\` combine with the escape it just added, which is the CodeQL finding render-metrics.ts
 *  and render-config.ts both carry a note about. Same helper shape as those two on purpose. */
function cell(v: string): string {
  return v.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").trim();
}

export function renderErrors(docs: ErrorDoc[]): string {
  const withHint = docs.filter((d) => d.recovery).length;
  return [
    `Every failure obsidian-tc returns carries one of these **${docs.length}** canonical codes, ` +
      `**${withHint}** of which ship a recovery hint. The code is the stable contract — branch on ` +
      "it rather than on the message, which is a human-readable default that may be replaced " +
      "with something more specific at the throw site.",
    "",
    // A blank Recovery cell is meaningful, not missing: the taxonomy declares `null` where no
    // hint would beat the message itself. Rendering an em dash says "considered and omitted"
    // rather than leaving a hole a reader would take for an oversight.
    "| Code | Default message | Recovery |",
    "|---|---|---|",
    ...docs.map(
      (d) =>
        `| \`${cell(d.code)}\` | ${cell(d.description ?? "")} | ${d.recovery ? cell(d.recovery) : "—"} |`,
    ),
  ]
    .join("\n")
    .trimEnd();
}
