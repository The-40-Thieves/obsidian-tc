import { scopeRequiresHitl } from "@the-40-thieves/obsidian-tc-shared";
import type { ToolDefinition } from "./types";

/** Whether a definition is HITL-gated at registration time: always-destructive or HITL-floored
 *  scopes (dispatch's gate), or a conditional gate the handler raises itself, which its schema
 *  advertises as `elicit_token` (or `conditionallyDestructive`). */
export function isHitlGated(def: ToolDefinition): boolean {
  const shape = (def.inputSchema as { shape?: Record<string, unknown> }).shape;
  return (
    def.destructive === true ||
    def.conditionallyDestructive === true ||
    def.requiredScopes.some(scopeRequiresHitl) ||
    (shape !== undefined && "elicit_token" in shape)
  );
}

/**
 * A HITL confirmation approves a state, and replay_drift can only refuse a stale one if the tool
 * says what its state is. A gated tool with neither `pathAcl` nor `confirmationTargets` would bind
 * on args_hash alone without anyone having decided that, so it fails at registration instead.
 */
export function assertConfirmationTargetsDeclared(def: ToolDefinition): void {
  if (def.pathAcl || def.confirmationTargets !== undefined || !isHitlGated(def)) return;
  throw new Error(
    `tool ${def.name} is HITL-gated but declares neither pathAcl nor confirmationTargets ` +
      '(use confirmationTargets: "none" for an opaque effect)',
  );
}
