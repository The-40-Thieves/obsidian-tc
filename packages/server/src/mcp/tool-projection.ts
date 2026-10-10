import type { Tool } from "@modelcontextprotocol/server";
import { outputSchemaField, titleize, toInputJson } from "./facade";
import type { ToolDefinition } from "./registry";
import { MAX_RESULT_SIZE_META_FIELD, maxResultSizeChars } from "./result-size";
import { isAdvertisedDestructive, isMutatingDefinition } from "./tool-tags";

/**
 * Derive MCP tool annotations from the registry's OWN ground truth, so the client-visible safety
 * contract cannot drift from server-side enforcement. `readOnlyHint` mirrors the exact `mutating`
 * predicate the dispatch read-only kill-switch uses (registry.runDispatch); `destructiveHint`
 * mirrors `isAdvertisedDestructive` (THE-824: `def.destructive` OR the display-only
 * `conditionallyDestructive`, never a dispatch-authorizing field on its own — see its doc comment);
 * every vault operation is closed-world (no external side effects). Annotations are advisory
 * hints, never a trust boundary — dispatch still authorizes every call.
 */
function toolAnnotations(def: ToolDefinition): NonNullable<Tool["annotations"]> {
  const mutating = isMutatingDefinition(def);
  return {
    readOnlyHint: !mutating,
    destructiveHint: isAdvertisedDestructive(def),
    openWorldHint: false,
    // THE-743: the fourth annotation. Emitted ONLY for mutating tools, because the spec defines it
    // as meaningful only when `readOnlyHint == false` — sending it alongside `readOnlyHint: true`
    // would state a fact the spec says carries no information, and reads as a contradiction.
    // Sourced from an explicit per-tool declaration, never inferred: see ToolDefinition.idempotent
    // for why it is NOT `acceptsIdempotencyKey` and why every tool here is currently false.
    ...(mutating ? { idempotentHint: def.idempotent === true } : {}),
  };
}

// THE-463: a tool's MCP projection (name/title/description/schemas/annotations/icons) is immutable
// after registration; flat-mode tools/list rebuilt an identical object per request. Memoized by def
// identity — the frozen Tool instance survives per-request server churn (transports/http.ts) since
// defs live on the persistent registry. toJson/toInputJson are already memoized per schema.
const mcpToolMemo = new WeakMap<ToolDefinition, { tool: Tool; budget: number | undefined }>();

/** @internal exported for the THE-463 memoization test (re-exported from mcp/server.ts).
 *  `maxResponseBytes` is the registry's governor ceiling: a whole-note reader advertises it (capped
 *  at Claude Code's own ceiling) as `_meta["anthropic/maxResultSizeChars"]`. Omitted -> no key. A
 *  registry's ceiling never changes, so the memo only rebuilds when asked with another one. */
export function toMcpTool(def: ToolDefinition, maxResponseBytes?: number): Tool {
  const cached = mcpToolMemo.get(def);
  if (cached !== undefined && cached.budget === maxResponseBytes) return cached.tool;
  const tool: Tool = {
    name: def.name,
    title: titleize(def.name),
    description: def.description,
    inputSchema: toInputJson(def.inputSchema),
    ...outputSchemaField("outputSchema", def.outputSchema),
    annotations: toolAnnotations(def),
    ...(def.icons ? { icons: def.icons } : {}),
    ...(def.wholeNotes && maxResponseBytes !== undefined
      ? { _meta: { [MAX_RESULT_SIZE_META_FIELD]: maxResultSizeChars(maxResponseBytes) } }
      : {}),
  };
  Object.freeze(tool);
  mcpToolMemo.set(def, { tool, budget: maxResponseBytes });
  return tool;
}

const mcpToolNoOutputSchemaMemo = new WeakMap<
  ToolDefinition,
  { tool: Tool; budget: number | undefined }
>();

/** `toolFacade.outputSchema: "omit"`: the same projection minus `outputSchema`, memoized apart from
 *  `toMcpTool` so the default path's frozen objects are untouched. */
export function toMcpToolNoOutputSchema(def: ToolDefinition, maxResponseBytes?: number): Tool {
  const cached = mcpToolNoOutputSchemaMemo.get(def);
  if (cached !== undefined && cached.budget === maxResponseBytes) return cached.tool;
  const { outputSchema: _omitted, ...rest } = toMcpTool(def, maxResponseBytes);
  const tool: Tool = Object.freeze(rest);
  mcpToolNoOutputSchemaMemo.set(def, { tool, budget: maxResponseBytes });
  return tool;
}

/** The tools/list projection for a server: `outputSchema` per config, and the registry's byte
 *  ceiling threaded in so a whole-note reader advertises `anthropic/maxResultSizeChars`. */
export const projectTool =
  (outputSchema: "full" | "omit" | undefined, maxResponseBytes: number) =>
  (def: ToolDefinition): Tool =>
    outputSchema === "omit"
      ? toMcpToolNoOutputSchema(def, maxResponseBytes)
      : toMcpTool(def, maxResponseBytes);
