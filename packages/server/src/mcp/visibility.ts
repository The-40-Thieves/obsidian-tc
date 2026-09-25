import {
  grantsScope,
  isMutatingScope,
  type ToolVisibilityConfig,
} from "@the-40-thieves/obsidian-tc-shared";

// Tool-visibility scoping. A pure verdict layer over the Registry.listVisible() / dispatch
// chokepoints: it never mutates the registry, it only classifies a tool. Two layers compose over
// ONE chokepoint and ONE verdict, never duplicated — STATIC-CONFIG (THE-219, the per-server
// `toolVisibility` block) and PER-CALLER (THE-250, the caller's granted ACL scopes + read-only
// flag) — feeding `visibilityOf` a single precedence `disabled > hidden > scope_denied > listed`.
// Omitting the caller (a full `*` grant) collapses to the static layer.

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
  /** THE-647 item 2: a persona's own tool-visibility mask (ctx.toolVisibility), composed with
   *  the static config below — see explainVisibility's doc comment for the precedence. Absent
   *  for every caller that carries no persona (unchanged behaviour). */
  toolVisibility?: ToolVisibilityConfig;
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

// THE-1099 (GH #964 part 2): the ONE named allowlist of tools exempt from the acl.readOnly kill
// switch and from requireReadOnly hiding, because their only write target is the derived-
// cognition plane (experiential.db), never authored vault content — see SECURITY.md's derived-
// plane table and THE-563/564. Enumerated by NAME, never by tag: a security-relevant allowlist
// must not silently widen the next time a tag gets reused for something unrelated. Imported by
// `enforceReadOnlyGate` (registry/policy-gates.ts, the dispatch-time kill switch) rather than
// duplicated there, so the visibility layer and the kill switch can never authorize a call the
// other still blocks.
export const READ_ONLY_DERIVED_TELEMETRY_EXEMPT_TOOLS: readonly string[] = [
  "record_retrieval_feedback",
];

/** `ToolVisibilityConfig` widened with ONE derived, non-user-facing flag. There is no
 *  `toolVisibility.allowReadOnlyDerivedTelemetry` config key an operator sets directly — the knob
 *  is `experiential.allowFeedbackInReadOnly`, and only takes effect together with
 *  `experiential.logRetrievals`. Server-runtime wiring computes that AND once
 *  (server-runtime.ts) and carries the result on this field so the visibility layer here and the
 *  dispatch kill switch read the identical resolved value, rather than each re-deriving it from
 *  experiential config — which a pure authorization module (policy-gates.ts) has no business
 *  importing. */
export interface EffectiveToolVisibilityConfig extends ToolVisibilityConfig {
  allowReadOnlyDerivedTelemetry?: boolean;
  disabledByProfile?: readonly string[];
}

/** True when `name` may bypass the read-only gates below: on the allowlist above AND the operator
 *  has turned the exemption on. The single predicate `explainAgainstConfig` below and
 *  `enforceReadOnlyGate` (registry/policy-gates.ts) both call, so the advertised surface and the
 *  dispatch-time enforcement can never disagree about which calls are exempt. */
export function isReadOnlyDerivedTelemetryExempt(
  name: string,
  config: Pick<EffectiveToolVisibilityConfig, "allowReadOnlyDerivedTelemetry">,
): boolean {
  return (
    config.allowReadOnlyDerivedTelemetry === true &&
    READ_ONLY_DERIVED_TELEMETRY_EXEMPT_TOOLS.includes(name)
  );
}

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
  | "disabled_by_profile" // THE-1131: profile-hidden; disclosable, unlike disabled_name/_tag.
  | "hidden_name"
  | "hidden_tag"
  | "hidden_require_read_only"
  | "hidden_not_allowlisted"
  | "scope_denied_missing_scope"
  | "scope_denied_read_only"
  // THE-1099: listed despite requireReadOnly / acl.readOnly — the tool is on
  // READ_ONLY_DERIVED_TELEMETRY_EXEMPT_TOOLS and experiential.allowFeedbackInReadOnly (+
  // logRetrievals) is on. Its own reason so inspect_visibility can tell "listed because nothing
  // was restricted" apart from "listed despite a read-only policy that would otherwise hide it".
  | "visible_derived_telemetry";

export interface VisibilityExplanation {
  visibility: Visibility;
  reason: VisibilityReason;
  /** The tag that matched `hiddenTags` / `disabledTags`, when the reason is a `*_tag` one. */
  matchedTag: string | null;
  /** Required scopes the caller does NOT hold. Only populated for `scope_denied_missing_scope`. */
  missingScopes: readonly string[];
}

// THE-1098 (GH #964) item 2: which `VisibilityReason`s are safe to disclose to an ORDINARY caller
// (describe_capability/find_capability) as "this exists but is hidden from you", rather than the
// existence-oracle-safe `not_found` every other reason keeps. The line is whether the reason is
// configuration the caller already knows about their OWN connection:
//   - hidden_require_read_only / scope_denied_read_only: the server's read-only posture (static
//     `toolVisibility.requireReadOnly`, or the caller's own `acl.readOnly`) is not a secret from a
//     caller operating under it — GH #964's reporter hit exactly this discovering
//     record_retrieval_feedback via the server's own instructions.
//   - disabled_by_profile (THE-1131): `toolFacade.profile` is server-wide config, not a targeted
//     per-tool operator decision — same argument as above.
// Every other reason (disabled_name/_tag, hidden_name/_tag, hidden_not_allowlisted,
// scope_denied_missing_scope) is an operator choice to hide a SPECIFIC tool or a deliberately
// invisible allowlist, and stays `not_found` — see explainVisibility's precedence doc comment.
export const DISCLOSABLE_HIDDEN_REASONS: ReadonlySet<VisibilityReason> = new Set([
  "hidden_require_read_only",
  "scope_denied_read_only",
  "disabled_by_profile",
]);

// The single-config verdict `explainVisibility` used to BE — factored out so THE-647 item 2 can
// compose a persona's own toolVisibility on top without duplicating this logic. Never exported:
// callers always go through `explainVisibility`, which is where the composition rule lives.
function explainAgainstConfig(
  target: VisibilityTarget,
  config: ToolVisibilityConfig,
  caller: VisibilityCaller | undefined,
  // THE-1099: resolved ONCE by explainVisibility from the STATIC (server-wide) config and handed
  // down unchanged to both the static-layer and the persona-layer call — never re-derived from
  // `config` here. `experiential.allowFeedbackInReadOnly` is a server-level setting; a persona's
  // own `toolVisibility` mask carries no such field, and re-deriving per layer would make a
  // persona overlay silently re-hide an exempted tool the static layer already cleared.
  readOnlyExempt: boolean,
  profileHidden: boolean,
): VisibilityExplanation {
  const base = { matchedTag: null, missingScopes: [] as readonly string[] };

  // THE-1131 (review round 2): an OPERATOR's own explicit per-tool disable is checked BEFORE the
  // blanket profile default and wins — it is the stricter, more specific, earlier-stated rule.
  // `inspect_visibility` under `core` for a tool the operator ALSO disabled by name must report
  // the operator's own reason, never `disabled_by_profile`, so an operator reading their own
  // config is never told "the profile did this" for something they did themselves.
  if (config.disabled.includes(target.name))
    return { ...base, visibility: "disabled", reason: "disabled_name" };
  const disabledTag = matchingTag(target.tags, config.disabledTags);
  if (disabledTag !== null)
    return { ...base, visibility: "disabled", reason: "disabled_tag", matchedTag: disabledTag };

  // Still ahead of `hidden`/`scope_denied`: more fundamental than either (and disclosable, unlike
  // an operator's own hide/disable choices).
  if (profileHidden) return { ...base, visibility: "disabled", reason: "disabled_by_profile" };

  if (config.hidden.includes(target.name))
    return { ...base, visibility: "hidden", reason: "hidden_name" };
  const hiddenTag = matchingTag(target.tags, config.hiddenTags);
  if (hiddenTag !== null)
    return { ...base, visibility: "hidden", reason: "hidden_tag", matchedTag: hiddenTag };
  if (config.requireReadOnly && isMutating(target)) {
    if (readOnlyExempt)
      return { ...base, visibility: "listed", reason: "visible_derived_telemetry" };
    return { ...base, visibility: "hidden", reason: "hidden_require_read_only" };
  }
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
    if (caller.readOnly === true && isMutating(target)) {
      if (readOnlyExempt)
        return { ...base, visibility: "listed", reason: "visible_derived_telemetry" };
      return { ...base, visibility: "scope_denied", reason: "scope_denied_read_only" };
    }
  }

  return { ...base, visibility: "listed", reason: "listed" };
}

/**
 * Classify one tool AND report which rule decided it. Precedence is unchanged and is asserted
 * here rather than restated: `disabled > hidden > scope_denied > listed`.
 *
 * THE-647 item 2: `caller.toolVisibility` (a persona's own mask) composes with the static
 * `config` at this SAME chokepoint, evaluated ONLY when the static config already says `listed` —
 * a persona can narrow further but never WIDEN past the static config's decision, preserving
 * THE-645 item 2's existence-oracle constraint (denial always reads as "never registered").
 */
export function explainVisibility(
  target: VisibilityTarget,
  config: EffectiveToolVisibilityConfig = ALLOW_ALL,
  caller?: VisibilityCaller,
): VisibilityExplanation {
  // THE-1099: resolved once, from the STATIC config only — see explainAgainstConfig's doc comment
  // on the `readOnlyExempt` parameter for why this must not be re-derived per layer.
  const readOnlyExempt = isReadOnlyDerivedTelemetryExempt(target.name, config);
  const profileHidden = config.disabledByProfile?.includes(target.name) ?? false;
  const staticVerdict = explainAgainstConfig(target, config, caller, readOnlyExempt, profileHidden);
  if (staticVerdict.visibility !== "listed") return staticVerdict;
  if (caller?.toolVisibility === undefined) return staticVerdict;
  return explainAgainstConfig(target, caller.toolVisibility, caller, readOnlyExempt, false);
}

// THE-1098 follow-up (PR #965 review): a DISCLOSABLE reason can fire ahead of a non-disclosable
// one (explainAgainstConfig short-circuits on its FIRST match), so this re-checks with THAT
// reason's own knob(s) neutralized — if the tool is STILL not `listed`, some other rule
// independently hides it, and disclosure is refused. `explainAgainstConfig`'s own precedence is
// untouched — `inspect_visibility` keeps the real, first-match reason.
export function disclosableExplanation(
  target: VisibilityTarget,
  config: ToolVisibilityConfig,
  caller: VisibilityCaller | undefined,
): VisibilityExplanation | null {
  const explanation = explainVisibility(target, config, caller);
  if (!DISCLOSABLE_HIDDEN_REASONS.has(explanation.reason)) return null;
  if (explanation.reason === "disabled_by_profile") {
    const neutralConfig = { ...config, disabledByProfile: [] }; // THE-1131: its own knob only.
    const stillHidden = explainVisibility(target, neutralConfig, caller).visibility !== "listed";
    return stillHidden ? null : explanation;
  }
  const neutralCaller: VisibilityCaller | undefined = caller && {
    ...caller,
    readOnly: false,
    ...(caller.toolVisibility
      ? { toolVisibility: { ...caller.toolVisibility, requireReadOnly: false } }
      : {}),
  };
  const neutralConfig = { ...config, requireReadOnly: false };
  const stillHidden =
    explainVisibility(target, neutralConfig, neutralCaller).visibility !== "listed";
  return stillHidden ? null : explanation;
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
  config: EffectiveToolVisibilityConfig = ALLOW_ALL,
  caller?: VisibilityCaller,
): Visibility {
  return explainVisibility(target, config, caller).visibility;
}

// True when the tool appears in tools/list for this caller (verdict `listed`). With no
// caller (a full grant) only the static config gates.
export function isListed(
  target: VisibilityTarget,
  config?: EffectiveToolVisibilityConfig,
  caller?: VisibilityCaller,
): boolean {
  return visibilityOf(target, config, caller) === "listed";
}

// True when the tool is administratively disabled (rejected at dispatch). Caller-independent at
// the STATIC layer (disabled name/tag checks never read `caller`); `caller` is accepted so a
// persona's own `toolVisibility.disabled` (THE-647 item 2) also blocks dispatch, not just
// tools/list — the same disabled > hidden > scope_denied > listed precedence `explainVisibility`
// composes. Every existing (non-persona) caller passes no `toolVisibility`, so this is a no-op
// for them: byte-identical to the caller-independent check this replaces.
export function isDisabled(
  target: VisibilityTarget,
  config?: EffectiveToolVisibilityConfig,
  caller?: VisibilityCaller,
): boolean {
  return visibilityOf(target, config, caller) === "disabled";
}
