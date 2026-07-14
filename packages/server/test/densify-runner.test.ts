import { describe, expect, it } from "vitest";
import type { GatewayClient } from "../src/gateway/client";
import { runLlmDensify } from "../src/search/densify-runner";
import { openMemoryDb } from "./helpers";

function makeDb(): any {
  const d = openMemoryDb();
  d.exec(
    `CREATE TABLE chunks (id TEXT, vault_id TEXT, path TEXT, content TEXT);
     CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       confidence REAL, source_fingerprint TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );
     CREATE UNIQUE INDEX idx_ve ON vault_edges(vault_id, source_path, target_path, edge_type);`,
  );
  const ins = d.prepare("INSERT INTO chunks (id, vault_id, path, content) VALUES (?,?,?,?)");
  ins.run("1", "v1", "A.md", "a note about retrieval");
  ins.run("2", "v1", "A.md", "second chunk of A"); // two chunks, one note -> one SourceNote
  ins.run("3", "v1", "B.md", "a note about ranking");
  return d;
}

const oneEdge = {
  extract: async () => ({
    text: '[{"source":"A.md","target":"B.md","confidence":0.75}]',
    model: "local",
  }),
} as unknown as GatewayClient;

const edgeCount = (d: any): number =>
  (d.prepare("SELECT COUNT(*) AS n FROM vault_edges").get() as { n: number }).n;

describe("runLlmDensify", () => {
  it("assembles notes from chunks, extracts via the gateway, reconciles semantically_similar_to edges", async () => {
    const d = makeDb();
    const res = await runLlmDensify(d, "v1", oneEdge);
    expect(res).toEqual({ notes: 2, edges: 1, batches: 1 }); // A.md (2 chunks collapsed) + B.md
    const rows = d
      .prepare(
        "SELECT source_path, target_path, edge_type, edge_kind, provenance, confidence FROM vault_edges",
      )
      .all();
    expect(rows).toEqual([
      {
        source_path: "A.md",
        target_path: "B.md",
        edge_type: "semantically_similar_to",
        edge_kind: "derived",
        provenance: "llm_pass3",
        confidence: 0.75,
      },
    ]);
  });

  it("is full-state: a SUCCESSFUL re-run that finds nothing prunes the prior LLM layer", async () => {
    const d = makeDb();
    await runLlmDensify(d, "v1", oneEdge);
    expect(edgeCount(d)).toBe(1);
    const empty = { extract: async () => ({ text: "[]", model: "m" }) } as unknown as GatewayClient;
    const res = await runLlmDensify(d, "v1", empty);
    expect(res.edges).toBe(0);
    expect(edgeCount(d)).toBe(0); // the model answered "nothing" — that IS authoritative
  });

  it("REFUSES to reconcile when a gateway batch fails — the prior LLM layer survives", async () => {
    const d = makeDb();
    await runLlmDensify(d, "v1", oneEdge);
    expect(edgeCount(d)).toBe(1);
    // Every request throws: an all-failed run yields the same empty edge set as "found nothing", and
    // writing it would wipe the layer. The runner must throw instead of reconciling.
    const down = {
      extract: async () => {
        throw new Error("gateway unreachable");
      },
    } as unknown as GatewayClient;
    await expect(runLlmDensify(d, "v1", down)).rejects.toThrow(/refusing to reconcile/i);
    expect(edgeCount(d)).toBe(1); // untouched — no silent data loss on an outage
  });

  it("REFUSES when the model ANSWERS but every response is unusable — the layer survives", async () => {
    const d = makeDb();
    await runLlmDensify(d, "v1", oneEdge);
    expect(edgeCount(d)).toBe(1);
    // The transport is healthy and the model replies — with prose. So failedBatches stays 0 and `edges`
    // is empty, which is byte-for-byte what a genuine "no relationships found" looks like. Before the
    // unparseable-batch guard, the full-state reconcile accepted that and WIPED the layer.
    const prose = {
      extract: async () => ({
        text: "Sure! Here are some thoughts about your notes...",
        model: "m",
      }),
    } as unknown as GatewayClient;
    await expect(runLlmDensify(d, "v1", prose)).rejects.toThrow(/unusable|refusing/i);
    expect(edgeCount(d)).toBe(1); // untouched — a garbage-answering model cannot erase the layer
  });

  it("REFUSES when the model returns a NONEMPTY array carrying no usable edge — the layer survives", async () => {
    const d = makeDb();
    await runLlmDensify(d, "v1", oneEdge);
    expect(edgeCount(d)).toBe(1);
    // The subtlest outage of all, and the one the first guard missed: valid JSON, a nonempty ARRAY, so
    // the array-ness check passes — but nothing in it survives parseSemanticEdges. Zero accepted edges,
    // downstream indistinguishable from a genuine "no relationships found".
    for (const text of [
      JSON.stringify(["I cannot help with that."]),
      JSON.stringify([{ source: "GHOST.md", target: "NOPE.md", confidence: 0.95 }]),
    ]) {
      const junk = { extract: async () => ({ text, model: "m" }) } as unknown as GatewayClient;
      await expect(runLlmDensify(d, "v1", junk)).rejects.toThrow(/unusable|refusing/i);
      expect(edgeCount(d)).toBe(1); // untouched
    }
  });

  it("a LITERAL empty array is still a TRUSTWORTHY empty answer — it DOES prune", async () => {
    const d = makeDb();
    await runLlmDensify(d, "v1", oneEdge);
    expect(edgeCount(d)).toBe(1);
    // The other edge of the same blade. `[]` means the model looked and found nothing; that IS
    // authoritative, and a full-state reconcile SHOULD drop the now-stale edge. Refusing here too would
    // make the layer append-only and un-prunable, which is a different bug in the opposite direction.
    const empty = { extract: async () => ({ text: "[]", model: "m" }) } as unknown as GatewayClient;
    const res = await runLlmDensify(d, "v1", empty);
    expect(res.edges).toBe(0);
    expect(edgeCount(d)).toBe(0);
  });

  it("batches deterministically (notes ordered by path), so the model sees a stable pairing", async () => {
    const d = makeDb();
    const seen: string[][] = [];
    const spy = {
      extract: async (req: any) => {
        const user = req.messages[1].content as string;
        seen.push([...user.matchAll(/path="([^"]+)"/g)].map((m) => m[1] as string));
        return { text: "[]", model: "m" };
      },
    } as unknown as GatewayClient;
    await runLlmDensify(d, "v1", spy, { batchSize: 10 });
    expect(seen[0]).toEqual(["A.md", "B.md"]); // ORDER BY path, not incidental row order
  });
});
