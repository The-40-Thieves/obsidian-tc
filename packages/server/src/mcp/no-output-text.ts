// Leaf module: shared by the byte governor (registry/dispatch.ts) and the wire formatter
// (tool-result.ts), so the governor measures the text a payload-less success actually sends.

/** What a successful call with nothing to return says, in place of the literal `null`. */
export const NO_OUTPUT_TEXT = "OK: the tool completed and returned no data.";
