import { describe, expect, it } from "vitest";
import { type DesiredEdge, desiredEdges, reconcileVaultEdges } from "../src/search/edges";
import { extractLinks } from "../src/vault/links";
import { openMemoryDb } from "./helpers";

function vaultEdgesDb(): any {
  const db = openMemoryDb();
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );
     CREATE UNIQUE INDEX idx_vault_edges_unique ON vault_edges(source_path, target_path, edge_type);`,
  );
  return db;
}

describe("vault_edges production (W-INGEST)", () => {
  it("resolved [[wikilink]] -> forward + reverse links_to; unresolved -> forward-only", () => {
    const notePaths = ["A.md", "B.md"];
    const noteLinks = new Map([
      ["A.md", extractLinks("see [[B]] and [[Ghost]]")],
      ["B.md", extractLinks("no links here")],
    ]);
    const edges = desiredEdges(noteLinks, notePaths);
    const has = (s: string, t: string, type: string, prov: string): boolean =>
      edges.some(
        (e) =>
          e.source_path === s &&
          e.target_path === t &&
          e.edge_type === type &&
          e.provenance === prov,
      );
    expect(has("A.md", "B.md", "links_to", "wikilink_forward")).toBe(true);
    expect(has("B.md", "A.md", "links_to", "wikilink_reverse")).toBe(true);
    expect(has("A.md", "Ghost", "unresolved", "unresolved")).toBe(true);
    // unresolved links are forward-only (no reverse row).
    expect(edges.some((e) => e.source_path === "Ghost")).toBe(false);
  });

  it("ignores code-block links, markdown links, and self-loops", () => {
    const noteLinks = new Map([["A.md", extractLinks("```\n[[B]]\n```\n[md](B.md) and [[A]]")]]);
    const edges = desiredEdges(noteLinks, ["A.md", "B.md"]);
    expect(edges.length).toBe(0);
  });

  it("reconcileVaultEdges inserts, is idempotent, and prunes stale edges (edge_kind=literal)", () => {
    const db = vaultEdgesDb();
    const fwd: DesiredEdge = {
      source_path: "A.md",
      target_path: "B.md",
      edge_type: "links_to",
      provenance: "wikilink_forward",
    };
    const rev: DesiredEdge = {
      source_path: "B.md",
      target_path: "A.md",
      edge_type: "links_to",
      provenance: "wikilink_reverse",
    };
    expect(reconcileVaultEdges(db, [fwd, rev], () => 1).inserted).toBe(2);
    expect(reconcileVaultEdges(db, [fwd, rev], () => 2).inserted).toBe(0); // idempotent
    expect(reconcileVaultEdges(db, [fwd], () => 3).deleted).toBe(1); // rev pruned
    const rows = db.prepare("SELECT edge_kind FROM vault_edges").all() as Array<{
      edge_kind: string;
    }>;
    expect(rows.every((r) => r.edge_kind === "literal")).toBe(true);
  });
});
