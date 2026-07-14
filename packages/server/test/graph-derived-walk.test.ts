import { describe, expect, it } from "vitest";
import { expandGraphLiteral } from "../src/search/graph_expand";
import { openMemoryDb } from "./helpers";

function db3(): any {
  const db = openMemoryDb();
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT,
       vault_id TEXT NOT NULL DEFAULT '', confidence REAL, source_fingerprint TEXT,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  const ins = db.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, edge_kind, provenance, created_at, updated_at) VALUES (?,?,?,?,?,?,1,1)",
  );
  // A <-links_to-> B (literal); B ~similar_to~ C (virtual). C is reachable from A only via the
  // derived edge.
  ins.run("v1", "A.md", "B.md", "links_to", "literal", "wikilink_forward");
  ins.run("v1", "B.md", "A.md", "links_to", "literal", "wikilink_reverse");
  ins.run("v1", "B.md", "C.md", "similar_to", "virtual", "cosine_knn");
  return db;
}

describe("expandGraphLiteral — derived edge traversal", () => {
  it("default walk is literal-only: reaches B, never crosses the similar_to edge to C", () => {
    const nodes = expandGraphLiteral(db3(), ["A.md"], { vaultId: "v1", hopLimit: 3 });
    expect(nodes.map((n) => n.path).sort()).toEqual(["B.md"]);
    expect(nodes.every((n) => n.edge_kind === "literal")).toBe(true);
  });

  it("includeDerived crosses the similar_to edge: reaches C at hop 2, tagged virtual", () => {
    const nodes = expandGraphLiteral(db3(), ["A.md"], {
      vaultId: "v1",
      hopLimit: 3,
      includeDerived: true,
    });
    const byPath = new Map(nodes.map((n) => [n.path, n]));
    expect([...byPath.keys()].sort()).toEqual(["B.md", "C.md"]);
    expect(byPath.get("B.md")?.edge_kind).toBe("literal");
    const c = byPath.get("C.md");
    expect(c?.hop).toBe(2);
    expect(c?.edge_kind).toBe("virtual");
    expect(c?.via_edge_type).toBe("similar_to");
    expect(c?.via_edge_provenance).toBe("cosine_knn");
  });

  it("vault-scoped: a derived edge in another vault is never crossed", () => {
    const db = db3();
    db.prepare(
      "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, edge_kind, provenance, created_at, updated_at) VALUES ('v2','C.md','Z.md','similar_to','virtual','cosine_knn',1,1)",
    ).run();
    const nodes = expandGraphLiteral(db, ["A.md"], {
      vaultId: "v1",
      hopLimit: 5,
      includeDerived: true,
    });
    expect(nodes.some((n) => n.path === "Z.md")).toBe(false);
  });
});
