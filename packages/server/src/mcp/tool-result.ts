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

/** Decoded size of a base64 payload, without decoding it. */
const base64Bytes = (data: string): number =>
  Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

/**
 * Text that stands in for the non-text blocks of a result. Two client limits drive it: the Claude
 * API connector swaps an image for a text placeholder, and Grok Build drops `resource_link` blocks.
 * An image or audio block is described only when the result has no usable text at all (a sentence
 * beside it is already the answer); a link or embedded resource is described unless some text block
 * already carries its URI (and, for a blob, its media type), so a result that says it stays as is.
 */
function nonTextAlternatives(content: CallToolResult["content"], text: string, hasText: boolean) {
  const alts: string[] = [];
  for (const b of content) {
    if (b.type === "image" || b.type === "audio") {
      if (!hasText) alts.push(`[${b.type}: ${b.mimeType}, ${base64Bytes(b.data)} bytes]`);
    } else if (b.type === "resource_link") {
      if (!text.includes(b.uri)) alts.push(`[link: ${b.uri}]`);
    } else if (b.type === "resource") {
      const { uri, mimeType } = b.resource;
      const blob = "blob" in b.resource;
      if (!text.includes(uri) || (blob && mimeType && !text.includes(mimeType))) {
        alts.push(`[resource: ${uri}${blob && mimeType ? `, ${mimeType}` : ""}]`);
      }
    }
  }
  return alts;
}

/**
 * Guarantee a non-empty, self-contained text block. A result that already has one (every tool
 * today: the payload as JSON, or an `Error [code]: message` sentence) is returned UNCHANGED, so
 * nothing is doubled, unless it carries an image/audio/link/resource block the text never accounts
 * for (see nonTextAlternatives). Otherwise the structured payload is rendered as compact JSON (it
 * is the same object the byte governor already bounded, so the cap holds), and a result with
 * neither gets a plain sentence. Non-text blocks are kept. A result carrying a `resultType` other
 * than "complete" (a task handle, an input-required round) is a different message the client
 * switches on: untouched.
 */
export function ensureTextContent(result: CallToolResult): CallToolResult {
  const resultType = (result as { resultType?: unknown }).resultType;
  if (typeof resultType === "string" && resultType !== "complete") return result;
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content.flatMap((b) => (b.type === "text" ? [b.text] : []));
  const hasText = texts.some(isUsableText);
  // The structured payload becomes the text below, so it answers for an image beside it too.
  const alts = nonTextAlternatives(
    content,
    texts.join("\n"),
    hasText || result.structuredContent !== undefined,
  );
  if (hasText && alts.length === 0) return result;
  const lead =
    hasText || (alts.length > 0 && result.structuredContent === undefined)
      ? []
      : [
          result.structuredContent !== undefined
            ? JSON.stringify(result.structuredContent)
            : result.isError === true
              ? NO_DETAIL_ERROR_TEXT
              : NO_OUTPUT_TEXT,
        ];
  const textBlocks = content.filter((b) => b.type === "text");
  const rest = content.filter((b) => b.type !== "text");
  const added = [...lead, ...(alts.length > 0 ? [alts.join("\n")] : [])];
  return {
    ...result,
    content: [
      ...(hasText ? textBlocks : []),
      ...added.map((text) => ({ type: "text" as const, text })),
      ...rest,
    ],
  };
}
