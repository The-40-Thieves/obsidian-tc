// THE-823 + THE-1042 (GH #935): the text-channel rendering of a dispatch error's `details`, split
// out of mcp/server.ts (biome's 700-line noExcessiveLinesPerFile) rather than left inline — this
// module has no dependency on the rest of server.ts, so the split adds no circular import.
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ErrorJSON } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { mintCommandFromDetails, shellQuote } from "./elicit-command";
import { sanitizeDisplayText } from "./elicit-form";

// THE-823: real MCP clients drop `structuredContent` on an isError result and render the text block
// alone, so `details.issues` (the Zod issue array `err.validation` / parseInput attach — see
// registry/input-binding.ts) has to reach the caller through TEXT, not just structuredContent, or a
// caller sees "input validation failed" with nothing to act on. Capped at MAX_RENDERED_ISSUES so a
// schema with a large issue list (e.g. many missing required fields) cannot produce an unbounded
// text block; the rest are counted, not dropped silently.
const MAX_RENDERED_ISSUES = 5;

/** The way out of a `frontmatter_yaml` refusal (vault/frontmatter.ts parseNote). */
const FRONTMATTER_REPAIR_HINT =
  "The note's frontmatter is not valid YAML. read_note returns its raw text (raw_frontmatter) and " +
  'the error location; update_frontmatter {operation: "replace", frontmatter_yaml: <corrected YAML ' +
  "without --- lines>, prev_hash: <content_hash>} repairs it without an approval prompt.";

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

/** THE-1082 (GH #945; fix round 2 per cross-vendor review) + THE-1106 (GH #967 part 3): the
 *  text-channel rendering of an `elicit_required` error's token path. `mcp/server.ts`'s
 *  `inputRequired` round trip (`opts.elicitCodec && canElicit && roundTripDeliverable` — native on
 *  a modern connection, or the SDK's own legacy shim on stdio) never reaches this — it intercepts
 *  `elicit_required` before `errorToResult` runs. Every OTHER caller (a client with no elicitation
 *  capability, or one whose round trip was declined/cancelled/failed) falls through to
 *  `errorToResult`, and per THE-823 that caller drops `structuredContent` on an isError result, so
 *  `args_hash` (already there — #931/THE-1037 made `call_capability` accept a redeemed token) is
 *  otherwise stranded where nothing reads it. This renders the actual `obsidian-tc elicit`
 *  invocation (cli/commands/elicit-mint.ts, flags per cli/usage.ts) rather than describing it, so
 *  a caller with no MCP elicitation support can still
 *  clear the gate.
 *
 *  THE-1106: the previous version handed an AGENT a bare command line and trusted it to notice a
 *  human had to run it. Filed report (GH #967 part 3): an agent reading only the command either
 *  minted the token itself (bypassing the human) or gave up. The text now LEADS with a directive
 *  sentence naming who decides ("ask the user now") and what the agent must not do ("do not mint
 *  the token without their explicit yes") — the command that follows is instructions for AFTER that
 *  yes, not a thing to run on its own judgment.
 *
 *  `--tool` is a HARD requirement of the CLI (`cli/args.ts`'s elicit parser throws a `CliError`
 *  without it) — both throw sites (hitl.ts, dispatch.ts) now always supply it, but if a THIRD one
 *  ever doesn't, this renders an explanation instead of an invocation that cannot succeed: a
 *  half-usable copy-pasted command that then fails on `--tool` is worse than an honest "can't".
 *  `--vault` is NOT a hard CLI requirement — `cli/args.ts` parses it as optional; `elicit-mint.ts`'s
 *  `planElicitMint` only demands it when more than one vault is configured — so it is rendered
 *  when present and simply omitted otherwise, same as before.
 *
 *  No `--config` flag is rendered at all: `<path to your config>` is not a value, and a client
 *  cannot fill in a real path here, so a literal `--config <path to your config>` is not just
 *  unquoted, it is not a rendered command at all — `<...>` is shell redirection syntax to a real
 *  shell. `resolveServeConfigWithProvenance` (cli/resolve-config.ts) falls back to
 *  `OBSIDIAN_TC_CONFIG` when no path is given, so that line states that real fallback instead of a
 *  fabricated "default location".
 *
 *  The `confirm with:` line itself is UNCHANGED byte-for-byte from before THE-1106 — only prefixed
 *  by the new directive paragraph and no longer followed by the old trailing "then retry..." line
 *  (its content now lives inside the directive sentence, which already names `elicit_token:
 *  <token>` — see test/error-rendering.test.ts, which locates this line by its own prefix rather
 *  than assuming it is first). */
function renderElicitInstruction(details: Record<string, unknown> | undefined): string | undefined {
  const hash = details?.args_hash;
  if (typeof hash !== "string") return undefined;
  const tool = details?.tool;
  // After an explicit decline (`dispatchToResult`'s `roundOutcome`, mcp/server.ts) the user already
  // said no: re-asking, or minting off the stale command, is the bypass this mechanism exists to
  // prevent, so there is no `confirm with:` line. A CANCEL is different: nobody answered, so
  // approval was not obtained and the out-of-band route below stays the way to get it.
  if (details?.reason === "approval_declined") {
    return "The user declined this change. Do not retry it and do not mint a token.";
  }
  const cancelled = details?.reason === "approval_not_obtained";
  const mintCondition = cancelled
    ? "Mint the token only after the user explicitly says yes."
    : "Do not mint the token without their explicit yes.";
  const notObtained = cancelled
    ? "Approval was not obtained: no answer to the confirmation prompt came back (it was " +
      "dismissed, could not be shown, or did not complete), so nothing was changed. This is not " +
      "a refusal.\n"
    : "";
  if (typeof tool !== "string") {
    return (
      "cannot render a confirm command: this error did not carry a tool name, and " +
      "`obsidian-tc elicit` requires --tool. Confirm from a client with MCP elicitation support " +
      `instead, or mint manually once you know the tool name, using args_hash ${shellQuote(hash)}.`
    );
  }
  // THE-1106 (MEDIUM/LOW 2, cross-vendor review — 2nd pass): `path` is UNTRUSTED display text — a
  // vault-relative `VaultPath` may legally contain a newline, backtick, or quote — so it is quoted
  // with `JSON.stringify` (after `sanitizeDisplayText`, ./elicit-form.ts, shared with the
  // `inputRequired` form message) rather than a hand-picked delimiter the value could itself
  // contain: the quoting cannot be forged by ANY character. Omitted when the error carried none.
  // `tool` is sanitized the same way defensively, though it is registry-derived, never caller data.
  const safeTool = sanitizeDisplayText(tool);
  const path = details?.path;
  const target = typeof path === "string" ? ` on ${JSON.stringify(sanitizeDisplayText(path))}` : "";
  return (
    notObtained +
    `This call needs the user's approval. Ask the user now whether to allow ${safeTool}${target}. ` +
    "If they approve, run the command below and retry the same call with elicit_token: <token>. " +
    `${mintCondition}\n` +
    `confirm with: ${mintCommandFromDetails(details)}\n` +
    "(reads OBSIDIAN_TC_CONFIG if set; otherwise add --config <path> or a vault/config path " +
    "positional argument)"
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
  // replay_drift has no field detail to render; clients show the text block alone, so the fix
  // (request a fresh confirmation, never resubmit the old token) has to be in it.
  if (error.code === "replay_drift") return error.recovery;
  // A refusal on a note whose frontmatter does not parse: name the way out. Keyed on the same
  // details.reason isFrontmatterYamlError reads, so every tool that parses a note shares it.
  if (error.code === "invalid_input" && error.details?.reason === "frontmatter_yaml")
    return FRONTMATTER_REPAIR_HINT;
  const issues = error.details?.issues;
  return Array.isArray(issues) && issues.length > 0
    ? renderIssues(issues as z.core.$ZodIssue[], error.details)
    : renderVaultHint(error.details);
}

// A dispatch failure is a Tool Execution Error, not a JSON-RPC protocol error (MCP 2025-11-25 /
// SEP-1303): return isError:true with a human-readable sentence AND the full error object as
// structuredContent, so a model can read what went wrong (e.g. the Zod issues) and self-correct
// rather than seeing an opaque JSON blob. THE-823: real clients discard structuredContent on
// isError and render the text block alone, so formatErrorDetail appends the offending-field
// detail (capped) to the text itself — see design note.
export function errorToCallToolResult(error: ErrorJSON): CallToolResult {
  const detail = formatErrorDetail(error);
  return {
    content: [
      {
        type: "text",
        text: `Error [${error.code}]: ${error.message}${error.retryable ? " (retryable)" : ""}${detail ? `\n${detail}` : ""}`,
      },
    ],
    structuredContent: error as unknown as Record<string, unknown>,
    isError: true,
  };
}
