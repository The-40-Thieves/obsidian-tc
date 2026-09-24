// THE-458 item 6 / THE-466: what a reconcile pass DID, extracted from cli.ts's inline block.
//
// Extracted for testability, not for size — the criterion the THE-458 re-spec settled on. The logic
// here has a real failure history and no test could reach it while it lived inside a 1000+ line boot
// function:
//
//   * THE-288: a degraded index used to be invisible; `server_health` reads what this records.
//   * THE-390: a pass that completed but SKIPPED notes (the embed provider rejected their chunks)
//     still has to degrade health, rather than the older behaviour of aborting the whole reindex.
//   * GH #171: a swallowed reconcile failure "presents as a permanent silent stall", which is why
//     it goes to stderr as well as to in-memory health.
//
// Now that the reconcile also runs on a SCHEDULE (not only at boot), this runs repeatedly — so
// "degraded" has to be able to go back to "ok" on a later pass, which is a property worth asserting
// rather than assuming.
export interface ReconcileResult {
  vault: string;
  error: string | null;
  /** THE-1073 fix round 1 (LOW): which failure class this is, set by the PRODUCER (e.g.
   *  reconcileResultsForVault, plane-wiring.ts) — never inferred from `error`'s message text below.
   *  Undefined for a producer that predates this field; applyReconcileOutcome then falls back to
   *  the pre-existing generic hint, unchanged from before this field existed. */
  kind?: "frontmatter" | "embed";
}

export interface ReconcileHealth {
  reconcile: "pending" | "ok" | "degraded";
  reconcileAt: number | null;
  reconcileErrors: Array<{ vault: string; error: string }>;
}

/**
 * Fold a pass's per-vault results into health, and surface every failure on stderr.
 *
 * `now` and `write` are injected so the whole thing is assertable without a clock or a real stderr.
 * Returns the errors it recorded, so a caller can branch without re-deriving them.
 *
 * THE-1073 fix round 2 (HIGH, both reviewers): `results`' `kind` is used HERE, in this function's
 * own stderr-hint loop, and NEVER copied into `health.reconcileErrors` or this function's return
 * value — both stay exactly `{ vault, error }`, matching `server_health`'s advertised outputSchema
 * (tools/admin/health.ts's `z.object({ vault, error })`, `additionalProperties: false`). Fix round
 * 1 copied `kind` through into both, which zod's server-side `safeParse` silently strips (so the
 * in-repo schema check passed) but the SDK's ajv validator on the CLIENT side rejects outright —
 * see health-output-schema.test.ts, which validates the actual emitted payload with ajv the way a
 * real MCP client does, not just zod.
 */
export function applyReconcileOutcome(
  results: readonly ReconcileResult[],
  health: ReconcileHealth,
  deps: { now: () => number; write: (s: string) => void },
): Array<{ vault: string; error: string }> {
  const failed = results.filter((r) => r.error !== null);
  const reconcileErrors = failed.map((r) => ({ vault: r.vault, error: r.error as string }));

  // Recomputed from THIS pass only — a scheduled reconcile must be able to clear a degradation the
  // previous pass recorded, or a single transient embed failure would pin health to "degraded"
  // until restart.
  health.reconcile = reconcileErrors.length === 0 ? "ok" : "degraded";
  health.reconcileAt = deps.now();
  health.reconcileErrors = reconcileErrors;

  for (const { vault, error, kind } of failed) {
    // THE-1073 fix round 1 (LOW): a frontmatter failure needs a DIFFERENT recovery hint —
    // "check the embeddings backend" is actively misleading when the note never reached the embed
    // provider at all. Keyed on the PRODUCER-set `kind` (read from `results`/`failed`, never from
    // `reconcileErrors`, which no longer carries it), never on error's message text. `kind` absent
    // (a producer that predates this field) falls back to the pre-existing generic hint below.
    const hint =
      kind === "frontmatter"
        ? "fix the note's YAML frontmatter — it is skipped, not lost, and will be indexed on the next reconcile once it parses."
        : "check the embeddings backend (raise embeddings.timeoutMs / lower embeddings.batchSize or " +
          "embeddings.maxBatchTokens for a slow or small-context local runner).";
    deps.write(
      `[index] reconcile degraded for vault "${vault}": ${error}. ` +
        `The search index may be incomplete; ${hint}\n`,
    );
  }
  return reconcileErrors;
}
