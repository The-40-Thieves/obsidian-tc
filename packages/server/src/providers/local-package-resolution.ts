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
}
