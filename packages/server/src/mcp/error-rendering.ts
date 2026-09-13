// THE-823 + THE-1042 (GH #935): the text-channel rendering of a dispatch error's `details`, split
// out of mcp/server.ts (biome's 700-line noExcessiveLinesPerFile) rather than left inline — this
// module has no dependency on the rest of server.ts, so the split adds no circular import.
import type { ErrorJSON } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";

// THE-823: real MCP clients drop `structuredContent` on an isError result and render the text block
// alone, so `details.issues` (the Zod issue array `err.validation` / parseInput attach — see
// registry/input-binding.ts) has to reach the caller through TEXT, not just structuredContent, or a
// caller sees "input validation failed" with nothing to act on. Capped at MAX_RENDERED_ISSUES so a
// schema with a large issue list (e.g. many missing required fields) cannot produce an unbounded
// text block; the rest are counted, not dropped silently.
const MAX_RENDERED_ISSUES = 5;

/** THE-1042 (GH #935): `did you mean "X"?` when `vaultFailureHint` (registry/input-binding.ts)
 *  found a case-fold/slug match against a visible vault id, else the caller's visible vault ids —
 *  the two renderings the ticket asks for. Shared by the `validation_error` path below (spliced
 *  onto the one issue naming the vault argument) and `formatErrorDetail`'s `vault_not_found`
 *  fallback, which has no `issues` array to splice a line onto. Reads ONLY the structured fields
 *  vaultFailureHint already computed — never recomputes a suggestion here. */
function renderVaultHint(details: Record<string, unknown> | undefined): string | undefined {
  const didYouMean = details?.did_you_mean;
  if (typeof didYouMean === "string") return `vault: did you mean "${didYouMean}"?`;
  const visible = details?.visible_vaults;
  return Array.isArray(visible) && visible.length > 0
    ? `visible vaults: ${visible.join(", ")}`
    : undefined;
}

/** THE-1042 (GH #935): the one extra line `renderIssues` may append after a single issue's own
 *  prettified line(s) — `accepted: a, b, c` (+ a did-you-mean/alias suggestion) for
 *  `unrecognized_keys`, or the vault hint above for the one issue naming the failed vault argument
 *  (`details.vault_hint_path`, set by vaultFailureHint). Reads only structured `details` fields
 *  parseInput/vaultFailureHint already computed. */
function issueHint(
  issue: z.core.$ZodIssue,
  details: Record<string, unknown> | undefined,
): string | undefined {
  if (issue.code === "unrecognized_keys") {
    const pathKey = issue.path.map(String).join(".");
    const accepted = (details?.accepted_keys as Record<string, string[]> | undefined)?.[pathKey];
    if (!accepted) return undefined;
    const hints = (details?.key_hints as Record<string, Record<string, string>> | undefined)?.[
      pathKey
    ];
    const suggestion =
      hints && Object.keys(hints).length > 0
        ? ` — did you mean ${Object.entries(hints)
            .map(([wrong, right]) => `"${right}" for "${wrong}"`)
            .join(", ")}?`
        : "";
    return `accepted: ${accepted.join(", ")}${suggestion}`;
  }
  const vaultHintPath = details?.vault_hint_path;
  return typeof vaultHintPath === "string" &&
    issue.path.length === 1 &&
    issue.path[0] === vaultHintPath
    ? renderVaultHint(details)
    : undefined;
}

/** Render a capped slice of Zod issues into a human-readable, field-naming string, each issue
 *  rendered on its own (not batched through one `z.prettifyError` call, as before THE-1042) so a
 *  fix hint (issueHint above) can be spliced onto the issue it belongs to — at most one extra line
 *  per issue, THE-823's cap unchanged. `z.prettifyError` renders a lone issue identically to how it
 *  renders that same issue inside a batch, so this changes no existing text besides the splice. */
function renderIssues(
  issues: readonly z.core.$ZodIssue[],
  details?: Record<string, unknown>,
): string {
  const capped = issues.slice(0, MAX_RENDERED_ISSUES);
  const blocks = capped.map((issue) => {
    const base = z.prettifyError(new z.ZodError([issue] as z.core.$ZodIssue[]));
    const extra = issueHint(issue, details);
    return extra ? `${base}\n  ${extra}` : base;
  });
  const omitted = issues.length - capped.length;
  const rendered = blocks.join("\n");
  return omitted > 0 ? `${rendered}\n…and ${omitted} more` : rendered;
}

/** The offending-field detail to append after an error's headline sentence, or undefined when
 *  `details` carries nothing this can render (e.g. no `issues` array). THE-1042 (GH #935):
 *  `vault_not_found` carries no `issues` (it's thrown directly, not from a Zod parse) — the same
 *  visible_vaults/did_you_mean fields rendered inline for a validation issue above render here as
 *  the error's entire detail line. */
export function formatErrorDetail(error: ErrorJSON): string | undefined {
  const issues = error.details?.issues;
  return Array.isArray(issues) && issues.length > 0
    ? renderIssues(issues as z.core.$ZodIssue[], error.details)
    : renderVaultHint(error.details);
}
