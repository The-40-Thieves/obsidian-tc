import { createHash } from "node:crypto";
import type { Database } from "../db/types";
import type { GatewayClient } from "../gateway/client";
import { reconcileDerivedEdges } from "./derived-edges";
import { extractSemanticEdges, type SourceNote } from "./llm-edges";

// Batch runner for LLM Pass-3 semantic-edge densification (docs/plans/2026-07-13-graph-densification.md).
// Assembles note bodies from the indexed chunks, extracts semantic edges via the LOCAL gateway
// (extractSemanticEdges routes through the `extract` role -> local model; never remote by default), and
// reconciles them into vault_edges on the semantically_similar_to edge_type.
//
// FULL-STATE, BUT ONLY ON A COMPLETE RUN. The reconcile is full-state (a re-run replaces the prior LLM
// layer), which means an EMPTY result would prune every existing LLM edge. That is only correct when the
// model genuinely found nothing — never when the gateway failed. So a run with ANY failed batch throws
// BEFORE reconciling and leaves the prior layer intact: "every request failed" must never be mistaken for
// "no relationships exist".
//
// Note ordering is explicit (ORDER BY path) so batch composition — and therefore which note pairs the
// model can even compare — is deterministic across runs, not a function of incidental row order.
export async function runLlmDensify(
  db: Database,
  vaultId: string,
  client: GatewayClient,
  opts: { batchSize?: number; confidenceFloor?: number; maxContentChars?: number } = {},
): Promise<{ notes: number; edges: number; batches: number }> {
  const maxChars = opts.maxContentChars ?? 4000;
  const rows = db
    .prepare(
      "SELECT path, group_concat(content, char(10)) AS content FROM chunks WHERE vault_id = ? GROUP BY path ORDER BY path",
    )
    .all(vaultId) as Array<{ path: string; content: string | null }>;
  const notes: SourceNote[] = rows.map((r) => {
    const content = (r.content ?? "").slice(0, maxChars);
    return {
      path: r.path,
      content,
      sha: createHash("sha256").update(content).digest("hex").slice(0, 16),
    };
  });

  const { edges, totalBatches, failedBatches } = await extractSemanticEdges(client, notes, opts);
  if (failedBatches > 0) {
    // Refuse to treat a partial run as authoritative. Nothing is written; the prior LLM layer survives.
    throw new Error(
      `densify-llm: ${failedBatches}/${totalBatches} gateway batches failed — refusing to reconcile ` +
        "(a partial run must never be mistaken for an authoritative empty set; the existing " +
        "semantically_similar_to layer is left intact). Fix the gateway and re-run.",
    );
  }
  reconcileDerivedEdges(db, vaultId, edges, ["semantically_similar_to"], Date.now);
  return { notes: notes.length, edges: edges.length, batches: totalBatches };
}
