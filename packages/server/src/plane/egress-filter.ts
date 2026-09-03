// THE-934: the one predicate every plane egress boundary calls before a chunk's text reaches the
// inference gateway or the embedding provider. Reuses acl.ts's glob engine (globMatch) rather than
// inventing a second glob dialect for `egress.excludePaths` -- readPaths and excludePaths must
// agree on what a pattern means, and acl.ts is already the tested, THE-272 unicode/case-fold-aware
// implementation. This module adds no ACL semantics of its own (no negation, no rule ordering): it
// is a flat "does this vault-relative path match any exclude glob" check.
//
// Deliberately dependency-free within the server tree (imports only acl.ts, plus the shared error
// taxonomy package -- a different dependency direction, not a `plane/*` internal cycle) so both
// `gateway/client.ts` and `embeddings/index.ts` -- the two PORT modules that construct every
// outbound client in the server -- can import it without risking an import cycle back into
// `plane/*`.
import {
  isUnusableEgressExcludePattern,
  normalizeEgressExcludePattern,
  ObsidianTcError,
} from "@the-40-thieves/obsidian-tc-shared";
import { globMatch } from "../acl";

export interface EgressFilter {
  readonly patterns: readonly string[];
}

// THE-934 fix round 3 (F), generalised to the whole CLASS in fix round 4 (1): globToRegExp
// (acl.ts) anchors every compiled pattern at both ends, so a pattern describing a FOLDER matches
// the folder and nothing inside it -- "Private" compiles to /^Private$/ and does not match
// "Private/journal.md". Round 3 widened the metacharacter-FREE spellings only, which fixed
// "Private" and "Private/" and left "/Private", "./Private", "**/Private", "Private//",
// "Private*/", "*/Private/" and "Private/*" still matching nothing: the same silent-inertness
// defect one spelling over, and "/Private" and "**/Private" are both ordinary gitignore.
//
// The rule is now uniform and spelling-independent, in two steps:
//
//   1. NORMALISE (normalizeEgressExcludePattern, shared with the config-load rejection so the two
//      cannot drift): collapse repeated separators, strip a leading "/" or "./", so "/Private",
//      "./Private", "Private//" and "Private" are literally the same pattern.
//   2. WIDEN: every pattern also matches everything BENEATH it ("<p>/**"), whether or not it
//      carries metacharacters, with a trailing "/" dropped first so the folder itself is covered
//      too. A pattern already ending in "**" is its own subtree and is left alone. A leading
//      "**/" additionally contributes the ROOT-anchored twin ("**/Private" -> also "Private"),
//      because gitignore's "**/x" matches x at every depth INCLUDING depth 0, which an anchored
//      ".*" prefix alone cannot.
//
// The direction of error is deliberate and always outward -- this is a security control, so a
// pattern that excludes too much costs retrieval quality while one that excludes too little
// leaks. Two consequences follow, both documented in the schema's own .describe(): "Private/*",
// whose gitignore MEANING is "direct children" but whose gitignore EFFECT is the whole subtree
// (an excluded directory is never descended into), is widened to the subtree; and a
// folder-shaped pattern also matches a FILE of that exact name, so a trailing-slash pattern also
// excludes a root note "Private.md". A literal FILE pattern is unaffected in the way that
// matters: "Private/a.md" gains only "Private/a.md/**", which no sibling like
// "Private/a.md.bak" can match.
//
// Rejection rather than widening for the ONE degenerate spelling -- a pattern that normalises to
// nothing -- happens at config load (EgressConfigSchema's own refine) and again here, because
// compileEgressFilter is also reachable from eval/ scripts and tests that never pass through the
// schema. A bare double-star is NOT degenerate: it is the exclude-all form (withhold every note
// from every hosted provider), a supported fully-local deployment, and it needs no widening
// because it already is its own subtree.
function normalizeExcludePattern(pattern: string): string[] {
  if (isUnusableEgressExcludePattern(pattern)) {
    throw new Error(
      `egress.excludePaths: unusable pattern ${JSON.stringify(pattern)} — it normalises to ` +
        'nothing ("", "/", "./", or whitespace only), so it would exclude nothing at all. Name a ' +
        'real folder or glob, or "**" to withhold the whole vault.',
    );
  }
  const cleaned = normalizeEgressExcludePattern(pattern);
  const out = new Set<string>(widenToSubtree(cleaned));
  // `**/Private` means a Private folder at ANY depth, root included; the root-anchored twin is
  // what covers depth 0. Skipped when the remainder is itself degenerate (`**/**`).
  if (cleaned.startsWith("**/")) {
    const rest = cleaned.slice(3);
    if (!isUnusableEgressExcludePattern(rest)) for (const p of widenToSubtree(rest)) out.add(p);
  }
  return [...out];
}

/** One anchored spelling and its subtree. Trailing separators are dropped first (so the folder
 *  itself is matched, not only its contents); a pattern that already ends in `**` is its own
 *  subtree and gains nothing. */
function widenToSubtree(pattern: string): string[] {
  const trimmed = pattern.replace(/\/+$/, "");
  if (trimmed.endsWith("**")) return [trimmed];
  return [trimmed, `${trimmed}/**`];
}

/** Compile `egress.excludePaths` once per config load. Cheap (globMatch itself caches compiled
 *  regexes keyed by pattern string in acl.ts), but callers should still build one FILTER and reuse
 *  it across a whole pass rather than re-wrapping the raw array per call.
 *
 *  Throws on an unusable pattern (see normalizeExcludePattern) — a filter this function cannot
 *  honour must never be returned as if it were enforcing something. */
export function compileEgressFilter(excludePaths: readonly string[]): EgressFilter {
  return { patterns: excludePaths.flatMap(normalizeExcludePattern) };
}

/** THE-934 fix round 4 (4): does this filter actually carry any exclusion at all?
 *
 *  `compileEgressFilter([])` is a real, non-undefined filter that excludes nothing — every
 *  production wiring builds one unconditionally (scheduler-wiring.ts, plane-wiring.ts), so
 *  `excludeFilter !== undefined` answers "was a filter threaded", NOT "is anything excluded".
 *  Consumers that FAIL CLOSED on unprovable provenance (advisory-sweep.ts) must key on the second
 *  question: with no patterns configured there is nothing to be excluded from, and dropping
 *  candidates would be a behaviour change for an operator who never asked for one. */
export function hasExcludePatterns(filter: EgressFilter): boolean {
  return filter.patterns.length > 0;
}

/** True when `path` (vault-relative) matches at least one exclude glob.
 *
 * Deliberately uncached against the path itself: a renamed or newly-excluded folder must be
 * caught on the very next pass, and memoizing per-path would need an invalidation signal this
 * module has no way to receive. Every caller (the four assemblers, the port guard, index-time
 * planning) already evaluates this once per candidate per pass, not in a tight inner loop, so the
 * per-call cost is one regex test per configured glob. */
export function isExcludedPath(filter: EgressFilter, path: string): boolean {
  return filter.patterns.some((glob) => globMatch(glob, path));
}

/** Thrown by the PORT guards (gateway/client.ts's createGatewayClient, embeddings/index.ts's
 *  createEmbeddingProvider(Async)) when a content-bearing call does not declare `sourcePaths`, or
 *  declares one under an excluded glob. Fail-closed: a caller that forgets to declare is refused,
 *  never silently allowed through.
 *
 *  THE-934 fix round 3 (H): extends `ObsidianTcError`, not a bare `Error` — round 0 through fix
 *  round 2's own `instanceof EgressViolationError` rethrows (cli/commands/index.ts and every
 *  content-bearing catch fixed in fix round 3, B) all correctly kept this error from being
 *  swallowed at the ONE layer that checked for it explicitly, but `isLoudRefusal`
 *  (packages/shared/src/errors.ts), the SHARED predicate every per-leg fan-out isolation layer
 *  (multiQueryGraphSearch, runFederatedLegs) uses to decide "swallow this into an empty leg" vs.
 *  "propagate", requires `instanceof ObsidianTcError` — a bare `Error` was NEVER loud by that
 *  predicate, so a fan-out with no explicit `instanceof EgressViolationError` check of its own
 *  would have silently treated a guard refusal as an ordinary per-leg transient failure. The
 *  `"egress_excluded"` code is not in `RETRYABLE`, so `retryable` is `false` and `isLoudRefusal`
 *  recognises it via that branch too, not only via `code === "internal"`. */
export class EgressViolationError extends ObsidianTcError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("egress_excluded", message, details);
    this.name = "EgressViolationError";
    Object.setPrototypeOf(this, EgressViolationError.prototype);
  }
}

/**
 * THE-934 fix round 1: the ONE check every port guard applies, so the two ports (gateway, embed)
 * and every direct `GatewayRoles` guard (tests, `egress-guard.ts`) agree on the exact same
 * semantics -- fixing round 0's I1 defect, where an unconditional "sourcePaths must be non-empty"
 * requirement dead-lettered a legitimate degrade (a prompt-budget truncation that dropped every
 * candidate has REAL zero vault content, and must be allowed to say so).
 *
 * - `undefined` -- the caller did not declare what it is sending. Fail closed: throw. This is the
 *   "a forgotten call site fails loudly" contract; it is what makes a NEW, unfiltered call site
 *   refuse itself instead of leaking.
 * - `[]` -- the caller DECLARED zero vault paths (a real state: nothing survived a prompt budget,
 *   or the request genuinely carries no vault content). Passes -- there is nothing to check.
 * - non-empty -- every path must clear the filter; the first excluded one throws, named in the
 *   message (a path, never content or a credential).
 */
export function assertSourcePathsAllowed(
  filter: EgressFilter,
  role: string,
  sourcePaths: string[] | undefined,
): void {
  if (sourcePaths === undefined) {
    throw new EgressViolationError(
      `egress guard: ${role} request carries no sourcePaths -- a content-bearing call must ` +
        "declare which vault paths its text was assembled from (an empty array is fine when " +
        "there genuinely is none)",
    );
  }
  const hit = sourcePaths.find((p) => isExcludedPath(filter, p));
  if (hit !== undefined) {
    throw new EgressViolationError(
      `egress guard: ${role} request includes excluded path "${hit}" (egress.excludePaths)`,
    );
  }
}
