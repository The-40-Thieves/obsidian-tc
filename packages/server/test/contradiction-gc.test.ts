// #280-followup (mining knowledge-mcp-server / vault-sync): the contradictions plane table was
// insert-only, so a chunk's "open" flags outlived the chunk when its content changed or its note
// was deleted, polluting the synthesis / knowledge_challenge / reflect grounding. The indexer now
// GCs a chunk's flags on prune + re-embed (applyNoteWrites) and on note delete (deindexNote).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/types";
import { makeM2Vault } from "./m2-helpers";

function insertContradiction(db: Database, sourceChunkId: string): void {
  db.prepare(
    "INSERT INTO contradictions (id, source_chunk_id, source_path, conflict_chunk_id, conflict_path, source_content_sha, conflict_content_sha, cosine_similarity, judge_verdict, judge_rationale, judge_model, status, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
  ).run(
    `ctr_${sourceChunkId}`,
    sourceChunkId,
    "a.md",
    "some-other-chunk",
    "b.md",
    "sha_a",
    "sha_b",
    0.9,
    "contradiction",
    "rationale",
    "model",
    1,
  );
}

function contraCount(db: Database): number {
  return (db.prepare("SELECT count(*) AS c FROM contradictions").get() as { c: number }).c;
}

function chunkIdOf(db: Database, path: string): string {
  return (db.prepare("SELECT id FROM chunks WHERE path = ?").get(path) as { id: string }).id;
}

describe("contradiction-row GC (indexer ties flag lifetime to chunk lifetime)", () => {
  it("drops a chunk's contradictions when its content changes", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nfirst body" } });
    try {
      await v.call("index_vault", { vault: "test" });
      insertContradiction(v.db, chunkIdOf(v.db, "a.md"));
      expect(contraCount(v.db)).toBe(1);

      v.write("a.md", "# A\n\ncompletely rewritten body");
      await v.call("index_vault", { vault: "test" });
      expect(contraCount(v.db)).toBe(0);
    } finally {
      v.cleanup();
    }
  });

  it("drops a chunk's contradictions when its note is deleted", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nbody", "b.md": "# B\n\nother" } });
    try {
      await v.call("index_vault", { vault: "test" });
      insertContradiction(v.db, chunkIdOf(v.db, "a.md"));
      expect(contraCount(v.db)).toBe(1);

      rmSync(join(v.root, "a.md"));
      await v.call("index_vault", { vault: "test" });
      expect(contraCount(v.db)).toBe(0);
    } finally {
      v.cleanup();
    }
  });

  it("keeps contradictions for an unchanged chunk on re-index", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nstable body" } });
    try {
      await v.call("index_vault", { vault: "test" });
      insertContradiction(v.db, chunkIdOf(v.db, "a.md"));

      await v.call("index_vault", { vault: "test" }); // no content change
      expect(contraCount(v.db)).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});
