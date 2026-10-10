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
 * A task-backed tool cannot be HITL-gated. The offload decision is made before registry dispatch,
 * and the confirmation round (the elicit token, the 2026-era state, the handler-side
 * `requireConfirmation`) runs INSIDE dispatch: an approved call would reach the worker without its
 * approval, and an unconfirmed one would fail a job instead of returning the elicitation round to the
 * caller who can answer it. Carrying the approval into the job would put a single-use confirmation
 * on a queue, which is a larger design than the one tool (`index_vault`) that opts in needs; a tool
 * that must be both is a decision to take deliberately, not to inherit.
 */
export function assertTaskAugmentableNotHitlGated(def: ToolDefinition): void {
  if (def.taskAugmentable !== true || !isHitlGated(def)) return;
  throw new Error(
    `tool ${def.name} is taskAugmentable and HITL-gated: its confirmation round runs inside dispatch, ` +
      "after the offload, so the approval would not reach the job (drop one of the two)",
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
