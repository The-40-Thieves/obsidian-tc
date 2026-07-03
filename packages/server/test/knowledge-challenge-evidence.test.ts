// THE-309: knowledge_challenge enriches evidence with note-level tags (so isDecisionChunk's tag
// rule fires, not just the path prefix) and passes open contradictions touching the evidence into
// the judge. These unit-test the two retrieval helpers that wire that in; the generative core
// (isDecisionChunk / challengeProposal) is covered in challenge.test.ts.
import { describe, expect, it } from "vitest";
import { noteTagsByPath, openContradictionsForPaths } from "../src/tools/m7/knowledge-tools";
import { openMemoryDb } from "./helpers";

function dbWithNotesAndContradictions(): any {
  const db = openMemoryDb();
  db.exec(
    `CREATE TABLE notes (vault_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL,
       tags TEXT NOT NULL, frontmatter TEXT, content_hash TEXT NOT NULL, mtime INTEGER NOT NULL,
       size INTEGER NOT NULL, indexed_at INTEGER NOT NULL, PRIMARY KEY (vault_id, path));
     CREATE TABLE contradictions (id TEXT PRIMARY KEY, source_chunk_id TEXT NOT NULL,
       source_path TEXT NOT NULL, conflict_chunk_id TEXT NOT NULL, conflict_path TEXT NOT NULL,
       source_content_sha TEXT NOT NULL, conflict_content_sha TEXT NOT NULL, cosine_similarity REAL,
       judge_verdict TEXT NOT NULL, judge_rationale TEXT, judge_model TEXT,
       status TEXT NOT NULL DEFAULT 'open', detected_at INTEGER NOT NULL, resolved_at INTEGER);`,
  );
  return db;
}

describe("knowledge_challenge evidence enrichment (THE-309)", () => {
  it("noteTagsByPath returns frontmatter tags per path, scoped to the vault", () => {
    const db = dbWithNotesAndContradictions();
    const ins = db.prepare(
      "INSERT INTO notes (vault_id, path, title, tags, content_hash, mtime, size, indexed_at) VALUES (?, ?, '', ?, 'h', 0, 0, 0)",
    );
    ins.run("v1", "notes/a.md", JSON.stringify(["decision", "x"]));
    ins.run("v1", "notes/b.md", JSON.stringify([]));
    ins.run("v2", "notes/a.md", JSON.stringify(["other"])); // different vault, same path
    const tags = noteTagsByPath(db, "v1", ["notes/a.md", "notes/b.md", "notes/missing.md"]);
    expect(tags.get("notes/a.md")).toEqual(["decision", "x"]);
    expect(tags.get("notes/b.md")).toEqual([]);
    expect(tags.has("notes/missing.md")).toBe(false); // not indexed → absent, not empty
    expect(tags.get("notes/a.md")).not.toContain("other"); // v2's tags never leak into v1
  });

  it("openContradictionsForPaths returns open rows touching either side; skips resolved", () => {
    const db = dbWithNotesAndContradictions();
    const ins = db.prepare(
      "INSERT INTO contradictions (id, source_chunk_id, source_path, conflict_chunk_id, conflict_path, source_content_sha, conflict_content_sha, judge_verdict, judge_rationale, status, detected_at) VALUES (?, 'sc', ?, 'cc', ?, ?, ?, 'contradiction', 'because', ?, 0)",
    );
    ins.run("c1", "notes/a.md", "notes/z.md", "s1", "x1", "open"); // source side matches
    ins.run("c2", "notes/y.md", "notes/b.md", "s2", "x2", "open"); // conflict side matches
    ins.run("c3", "notes/a.md", "notes/w.md", "s3", "x3", "resolved"); // resolved → excluded
    const got = openContradictionsForPaths(db, ["notes/a.md", "notes/b.md"]);
    expect(got.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(got.find((c) => c.id === "c1")).toMatchObject({
      source_path: "notes/a.md",
      conflict_path: "notes/z.md",
      judge_verdict: "contradiction",
      judge_rationale: "because",
    });
  });

  it("both helpers degrade to empty when their tables are absent", () => {
    const bare = openMemoryDb();
    expect(noteTagsByPath(bare, "v1", ["a.md"]).size).toBe(0);
    expect(openContradictionsForPaths(bare, ["a.md"])).toEqual([]);
  });
});
