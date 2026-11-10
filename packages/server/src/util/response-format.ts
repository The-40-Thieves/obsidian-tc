// GH #1027: the one shared `response_format` parameter and its resolver. Every tool that returns
// more than an acknowledgement spreads `ResponseFormatInput` into its input schema and asks
// `resolveResponseFormat` once, so the precedence and the legacy alias live here and nowhere else.
//
// Both fields are optional with NO schema default: a default would make every call look like it
// named a format, which would defeat the config default below it in the precedence chain.
import type { ResponseFormat } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";

export type { ResponseFormat };

/** Spread into a tool's `z.object({...})`. `verbosity` is the pre-#1027 name (search tools,
 *  find_notes_by_property), kept so every existing caller is unchanged. */
export const ResponseFormatInput = {
  response_format: z
    .enum(["concise", "detailed"])
    .optional()
    .describe(
      "concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies.",
    ),
  verbosity: z
    .enum(["full", "terse"])
    .optional()
    .describe("Legacy alias for response_format: terse = concise, full = detailed."),
};

export interface ResponseFormatFields {
  response_format?: ResponseFormat | undefined;
  verbosity?: "full" | "terse" | undefined;
}

/** explicit response_format > legacy verbosity alias > the config default > "detailed". */
export function resolveResponseFormat(
  input: ResponseFormatFields,
  configDefault?: ResponseFormat,
): ResponseFormat {
  if (input.response_format !== undefined) return input.response_format;
  if (input.verbosity !== undefined) return input.verbosity === "terse" ? "concise" : "detailed";
  return configDefault ?? "detailed";
}
