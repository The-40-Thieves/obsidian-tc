import { isMutatingScope, type ToolVisibilityConfig } from "@the-40-thieves/obsidian-tc-shared";

// Static tool-visibility scoping (THE-219). A pure verdict layer over the
// Registry.listVisible() / dispatch chokepoints: it never mutates the registry, it
// only classifies a tool given the server's `toolVisibility` config.
//
// This is the STATIC-CONFIG layer. THE-250 adds a per-caller ACL layer over the SAME
// chokepoint; the two are designed to compose, not duplicate — a tool is offered to a
// caller only when it is `listed` here AND permitted by the per-caller filter. Keep both
// layers expressed as a shared `Visibility` verdict so neither reimplements precedence.

export type Visibility = "listed" | "hidden" | "disabled";

// The minimum a tool must expose to be classified. A ToolDefinition is structurally
// assignable to this, so the registry passes its definitions straight through.
export interface VisibilityTarget {
  name: string;
  tags?: readonly string[];
  requiredScopes: readonly string[];
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

// Classify one tool against a visibility config. Precedence is
// `disabled > hidden > listed`: an explicit disable always wins, then any hide rule,
// otherwise the tool is listed.
//   - disabled: name in `disabled`, or a tag in `disabledTags`.
//   - hidden:   name in `hidden`, a tag in `hiddenTags`, a mutating tool under
//               `requireReadOnly`, or (when `allowed` is set) a name absent from it.
export function visibilityOf(
  target: VisibilityTarget,
  config: ToolVisibilityConfig = ALLOW_ALL,
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
  return "listed";
}

// True when the tool appears in tools/list (verdict `listed`).
export function isListed(target: VisibilityTarget, config?: ToolVisibilityConfig): boolean {
  return visibilityOf(target, config) === "listed";
}

// True when the tool is administratively disabled (rejected at dispatch).
export function isDisabled(target: VisibilityTarget, config?: ToolVisibilityConfig): boolean {
  return visibilityOf(target, config) === "disabled";
}
