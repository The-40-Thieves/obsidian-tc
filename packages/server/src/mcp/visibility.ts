import {
  grantsScope,
  isMutatingScope,
  type ToolVisibilityConfig,
} from "@the-40-thieves/obsidian-tc-shared";

// Tool-visibility scoping. A pure verdict layer over the Registry.listVisible() / dispatch
// chokepoints: it never mutates the registry, it only classifies a tool.
//
// Two layers compose over ONE chokepoint and ONE verdict, never duplicated:
//   - STATIC-CONFIG (THE-219): the per-server `toolVisibility` block.
//   - PER-CALLER (THE-250): the caller's granted ACL scopes + read-only flag.
// Both feed `visibilityOf` with a single precedence `disabled > hidden > scope_denied >
// listed`, so a tool is offered to a caller only when the config lists it AND the caller
// can dispatch it. Omitting the caller (a full `*` grant) collapses to the static layer.

export type Visibility = "listed" | "hidden" | "disabled" | "scope_denied";

// The minimum a tool must expose to be classified. A ToolDefinition is structurally
// assignable to this, so the registry passes its definitions straight through.
export interface VisibilityTarget {
  name: string;
  tags?: readonly string[];
  requiredScopes: readonly string[];
}

// The per-caller dimension (THE-250): the caller's resolved grant from dispatch's auth
// layer. `grantedScopes` honors the `*` family/global wildcards via grantsAll; `readOnly`
// is the caller's ACL read-only flag (drops mutating tools just as dispatch would).
export interface VisibilityCaller {
  grantedScopes: Iterable<string>;
  readOnly?: boolean;
}

// The default config — every tool is listed. Used when no `toolVisibility` block is set,
// so the absent-config path and an explicit empty block behave identically (ALLOW_ALL).
export const ALLOW_ALL: ToolVisibilityConfig = {
  hidden: [],
  disabled: [],
  hiddenTags: [],
  disabledTags: [],
  requireReadOnly: false,
};

// The tag that matched, not merely whether one did — `explainVisibility` reports it, and a
// boolean cannot. `visibilityOf` ignores the value, so the two stay one derivation.
function matchingTag(tags: readonly string[] | undefined, set: readonly string[]): string | null {
  if (!tags || tags.length === 0 || set.length === 0) return null;
  return tags.find((t) => set.includes(t)) ?? null;
}

function isMutating(target: VisibilityTarget): boolean {
  return target.requiredScopes.some(isMutatingScope);
}

// A tool is scope-denied for a caller it could not dispatch: it lacks one of the tool's
// required scopes, or the caller's ACL is read-only and the tool mutates. These are the
// same checks dispatch authorizes with, so the advertised surface never lists an
// undispatchable tool (least-privilege; no enumeration of denied capability).
//
// THE-645 item 2 — WHICH rule produced the verdict. `inspect_visibility` needs this to answer
// "why can't this client see that tool", and an operator-facing answer of "hidden" is not an
// answer. Kept in this module, and made the SINGLE derivation that `visibilityOf` delegates to,
// so an explanation can never disagree with the verdict the registry actually enforces —
// two copies of these predicates would drift, and silently.
export type VisibilityReason =
  | "listed"
  | "disabled_name"
  | "disabled_tag"
  | "hidden_name"
  | "hidden_tag"
  | "hidden_require_read_only"
  | "hidden_not_allowlisted"
  | "scope_denied_missing_scope"
  | "scope_denied_read_only";

export interface VisibilityExplanation {
  visibility: Visibility;
  reason: VisibilityReason;
  /** The tag that matched `hiddenTags` / `disabledTags`, when the reason is a `*_tag` one. */
  matchedTag: string | null;
  /** Required scopes the caller does NOT hold. Only populated for `scope_denied_missing_scope`. */
  missingScopes: readonly string[];
}

/**
 * Classify one tool AND report which rule decided it. Precedence is unchanged and is asserted
 * here rather than restated: `disabled > hidden > scope_denied > listed`.
 */
export function explainVisibility(
  target: VisibilityTarget,
  config: ToolVisibilityConfig = ALLOW_ALL,
  caller?: VisibilityCaller,
): VisibilityExplanation {
  const base = { matchedTag: null, missingScopes: [] as readonly string[] };

  if (config.disabled.includes(target.name))
    return { ...base, visibility: "disabled", reason: "disabled_name" };
  const disabledTag = matchingTag(target.tags, config.disabledTags);
  if (disabledTag !== null)
    return { ...base, visibility: "disabled", reason: "disabled_tag", matchedTag: disabledTag };

  if (config.hidden.includes(target.name))
    return { ...base, visibility: "hidden", reason: "hidden_name" };
  const hiddenTag = matchingTag(target.tags, config.hiddenTags);
  if (hiddenTag !== null)
    return { ...base, visibility: "hidden", reason: "hidden_tag", matchedTag: hiddenTag };
  if (config.requireReadOnly && isMutating(target))
    return { ...base, visibility: "hidden", reason: "hidden_require_read_only" };
  if (config.allowed !== undefined && !config.allowed.includes(target.name))
    return { ...base, visibility: "hidden", reason: "hidden_not_allowlisted" };

  if (caller) {
    // Report every missing scope, not just the first — an operator fixing a grant wants the
    // whole delta, and `grantsAll` is an AND that discards which conjunct failed.
    const granted = new Set(caller.grantedScopes);
    const missing = target.requiredScopes.filter((s) => !grantsScope(granted, s));
    if (missing.length > 0)
      return {
        ...base,
        visibility: "scope_denied",
        reason: "scope_denied_missing_scope",
        missingScopes: missing,
      };
    if (caller.readOnly === true && isMutating(target))
      return { ...base, visibility: "scope_denied", reason: "scope_denied_read_only" };
  }

  return { ...base, visibility: "listed", reason: "listed" };
}

// Classify one tool against the static config and (optionally) a caller. Precedence is
// `disabled > hidden > scope_denied > listed`: an explicit disable wins, then any hide
// rule, then a caller that cannot dispatch the tool, otherwise it is listed.
//   - disabled: name in `disabled`, or a tag in `disabledTags`.
//   - hidden:   name in `hidden`, a tag in `hiddenTags`, a mutating tool under
//               `requireReadOnly`, or (when `allowed` is set) a name absent from it.
//   - scope_denied (only when `caller` is given): the caller lacks the tool's required
//     scopes, or is read-only and the tool mutates. Omitting `caller` (full grant) skips it.
export function visibilityOf(
  target: VisibilityTarget,
  config: ToolVisibilityConfig = ALLOW_ALL,
  caller?: VisibilityCaller,
): Visibility {
  return explainVisibility(target, config, caller).visibility;
}

// True when the tool appears in tools/list for this caller (verdict `listed`). With no
// caller (a full grant) only the static config gates.
export function isListed(
  target: VisibilityTarget,
  config?: ToolVisibilityConfig,
  caller?: VisibilityCaller,
): boolean {
  return visibilityOf(target, config, caller) === "listed";
}

// True when the tool is administratively disabled (rejected at dispatch). Caller-independent.
export function isDisabled(target: VisibilityTarget, config?: ToolVisibilityConfig): boolean {
  return visibilityOf(target, config) === "disabled";
}
