// Result-size budgets that are about CLIENTS, not about the server's own hard ceiling
// (`governor.maxResponseBytes`, registry/result-governance.ts, which refuses an oversized result).
//
//   - Grok Build inlines at most ~20 KB of a tool result and drops `resource_link` blocks;
//   - claude.ai keeps ~150k characters per result;
//   - Claude Code saves any text result over 50,000 characters to a file and replaces it with a
//     pointer, unless the tool's `tools/list` entry carries `_meta["anthropic/maxResultSizeChars"]`,
//     which raises that tool's threshold to the annotated value up to a hard ceiling of 500,000
//     (code.claude.com/docs/en/mcp, "Raise the limit for a specific tool").
//
// So a list/search tool keeps its DEFAULT page under DEFAULT_PAGE_BYTES (item counts are lowered,
// never a result cut mid-item), and a tool that exists to return whole notes advertises the key.

/** Target ceiling for one default page of a list/search tool. Not a config knob: it is the smallest
 *  inline limit among the clients above, and result-size-budget.test.ts holds every list/search
 *  tool's default response to it on a large generated vault. */
export const DEFAULT_PAGE_BYTES = 20_000;

/** The `_meta` key Claude Code reads from a tool's `tools/list` entry. */
export const MAX_RESULT_SIZE_META_FIELD = "anthropic/maxResultSizeChars";

/** Claude Code's hard ceiling for the annotation; a larger value is clamped there, not honoured. */
export const CLAUDE_CODE_MAX_RESULT_SIZE_CEILING = 500_000;

/**
 * The value a whole-note reader advertises: the governor's byte ceiling, capped at Claude Code's.
 * A character is at least one byte, so a result the governor admits (<= `maxResponseBytes` bytes)
 * never has more characters than that, and advertising the ceiling can never promise more room
 * than the governor lets through.
 */
export function maxResultSizeChars(maxResponseBytes: number): number {
  return Math.min(maxResponseBytes, CLAUDE_CODE_MAX_RESULT_SIZE_CEILING);
}
