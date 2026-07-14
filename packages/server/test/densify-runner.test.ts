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

describe("runLlmDensify", () => {
  it("assembles notes from chunks, extracts via the gateway, reconciles semantically_similar_to edges", async () => {
    const client = {
      extract: async () => ({
        text: '[{"source":"A.md","target":"B.md","confidence":0.75}]',
        model: "local",
      }),
    } as unknown as GatewayClient;
    const d = makeDb();
    const res = await runLlmDensify(d, "v1", client);
    expect(res).toEqual({ notes: 2, edges: 1 }); // A.md (2 chunks collapsed) + B.md
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

  it("is full-state: a re-run returning nothing prunes the prior LLM layer", async () => {
    const d = makeDb();
    const yes = {
      extract: async () => ({
        text: '[{"source":"A.md","target":"B.md","confidence":0.75}]',
        model: "m",
      }),
    } as unknown as GatewayClient;
    await runLlmDensify(d, "v1", yes);
    const empty = { extract: async () => ({ text: "[]", model: "m" }) } as unknown as GatewayClient;
    const res = await runLlmDensify(d, "v1", empty);
    expect(res.edges).toBe(0);
    expect((d.prepare("SELECT COUNT(*) AS n FROM vault_edges").get() as { n: number }).n).toBe(0);
  });
});
