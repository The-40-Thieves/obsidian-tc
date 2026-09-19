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
 *  prettified line(s) — `accepted: a, b, c` (+ a did-you-mean/alias suggestion), or the vault hint
 *  above for the one issue naming the failed vault argument (`details.vault_hint_path`, set by
 *  vaultFailureHint). Looked up by the issue's OWN PATH, not its code — `details.accepted_keys` is
 *  keyed by path (input-binding.ts's `unrecognizedKeyHints`) so this one lookup covers both an
 *  `unrecognized_keys` issue and a bad-discriminator `invalid_union` issue (fix round 1, U1)
 *  without needing to know which. Reads only structured `details` fields
 *  parseInput/vaultFailureHint already computed. */
function issueHint(
  issue: z.core.$ZodIssue,
  details: Record<string, unknown> | undefined,
): string | undefined {
  const pathKey = issue.path.map(String).join(".");
  const accepted = (details?.accepted_keys as Record<string, string[]> | undefined)?.[pathKey];
  if (accepted) {
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
 *  per issue, THE-823's cap unchanged. A single issue's OWN text is byte-identical either way, but
 *  the MULTI-issue ORDER is not (fix round 1, R1, corrects an earlier false claim here):
 *  `z.prettifyError` sorts a batch by path length (a top-level `unrecognized_keys`, `path: []`,
 *  used to render FIRST), while this renders in the array's own order — the order `def.inputSchema`
 *  raised the issues in. The rendered SET is unchanged, only the order; pinned by test so a later
 *  change to either is deliberate (validation-error-hints.test.ts, the 5-issue-cap case). */
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

/** THE-1082 (GH #945): the text-channel rendering of an `elicit_required` error's token path.
 *  `mcp/server.ts`'s modern SEP-2260 `inputRequired` round trip (`isModern && opts.elicitCodec &&
 *  canElicit`) never reaches this — it intercepts `elicit_required` before `errorToResult` runs.
 *  Every OTHER caller (any 2025-era client, or a modern one with no elicitation capability — e.g.
 *  Claude Code over stdio) falls through to `errorToResult`, and per THE-823 that caller drops
 *  `structuredContent` on an isError result, so `args_hash` (already there — #931/THE-1037 made
 *  `call_capability` accept a redeemed token) is otherwise stranded where nothing reads it. This
 *  renders the actual `obsidian-tc elicit` invocation (cli/commands/elicit-mint.ts, flags per
 *  cli/usage.ts) rather than describing it, so a caller with no MCP elicitation support can still
 *  clear the gate. `tool`/`vault` are omitted (not placeholder text) when absent from `details` —
 *  today that's dispatch.ts's OWN `elicit_required` throw for an always-gated (`destructive:true`)
 *  tool, which carries only `args_hash`; hitl.ts's conditional-HITL throw carries all three. */
function renderElicitInstruction(details: Record<string, unknown> | undefined): string | undefined {
  const hash = details?.args_hash;
  if (typeof hash !== "string") return undefined;
  const tool = details?.tool;
  const vault = details?.vault;
  const toolFlag = typeof tool === "string" ? ` --tool ${tool}` : "";
  const vaultFlag = typeof vault === "string" ? ` --vault ${vault}` : "";
  return (
    `confirm with: obsidian-tc elicit --config <path to your config> --hash ${hash}${toolFlag}${vaultFlag}\n` +
    "then retry the same call with elicit_token: <token>"
  );
}

/** The offending-field detail to append after an error's headline sentence, or undefined when
 *  `details` carries nothing this can render (e.g. no `issues` array). THE-1042 (GH #935):
 *  `vault_not_found` carries no `issues` (it's thrown directly, not from a Zod parse) — the same
 *  visible_vaults/did_you_mean fields rendered inline for a validation issue above render here as
 *  the error's entire detail line. THE-1082 (GH #945): `elicit_required` gets its own instruction
 *  block (above) instead — it has neither `issues` nor a vault hint to fall through to. */
export function formatErrorDetail(error: ErrorJSON): string | undefined {
  if (error.code === "elicit_required") return renderElicitInstruction(error.details);
  const issues = error.details?.issues;
  return Array.isArray(issues) && issues.length > 0
    ? renderIssues(issues as z.core.$ZodIssue[], error.details)
    : renderVaultHint(error.details);
}
