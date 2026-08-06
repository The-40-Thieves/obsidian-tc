// THE-581 (family 15): graph densification cost.
//
// Before this collector the perf harness could not see densification AT ALL — `buildVault` called
// indexVault with no `densify` option, so the pass never ran, and `rg "densif|knn" collectors/`
// returned nothing. That is why THE-534 could not tighten its way to noticing THE-486's 113.9x
// improvement: the gate did not misjudge the number, there was no number.
//
// The cost driver is the OUTER per-chunk vec0 KNN call count. That is the unit THE-486's result
// ("100x fewer chunks") and THE-533's reverse-neighbour bound are both expressed in, and it is a
// COUNT — exactly reproducible from the seeded corpus — so it can be gated `hard`/`exact` rather
// than with a tolerance. Wall time rides along as `warn`, like every other latency figure here.
import { countDerivedEdges } from "../../../src/search/derived-edges";
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

// Edge counts come from countDerivedEdges (src/search/derived-edges.ts) rather than hand-written
// SQL here, so the metric cannot drift from the schema the indexer actually writes — and from the
// TABLE rather than IndexStats, because the stats counters report what this PASS wrote while the
// gate needs the resulting STATE. A reconcile that deleted as many edges as it inserted is a very
// different outcome from one that wrote nothing, and the delta counters cannot distinguish them.

export function collectDensification(vault: VaultCtx): MetricSample[] {
  const densify = vault.scenario.densify;
  // Densification is opt-in; scenarios without it emit nothing rather than a row of zeros. Emitting
  // zeros would be worse than silence: a `hard`/`exact` 0 matching a baseline 0 reports PASS
  // forever, which is the shape of gate-that-measures-nothing this ticket exists to remove.
  if (!densify) return [];

  const similarTo = countDerivedEdges(vault.db, vault.vaultId, "similar_to");
  const sharedTag = countDerivedEdges(vault.db, vault.vaultId, "shared_tag");

  // THE-581's "done when": ASSERT the pass ran, do not assume it. A densify scenario that silently
  // skipped densification — a renamed option, a corpus with no tags, a guard that stopped firing —
  // would otherwise publish a clean, stable, entirely meaningless baseline, reproducing this
  // ticket's exact bug one layer up. Throwing fails the run loudly instead.
  if (densify.knnEdges && vault.vecKnnCalls === 0)
    throw new Error(
      `densify scenario "${vault.scenario.name}" ran ZERO vec0 KNN calls — the kNN densification pass did not execute. A baseline recorded from this run would gate nothing.`,
    );
  if (densify.knnEdges && similarTo === 0)
    throw new Error(
      `densify scenario "${vault.scenario.name}" produced ZERO similar_to edges despite ${vault.vecKnnCalls} KNN call(s). The pass ran but built no graph.`,
    );
  if (densify.tagEdges && sharedTag === 0)
    throw new Error(
      `densify scenario "${vault.scenario.name}" produced ZERO shared_tag edges — the corpus is untagged, so tag co-occurrence measured nothing.`,
    );

  return [
    {
      // The gateable number THE-533's PR-body table should have been. Deterministic: the corpus is
      // seeded, the embeddings are a pure function of text, and the call count is a property of the
      // traversal, not of timing.
      key: "densify.vec_knn_calls",
      value: vault.vecKnnCalls,
      unit: "count",
      class: "hard",
      // "higher-worse" rather than "exact" for the same reason index.txn_count is: this is a COST,
      // and a legitimate improvement (another THE-486) should register as a win, not trip an
      // exact-match invariant. A regression — the case this exists for — still fails.
      direction: "higher-worse",
    },
    // THE-419: the PER-CALL cost. `vec_knn_calls` above is a property of the TRAVERSAL — how many
    // KNNs densification issues — and it cannot see the thing THE-419 is gated on. That ticket
    // waits for "a MEASURED large-vault vector-latency bottleneck", and an ANN index's entire
    // proposition is lowering the cost of EACH call while leaving the count identical. Measured
    // against the count, a perfect ANN index and a catastrophic one are the same number.
    //
    // Before this, the gate was unmeasurable as written: the only mention of the measurement
    // anywhere in the repo was the sentence demanding it (docs/plans/2026-07-12-...:67), and
    // eval/perf carried no vector-latency metric at all — so neither the gate opening NOR a
    // latency regression could ever surface.
    //
    // `warn`, not `hard`, and deliberately: this is wall time on a 4-core box shared with ~43
    // containers, and every other timing here (index.chunks_per_s, embed.texts_per_s,
    // boot.module_eval_ms) is warn for the same reason. A hard gate on it would flap and get muted,
    // which is how a gate stops being one. The DETERMINISTIC half of this pair is already hard —
    // that split is the file header's stated design, not a concession.
    //
    // Guarded on `knnEdges` because that is exactly the condition the throw above makes
    // `vecKnnCalls > 0` under; a tag-only densify scenario would otherwise divide by zero and
    // publish NaN, which compares equal to nothing and would gate silently forever.
    ...(densify.knnEdges
      ? [
          {
            key: "densify.vec_knn_mean_ms",
            value: vault.vecKnnTotalMs / vault.vecKnnCalls,
            unit: "ms",
            class: "warn",
            direction: "higher-worse",
          } satisfies MetricSample,
        ]
      : []),
    {
      key: "densify.edges_similar_to",
      value: similarTo,
      unit: "count",
      class: "hard",
      // The EDGE SET is a correctness invariant, not a cost: building fewer edges is not an
      // improvement, it is a different graph. Exact.
      direction: "exact",
    },
    {
      key: "densify.edges_shared_tag",
      value: sharedTag,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      // Warn-class, matching every other wall-clock figure in this harness — see the README's
      // Determinism section for why latency is never gated hard here.
      //
      // Named index_ms, NOT densify_ms, because that is what it measures: the whole indexVault call
      // with densification ON. indexVault exposes no hook to time the pass alone. The densification
      // cost proper is this minus `small`'s index_ms — the two scenarios share a corpus precisely so
      // that subtraction is valid — but that is a cross-scenario read the gate does not perform, so
      // the metric is not dressed up as something narrower than it is.
      key: "densify.index_ms",
      value: vault.indexMs,
      unit: "ms",
      class: "warn",
      direction: "higher-worse",
    },
  ];
}
