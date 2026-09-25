// Extracted from server.ts (THE-1106 fix round 2 precedent: keep files under biome's
// noExcessiveLinesPerFile cap by moving a self-contained helper, not by trimming comments).
//
// THE-1098 (GH #964) established `capability_hidden` for describe_capability; THE-1131 reuses the
// same envelope for call_capability AND direct-name dispatch, and adds the one reason
// (`disabled_by_profile`) whose message names a config key rather than staying generic.
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ToolDefinition } from "./registry";
import {
  disclosableExplanation,
  type EffectiveToolVisibilityConfig,
  type VisibilityCaller,
  type VisibilityExplanation,
} from "./visibility";

// Every reason gets the plain "hidden by server policy" phrasing except `disabled_by_profile`,
// which names the config key so a caller can act on it directly — disclosable specifically
// because the config key is not a secret (see visibility.ts's DISCLOSABLE_HIDDEN_REASONS).
function capabilityHiddenMessage(name: string, reason: VisibilityExplanation["reason"]): string {
  return reason === "disabled_by_profile"
    ? `capability hidden by toolFacade.profile ("core"); set toolFacade.profile: "full" to enable ${name}`
    : `capability hidden by server policy: ${name}`;
}

export function capabilityHiddenResult(
  name: string,
  explanation: VisibilityExplanation,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "capability_hidden",
          message: capabilityHiddenMessage(name, explanation.reason),
          reason: explanation.reason,
        }),
      },
    ],
    isError: true,
  };
}

/** THE-1131 review round 2: the SAME disclosable-hidden check describe_capability/call_capability
 *  run, reusable at any dispatch boundary that resolves a tool by name — direct-name dispatch
 *  (flat mode, or any client that calls a tool by its own name) included, so "hidden" never reads
 *  as "absent" no matter which door a caller comes through. Returns null when `name` is either
 *  visible or non-disclosably hidden (existence-oracle-safe `not_found` stays the caller's path in
 *  that case, unchanged). */
export function capabilityHiddenCheck(
  name: string,
  registered: readonly ToolDefinition[],
  visibilityConfig: EffectiveToolVisibilityConfig,
  caller: VisibilityCaller,
): CallToolResult | null {
  const target = registered.find((d) => d.name === name);
  const explanation = target && disclosableExplanation(target, visibilityConfig, caller);
  return explanation ? capabilityHiddenResult(name, explanation) : null;
}

/** Every registered tool `toolFacade.profile: "core"` currently hides FOR THIS CALLER — the set
 *  find_capability/the catalog resource/`instructions` all draw their "N more tools" disclosure
 *  from, so the three surfaces can never disagree about the count. */
export function profileHiddenTools(
  registered: readonly ToolDefinition[],
  visibilityConfig: EffectiveToolVisibilityConfig,
  caller: VisibilityCaller,
): ToolDefinition[] {
  return registered.filter(
    (d) => disclosableExplanation(d, visibilityConfig, caller)?.reason === "disabled_by_profile",
  );
}
