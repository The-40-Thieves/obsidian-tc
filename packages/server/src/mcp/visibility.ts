import {
  grantsAll,
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

function intersects(tags: readonly string[] | undefined, set: readonly string[]): boolean {
  if (!tags || tags.length === 0 || set.length === 0) return false;
  return tags.some((t) => set.includes(t));
}

function isMutating(target: VisibilityTarget): boolean {
  return target.requiredScopes.some(isMutatingScope);
}

// A tool is scope-denied for a caller it could not dispatch: it lacks one of the tool's
// required scopes, or the caller's ACL is read-only and the tool mutates. These are the
// same checks dispatch authorizes with, so the advertised surface never lists an
// undispatchable tool (least-privilege; no enumeration of denied capability).
function callerDenied(target: VisibilityTarget, caller: VisibilityCaller): boolean {
  if (!grantsAll(caller.grantedScopes, target.requiredScopes)) return true;
  return caller.readOnly === true && isMutating(target);
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
  if (config.disabled.includes(target.name) || intersects(target.tags, config.disabledTags)) {
    return "disabled";
  }
  if (
    config.hidden.includes(target.name) ||
    intersects(target.tags, config.hiddenTags) ||
    (config.requireReadOnly && isMutating(target)) ||
    (config.allowed !== undefined && !config.allowed.includes(target.name))
  ) {
    return "hidden";
  }
  if (caller && callerDenied(target, caller)) {
    return "scope_denied";
  }
  return "listed";
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
