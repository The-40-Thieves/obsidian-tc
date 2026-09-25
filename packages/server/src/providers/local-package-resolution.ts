// Shared by BOTH the "local" reranker ladder (registry.ts) and the "local" embeddings ladder
// (local-embedder-registry.ts) — lifted into its own module rather than having one import from
// the other, which would make them circular (registry.ts needs to import
// buildLocalEmbeddingProvider from local-embedder-registry.ts for the EMBEDDINGS.local entry, and
// local-embedder-registry.ts needs these two symbols from wherever registry.ts originally defined
// them). See registry.ts's own header comment on why the two ladders are a deliberate structural
// mirror rather than a shared implementation beyond this.

/** True when any path SEGMENT is exactly `node_modules` — not a bare substring match, so a
 *  directory merely named e.g. `my-node_modules-tools` does not false-positive. */
export function isUnderNodeModules(path: string): boolean {
  return path.split(/[/\\]/).includes("node_modules");
}

export interface SourceCheckoutResolution {
  path: string;
  /** Set only when discovery was skipped outright (never walked the filesystem at all); absent
   *  otherwise, whether or not an anchor was actually found. */
  skippedReason?: string;
  /** Every candidate directory the walk tried, in innermost-to-outermost order (the walk starts at
   *  `startDir` and moves UP toward the filesystem root) — empty when `skippedReason` is set, since
   *  no walk happened. */
  candidates: string[];
  /** True only when the walk actually FOUND the package's anchor (its real `package.json`, name
   *  verified) somewhere above `startDir` — i.e. this process is genuinely running from inside a
   *  source checkout of the monorepo, even if `path` (computed from that anchor) doesn't exist yet
   *  because the package hasn't been built. False when the walk exhausted MAX_LEVELS without ever
   *  finding the anchor (or was skipped outright) — `path` is then only a best-effort fallback
   *  guess, and its absence says nothing about whether this is a checkout. THE-1122: this is what
   *  lets a resolution-failure caller distinguish "not built yet" (a normal, recoverable dev-time
   *  state — WARN) from "not present at all" (a real shipped-install gap — FAIL). */
  anchorFound: boolean;
}
