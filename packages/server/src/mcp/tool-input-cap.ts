import type { CallToolResult } from "@modelcontextprotocol/server";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { errorToCallToolResult } from "./error-rendering";

/**
 * Upper bound on the array elements plus object members in one `tools/call`'s arguments.
 *
 * The SDK's own `maxToolInputElements` lives on `McpServer`, which this server does not use: it is
 * built on the low-level `Server` with `setRequestHandler("tools/call", ...)`, so the SDK option has
 * no plug-in point here and the same guard is applied in that handler instead, with the SDK's
 * counting rule (each array element and each own object key counts once, nested values included).
 *
 * The value is set by measurement, not guessed. Over every registered tool's input schema (180 of
 * them), the worst case a SCHEMA-BOUNDED tool can legitimately send is 509 elements
 * (`bulk_set_property`: 500 paths plus its own members); the batch readers are 105
 * (`read_notes`) and 104 (`read_resources`), the patch tools 14 to 15. The tools whose schemas carry
 * no bound (canvas nodes, excalidraw elements, frontmatter maps, `bulk_create_notes` item bodies)
 * are limited only by the request body, which the SDK caps at 4 MiB, so this cap sits ~980x above
 * the bounded maximum and well past what a drawing that fits in 4 MiB plausibly carries, while
 * cutting off the pathological `[1,1,1,...]` body (up to ~2M elements in 4 MiB) before the schema
 * validator walks it.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 500_000;

/** Iterative so a deeply nested value cannot overflow the stack; stops once `max` is exceeded. */
export function toolInputElementCount(value: unknown, max: number): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      if (++count > max) return count;
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
  return count;
}

/** The refusal for an over-cap call, or `null` when the arguments are within the cap. */
export function oversizedToolInput(
  toolName: string,
  args: unknown,
  max: number = MAX_TOOL_INPUT_ELEMENTS,
): CallToolResult | null {
  if (toolInputElementCount(args, max) <= max) return null;
  return errorToCallToolResult(
    err
      .validation(
        `Invalid arguments for tool ${toolName}: arguments contain more than the maximum of ${max} elements`,
        { tool: toolName, max_elements: max },
      )
      .toJSON(),
  );
}
