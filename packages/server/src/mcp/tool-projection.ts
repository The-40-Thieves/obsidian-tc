import type { Tool } from "@modelcontextprotocol/server";
import { isMutatingScope } from "@the-40-thieves/obsidian-tc-shared";
import { isAdvertisedDestructive, titleize, toInputJson, toJson } from "./facade";
import type { ToolDefinition } from "./registry";

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
  const mutating = def.destructive === true || def.requiredScopes.some(isMutatingScope);
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
const mcpToolMemo = new WeakMap<ToolDefinition, Tool>();

/** @internal exported for the THE-463 memoization test (re-exported from mcp/server.ts). */
export function toMcpTool(def: ToolDefinition): Tool {
  const cached = mcpToolMemo.get(def);
  if (cached !== undefined) return cached;
  const tool: Tool = {
    name: def.name,
    title: titleize(def.name),
    description: def.description,
    inputSchema: toInputJson(def.inputSchema),
    ...(def.outputSchema
      ? { outputSchema: toJson(def.outputSchema) as unknown as Tool["outputSchema"] }
      : {}),
    annotations: toolAnnotations(def),
    ...(def.icons ? { icons: def.icons } : {}),
  };
  Object.freeze(tool);
  mcpToolMemo.set(def, tool);
  return tool;
}
