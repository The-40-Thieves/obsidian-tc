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
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { globMatch } from "../acl";

export interface EgressFilter {
  readonly patterns: readonly string[];
}

/** THE-934 fix round 3 (F): `globToRegExp` (acl.ts) compiles a LITERAL pattern (no `*`/`?`) to an
 *  exact-string match only — `Private` becomes `^Private$`, `Private/` becomes `^Private/$`, and
 *  NEITHER matches `Private/journal.md`. That made the most natural config an operator would write
 *  ("exclude the Private folder": `["Private"]` or `["Private/"]`) silently inert. A literal
 *  pattern is ambiguous between "an exact file" and "a folder name" by construction — there is no
 *  filesystem lookup here to disambiguate, and the safe failure direction for a security control
 *  is to exclude TOO MUCH, never too little. So every literal pattern is expanded into TWO
 *  alternatives: the exact path itself, and everything nested under it as a folder
 *  (`<trimmed>/**`). `Private`, `Private/`, and `Private/**` (already a glob) all end up excluding
 *  the same set; `Private/a.md` still matches only that exact file — `Private/a.md.bak` is not
 *  "under `Private/a.md/`" as a folder, so it is untouched. A pattern that already contains glob
 *  metacharacters is trusted as-is; this widening only fires for a pattern that could not possibly
 *  have meant to be an exact-match-only literal. */
function normalizeExcludePattern(pattern: string): string[] {
  if (pattern.includes("*") || pattern.includes("?")) return [pattern];
  const trimmed = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  if (trimmed.length === 0) return [pattern]; // pathological "/" alone -- nothing sane to widen
  return [trimmed, `${trimmed}/**`];
}

/** Compile `egress.excludePaths` once per config load. Cheap (globMatch itself caches compiled
 *  regexes keyed by pattern string in acl.ts), but callers should still build one FILTER and reuse
 *  it across a whole pass rather than re-wrapping the raw array per call. */
export function compileEgressFilter(excludePaths: readonly string[]): EgressFilter {
  return { patterns: excludePaths.flatMap(normalizeExcludePattern) };
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
