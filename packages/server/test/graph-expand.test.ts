import { describe, expect, it } from "vitest";
import { expandGraphLiteral } from "../src/search/graph_expand";
import { openMemoryDb } from "./helpers";

function dbWithEdges(edges: Array<[string, string, string]>, vaultId = "v1"): any {
  const db = openMemoryDb();
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT,
       vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  const ins = db.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, provenance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)",
  );
  for (const [s, t, prov] of edges) ins.run(vaultId, s, t, "links_to", prov);
  return db;
}

describe("expandGraphLiteral (GraphRAG walk port)", () => {
  it("walks links_to to hop 2 with predecessor + root_seed tracking", () => {
    // A -> B -> C (forward + reverse rows, as KMS ingest produces).
    const db = dbWithEdges([
      ["A.md", "B.md", "wikilink_forward"],
      ["B.md", "A.md", "wikilink_reverse"],
      ["B.md", "C.md", "wikilink_forward"],
      ["C.md", "B.md", "wikilink_reverse"],
    ]);
    const nodes = expandGraphLiteral(db, ["A.md"], { vaultId: "v1", hopLimit: 2 });
    const byPath = new Map(nodes.map((n) => [n.path, n]));
    expect([...byPath.keys()].sort()).toEqual(["B.md", "C.md"]); // seed A excluded (hop 0)
    expect(byPath.get("B.md")?.hop).toBe(1);
    expect(byPath.get("B.md")?.predecessor_path).toBe("A.md");
    expect(byPath.get("B.md")?.root_seed).toBe("A.md");
    expect(byPath.get("C.md")?.hop).toBe(2);
    expect(byPath.get("C.md")?.predecessor_path).toBe("B.md");
    expect(byPath.get("C.md")?.edge_kind).toBe("literal");
  });

  it("respects hopLimit", () => {
    const db = dbWithEdges([
      ["A.md", "B.md", "wikilink_forward"],
      ["B.md", "C.md", "wikilink_forward"],
    ]);
    const nodes = expandGraphLiteral(db, ["A.md"], { vaultId: "v1", hopLimit: 1 });
    expect(nodes.map((n) => n.path)).toEqual(["B.md"]); // C is hop 2, excluded
  });

  it("traverses undirected even when only the forward edge is stored", () => {
    // Only A -> B stored; seeding from B must still reach A (undirected links_to).
    const db = dbWithEdges([["A.md", "B.md", "wikilink_forward"]]);
    const nodes = expandGraphLiteral(db, ["B.md"], { vaultId: "v1", hopLimit: 2 });
    expect(nodes.map((n) => n.path)).toEqual(["A.md"]);
    expect(nodes[0]?.hop).toBe(1);
  });

  it("cycle-guards (A<->B) and returns each reached node once, shallowest hop", () => {
    const db = dbWithEdges([
      ["A.md", "B.md", "wikilink_forward"],
      ["B.md", "A.md", "wikilink_reverse"],
    ]);
    const nodes = expandGraphLiteral(db, ["A.md"], { vaultId: "v1", hopLimit: 3 });
    expect(nodes.map((n) => n.path)).toEqual(["B.md"]);
    expect(nodes[0]?.hop).toBe(1);
  });

  it("returns nothing for empty seeds", () => {
    const db = dbWithEdges([["A.md", "B.md", "wikilink_forward"]]);
    expect(expandGraphLiteral(db, [], { vaultId: "v1", hopLimit: 2 })).toEqual([]);
  });

  it("scopes the walk to vault_id — never crosses into another vault's edges (THE-310)", () => {
    const db = dbWithEdges([["A.md", "B.md", "wikilink_forward"]], "v1");
    // A different vault has A -> Z; it must not leak into v1's expansion from A.
    db.prepare(
      "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, provenance, created_at, updated_at) VALUES ('v2', 'A.md', 'Z.md', 'links_to', 'wikilink_forward', 0, 0)",
    ).run();
    const v1 = expandGraphLiteral(db, ["A.md"], { vaultId: "v1", hopLimit: 2 });
    expect(v1.map((n) => n.path)).toEqual(["B.md"]); // Z.md (v2) excluded
    const v2 = expandGraphLiteral(db, ["A.md"], { vaultId: "v2", hopLimit: 2 });
    expect(v2.map((n) => n.path)).toEqual(["Z.md"]); // B.md (v1) excluded
  });
});
