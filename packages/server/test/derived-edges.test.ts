import { describe, expect, it } from "vitest";
import {
  type DerivedEdge,
  knnEdgesFromNeighbors,
  reconcileDerivedEdges,
  tagCooccurrenceEdges,
} from "../src/search/derived-edges";
import { openMemoryDb } from "./helpers";

function edgesDb(): any {
  const db = openMemoryDb();
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT,
       vault_id TEXT NOT NULL DEFAULT '',
       confidence REAL, source_fingerprint TEXT,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );
     CREATE UNIQUE INDEX idx_vault_edges_unique ON vault_edges(vault_id, source_path, target_path, edge_type);`,
  );
  return db;
}

describe("tagCooccurrenceEdges", () => {
  it("emits one undirected edge per note pair sharing a tag, in canonical path order", () => {
    const edges = tagCooccurrenceEdges(
      new Map([
        ["B.md", ["ml", "notes"]],
        ["A.md", ["ml"]],
        ["C.md", ["ml"]],
      ]),
    );
    // 3 notes share "ml" -> pairs (A,B),(A,C),(B,C); "notes" is a singleton -> no edge.
    expect(edges.map((e) => `${e.source_path}->${e.target_path}`).sort()).toEqual([
      "A.md->B.md",
      "A.md->C.md",
      "B.md->C.md",
    ]);
    expect(edges.every((e) => e.edge_type === "shared_tag" && e.edge_kind === "derived")).toBe(
      true,
    );
    expect(edges.every((e) => e.provenance === "tag_cooccur" && e.confidence === null)).toBe(true);
  });

  it("excludes hub tags above maxTagFanout and singleton tags", () => {
    const notesTags = new Map<string, string[]>();
    for (let i = 0; i < 5; i++) notesTags.set(`n${i}.md`, ["hub", "pair"]);
    // Both tags sit on all 5 notes; maxTagFanout 3 excludes them as hubs.
    expect(tagCooccurrenceEdges(notesTags, { maxTagFanout: 3 })).toEqual([]);
    // Raise the cap: 5 notes -> 10 unique pairs; the two tags cover the same pairs (deduped).
    expect(tagCooccurrenceEdges(notesTags, { maxTagFanout: 10 }).length).toBe(10);
  });

  it("dedupes a pair sharing multiple tags and normalizes case/whitespace", () => {
    const edges = tagCooccurrenceEdges(
      new Map([
        ["A.md", ["ML", " ml ", "rag"]],
        ["B.md", ["ml", "RAG"]],
      ]),
    );
    expect(edges.length).toBe(1);
    expect(edges[0]).toMatchObject({ source_path: "A.md", target_path: "B.md" });
  });
});

describe("reconcileDerivedEdges", () => {
  const mk = (s: string, t: string): DerivedEdge => ({
    source_path: s,
    target_path: t,
    edge_type: "shared_tag",
    edge_kind: "derived",
    provenance: "tag_cooccur",
    confidence: null,
    source_fingerprint: null,
  });

  it("inserts, is idempotent, and prunes stale derived edges", () => {
    const db = edgesDb();
    expect(
      reconcileDerivedEdges(
        db,
        "v1",
        [mk("A.md", "B.md"), mk("A.md", "C.md")],
        ["shared_tag"],
        () => 1,
      ).inserted,
    ).toBe(2);
    expect(
      reconcileDerivedEdges(
        db,
        "v1",
        [mk("A.md", "B.md"), mk("A.md", "C.md")],
        ["shared_tag"],
        () => 2,
      ).inserted,
    ).toBe(0);
    expect(
      reconcileDerivedEdges(db, "v1", [mk("A.md", "B.md")], ["shared_tag"], () => 3).deleted,
    ).toBe(1);
  });

  it("never touches the literal layer — a links_to row survives a derived reconcile to empty", () => {
    const db = edgesDb();
    db.prepare(
      "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, edge_kind, provenance, created_at, updated_at) VALUES ('v1','A.md','B.md','links_to','literal','wikilink_forward',1,1)",
    ).run();
    reconcileDerivedEdges(db, "v1", [mk("A.md", "C.md")], ["shared_tag"], () => 1);
    const stats = reconcileDerivedEdges(db, "v1", [], ["shared_tag"], () => 2);
    expect(stats.deleted).toBe(1); // only the shared_tag edge is pruned
    const rows = db.prepare("SELECT edge_type FROM vault_edges").all() as Array<{
      edge_type: string;
    }>;
    expect(rows).toEqual([{ edge_type: "links_to" }]); // the literal edge is untouched
  });

  it("stays vault-scoped — the same pair coexists across vaults", () => {
    const db = edgesDb();
    reconcileDerivedEdges(db, "v1", [mk("A.md", "B.md")], ["shared_tag"], () => 1);
    reconcileDerivedEdges(db, "v2", [mk("A.md", "B.md")], ["shared_tag"], () => 2);
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM vault_edges WHERE source_path = 'A.md'")
      .get() as { n: number };
    expect(n.n).toBe(2);
    reconcileDerivedEdges(db, "v2", [], ["shared_tag"], () => 3); // reindex v2 to empty
    const survived = db
      .prepare("SELECT vault_id FROM vault_edges WHERE source_path = 'A.md'")
      .all() as Array<{ vault_id: string }>;
    expect(survived.map((r) => r.vault_id)).toEqual(["v1"]);
  });

  it("rejects a desired edge outside the owned edge_types (stale-delete guard)", () => {
    const db = edgesDb();
    const rogue: DerivedEdge = { ...mk("A.md", "B.md"), edge_type: "similar_to" };
    expect(() => reconcileDerivedEdges(db, "v1", [rogue], ["shared_tag"], () => 1)).toThrow();
  });
});

describe("knnEdgesFromNeighbors", () => {
  it("emits one similar_to edge per neighbor note, canonical order, confidence = cosine sim", () => {
    const edges = knnEdgesFromNeighbors([
      { source_path: "A.md", target_path: "B.md", sim: 0.9 },
      { source_path: "A.md", target_path: "A.md", sim: 1.0 }, // self — dropped
    ]);
    expect(edges).toEqual([
      {
        source_path: "A.md",
        target_path: "B.md",
        edge_type: "similar_to",
        edge_kind: "virtual",
        provenance: "cosine_knn",
        confidence: 0.9,
        source_fingerprint: null,
      },
    ]);
  });

  it("keeps the strongest chunk-pair sim per note pair and collapses both directions to one edge", () => {
    const edges = knnEdgesFromNeighbors([
      { source_path: "A.md", target_path: "B.md", sim: 0.6 },
      { source_path: "B.md", target_path: "A.md", sim: 0.82 }, // reverse, stronger
    ]);
    expect(edges.length).toBe(1);
    expect(edges[0]).toMatchObject({ source_path: "A.md", target_path: "B.md", confidence: 0.82 });
  });

  it("drops pairs below minSim and keeps only each source's top-k", () => {
    const neighbors = [
      { source_path: "A.md", target_path: "B.md", sim: 0.9 },
      { source_path: "A.md", target_path: "C.md", sim: 0.8 },
      { source_path: "A.md", target_path: "D.md", sim: 0.4 }, // below minSim
    ];
    const top1 = knnEdgesFromNeighbors(neighbors, { k: 1, minSim: 0.5 });
    expect(top1.map((e) => e.target_path)).toEqual(["B.md"]); // D filtered, C dropped by k=1
  });
});

describe("reconcileDerivedEdges — upsert semantics", () => {
  it("refreshes confidence + fingerprint on an existing edge instead of keeping the stale value", () => {
    const db = edgesDb();
    const before: DerivedEdge = {
      source_path: "A.md",
      target_path: "B.md",
      edge_type: "similar_to",
      edge_kind: "virtual",
      provenance: "cosine_knn",
      confidence: 0.5,
      source_fingerprint: "old",
    };
    expect(reconcileDerivedEdges(db, "v1", [before], ["similar_to"], () => 1).inserted).toBe(1);
    // Same (source, target, edge_type) — the row key is unchanged, so INSERT OR IGNORE would have kept
    // confidence 0.5 forever. The upsert must refresh the scored fields in place.
    const after: DerivedEdge = { ...before, confidence: 0.9, source_fingerprint: "new" };
    const stats = reconcileDerivedEdges(db, "v1", [after], ["similar_to"], () => 2);
    expect(stats.inserted).toBe(0);
    expect(stats.updated).toBe(1);
    const row = db.prepare("SELECT confidence, source_fingerprint FROM vault_edges").get() as {
      confidence: number;
      source_fingerprint: string;
    };
    expect(row.confidence).toBe(0.9);
    expect(row.source_fingerprint).toBe("new");
  });
});
