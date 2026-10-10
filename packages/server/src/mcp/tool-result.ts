import type { CallToolResult } from "@modelcontextprotocol/server";
import { NO_OUTPUT_TEXT } from "./no-output-text";
import { takeSerialized } from "./registry";

export { NO_OUTPUT_TEXT };

// The one place a tools/call result is shaped for the wire. Several clients read ONLY the text
// block (Codex drops `content` whenever `structuredContent` is present; others render the text and
// never the structured half), so every result, success or error, must carry a text block that
// answers the call on its own, whichever handler, facade leg or guard produced it.

/** What a failed call with no detail at all says. */
export const NO_DETAIL_ERROR_TEXT = "Error: the tool call failed and returned no detail.";

/** The payload as the SDK carries it: a plain object is also `structuredContent`. */
export function toolDataResult(data: unknown): CallToolResult {
  const structuredContent =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  return {
    // THE-294: dispatch already serialized this exact object for the byte governor.
    content: [
      { type: "text", text: takeSerialized(data) ?? JSON.stringify(data ?? null) ?? "null" },
    ],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

const isUsableText = (text: string): boolean => text.trim() !== "" && text !== "null";

/**
 * Guarantee a non-empty, self-contained text block. A result that already has one (every tool
 * today: the payload as JSON, or an `Error [code]: message` sentence) is returned UNCHANGED, so
 * nothing is doubled. Otherwise the structured payload is rendered as compact JSON (it is the same
 * object the byte governor already bounded, so the cap holds), and a result with neither gets a
 * plain sentence. Non-text blocks are kept. A result carrying a `resultType` other than "complete"
 * (a task handle, an input-required round) is a different message the client switches on: untouched.
 */
export function ensureTextContent(result: CallToolResult): CallToolResult {
  const resultType = (result as { resultType?: unknown }).resultType;
  if (typeof resultType === "string" && resultType !== "complete") return result;
  const content = Array.isArray(result.content) ? result.content : [];
  if (content.some((b) => b.type === "text" && isUsableText(b.text))) return result;
  const text =
    result.structuredContent !== undefined
      ? JSON.stringify(result.structuredContent)
      : result.isError === true
        ? NO_DETAIL_ERROR_TEXT
        : NO_OUTPUT_TEXT;
  return {
    ...result,
    content: [{ type: "text", text }, ...content.filter((b) => b.type !== "text")],
  };
}
