// The query-side dense encoder: the one place a single query string becomes a single vector.
//
// Two byte-identical closures existed before this module — the RetrievalRuntime's `embedQuery` in
// tools/m7/knowledge-tools.ts (built once by WP2.2 and handed to every M7 factory) and a private
// one in tools/m2/search-tools.ts. Both read `embed([q], { input: "query" })`; both collapsed an
// absent provider result to `[]`.
//
// The hazard was DRIFT, not duplication for its own sake. Each closure was private to its factory
// and unreachable from the other's module, so adding a query prefix, a normalisation step or a
// retry to one and not the other would make M2 and M7 encode the SAME string into DIFFERENT
// vectors — and no test could have seen it, because there was no shared symbol to assert on. The
// two surfaces then rank the same query differently while every existing suite stays green.
// query-encoder.test.ts pins that they cannot diverge again by asserting both reach this module.
//
// Deliberately NOT in scope, both because folding them in would make things worse:
//
//   - The BATCH paths. cli/commands/gaps.ts and cli/commands/citation-infer.ts call
//     `embed(queries[], { input: "query" })` with many queries per round trip. gaps.ts is
//     batch-shaped on purpose — THE-616 found the one-embed-per-query loop was the dominant cost of
//     a pass — so routing it through a single-query encoder would reinstate exactly the N round
//     trips THE-616 removed. They keep calling the provider directly.
//   - The SPARSE / late-interaction heads. tools/m7/query-sparse.ts uses `embedFull`, a different
//     provider method returning multi-vector output. It is composed ALONGSIDE this encoder in
//     RetrievalRuntime, not underneath it.
import type { EmbeddingProvider } from "../embeddings/provider";

export interface QueryEncoder {
  /** Encode one query into one dense vector. Returns `[]` when the provider yields no vector —
   *  the pre-existing behaviour of both closures this replaces, preserved deliberately: callers
   *  (semanticSearch, graphSearch) already treat an empty vector as "no dense arm" and degrade to
   *  their other streams, whereas throwing here would turn a provider hiccup into a failed tool
   *  call on a path that has always been survivable. */
  dense(query: string): Promise<number[]>;

  /**
   * The identity stored embeddings actually key on TODAY: `chunk_embeddings.model`, written as
   * `provider.id` by the index write path (persist-note-plan.ts, index-vault.ts) and read back by
   * THE-530's brute-force model filter in search/semantic.ts.
   *
   * This is `provider.id` and NOT THE-460's `representationManifestHash`, even though
   * search/representation.ts states plainly that the manifest is the identity `provider:model`
   * SHOULD be. The stored rows hold `provider.id` strings, so filtering them by a manifest hash
   * would match ZERO rows and return an empty result set — a failure indistinguishable from "this
   * query genuinely has no hits", which is the worst shape a retrieval bug can take. Adopting the
   * manifest as the stored key forces a one-time reindex and is already called out as a follow-up
   * in representation.ts. Naming the identity once, here, is what makes that migration a
   * single-site change rather than a hunt through two tool domains.
   */
  readonly storedModelId: string;
}

/**
 * Build the shared encoder for a provider. Cheap and stateless — it holds no cache and no buffers,
 * so constructing one per tool-factory call (as M2 and M7 both do) costs nothing and keeps the
 * provider binding explicit rather than module-global.
 *
 * Construction TOUCHES NOTHING on `provider`. That is a hard requirement, not an optimisation:
 * tool registration must not need a live embedding provider. registerM2Tools is called with `{}`
 * in several suites (task-augmented.test.ts and friends) purely to read tool METADATA — names,
 * taskAugmentable flags — and building the tool list has never required an embedder because the
 * closures this module replaced only dereferenced `deps.embeddingProvider` when INVOKED.
 *
 * The first draft of this function read `storedModelId: provider.id` eagerly and broke exactly
 * that, on all four platforms: `TypeError: Cannot read properties of undefined (reading 'id')` at
 * registration. Hence the getter — it restores the original timing, where the id was read inline
 * at the call site, per call. `encoderConstructionTouchesNothing` in the tests pins it.
 */
export function createQueryEncoder(provider: EmbeddingProvider): QueryEncoder {
  return {
    get storedModelId(): string {
      return provider.id;
    },
    async dense(query: string): Promise<number[]> {
      const [vec] = await provider.embed([query], { input: "query" });
      return vec ?? [];
    },
  };
}
