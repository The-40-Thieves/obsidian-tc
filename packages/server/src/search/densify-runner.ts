import { createHash } from "node:crypto";
import type { Database } from "../db/types";
import type { GatewayClient } from "../gateway/client";
import { reconcileDerivedEdges } from "./derived-edges";
import { extractSemanticEdges, type SourceNote } from "./llm-edges";

// Batch runner for LLM Pass-3 semantic-edge densification (docs/plans/2026-07-13-graph-densification.md).
// Assembles note bodies from the indexed chunks, extracts semantic edges via the LOCAL gateway
// (extractSemanticEdges routes through the `extract` role -> local model; never remote by default), and
// reconciles them into vault_edges on the semantically_similar_to edge_type. Full-state: a re-run
// replaces the prior LLM layer (and prunes it to empty if the model returns nothing) without touching
// literal / tag / kNN edges. Separate from the inline index pass because it egresses note content to a
// model and is expensive — run it when the gateway is up, not on every reindex.
export async function runLlmDensify(
  db: Database,
  vaultId: string,
  client: GatewayClient,
  opts: { batchSize?: number; confidenceFloor?: number; maxContentChars?: number } = {},
): Promise<{ notes: number; edges: number }> {
  const maxChars = opts.maxContentChars ?? 4000;
  const rows = db
    .prepare(
      "SELECT path, group_concat(content, char(10)) AS content FROM chunks WHERE vault_id = ? GROUP BY path",
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
  const edges = await extractSemanticEdges(client, notes, opts);
  reconcileDerivedEdges(db, vaultId, edges, ["semantically_similar_to"], Date.now);
  return { notes: notes.length, edges: edges.length };
}
