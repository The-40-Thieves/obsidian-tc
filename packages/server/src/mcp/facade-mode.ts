// THE-1123: `FacadeMode`'s canonical home. Split out of facade.ts (which re-exports it, so every
// existing `import type { FacadeMode } from "./facade"` call site keeps compiling unchanged) so
// that mcp/registry/types.ts can name this type WITHOUT importing facade.ts — facade.ts imports
// FROM ./registry (TOOL_DOMAINS, ToolDefinition, ToolRegistry), and registry.ts imports FROM
// ./registry/types, so registry/types.ts -> facade.ts would be a real import cycle (registry/types
// -> facade -> registry -> registry/types), exactly the class check:boundaries
// (dependency-cruiser) rejects even for a type-only edge — see registry/types.ts's own use.
export type FacadeMode = "triad" | "domain" | "flat";

/** Which branch of the matcher decided. `no-client-name`: nothing to match against. `configured-
 *  override`: a `toolFacade.autoClients` key matched. `built-in-table`: a built-in key matched.
 *  `no-match`: a name was observed but nothing matched, so FALLBACK_FACADE_MODE applied. */
export type AutoFacadeRule =
  | "no-client-name"
  | "configured-override"
  | "built-in-table"
  | "no-match";

/**
 * Why `resolveAutoFacadeMode` chose what it chose — `toolFacade.explainAutoMode`'s payload. Lists
 * exactly the signals the matcher reads (the client's observed name, the operator's `autoClients`
 * keys, the built-in table's keys) and the rule that fired. Client tool-search support, tool count,
 * tags and `toolFacade.profile` are NOT inputs to the decision, so they are not here: the built-in
 * table encodes the tool-search judgment per client name (see the header above), nothing more.
 */
export interface AutoFacadeExplanation {
  mode: FacadeMode;
  rule: AutoFacadeRule;
  /** The table key (as written in the table) that matched; absent for the two fallback rules. */
  matchedKey?: string;
  /** The observed `clientInfo.name`; absent when none was observed. */
  clientName?: string;
  /** `toolFacade.autoClients` keys in match order (empty when unset). */
  configuredKeys: string[];
  /** The built-in table's keys in match order. */
  builtInKeys: string[];
  fallback: FacadeMode;
}
