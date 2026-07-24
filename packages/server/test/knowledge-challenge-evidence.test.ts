// THE-309: knowledge_challenge enriches evidence with note-level tags (so isDecisionChunk's tag
// rule fires, not just the path prefix) and passes open contradictions touching the evidence into
// the judge. These unit-test the two retrieval helpers that wire that in; the generative core
// (isDecisionChunk / challengeProposal) is covered in challenge.test.ts.
//
// THE-564: proves the model-egress path end to end — the full `knowledge_challenge` MCP tool,
// dispatched through the real ToolRegistry with a restrictive read ACL, must never let an
// unreadable contradiction side reach the composed judge prompt (Task 5 wired this through the
// filtered openContradictionsForPaths above; this is the guard that would fail if that wiring
// ever regressed), while a contradiction whose both sides ARE readable must still survive.
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import type { GatewayRoles } from "../src/plane/gateway";
import { floatBlob } from "../src/search/vec";
import { registerM7Tools } from "../src/tools/m7";
import { noteTagsByPath, openContradictionsForPaths } from "../src/tools/m7/knowledge-tools";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

function dbWithNotesAndContradictions(): any {
  const db = openMemoryDb();
  db.exec(
    `CREATE TABLE notes (vault_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL,
       tags TEXT NOT NULL, frontmatter TEXT, content_hash TEXT NOT NULL, mtime INTEGER NOT NULL,
       size INTEGER NOT NULL, indexed_at INTEGER NOT NULL, PRIMARY KEY (vault_id, path));
     CREATE TABLE contradictions (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL,
       source_chunk_id TEXT NOT NULL, source_path TEXT NOT NULL, conflict_chunk_id TEXT NOT NULL,
       conflict_path TEXT NOT NULL, source_content_sha TEXT NOT NULL, conflict_content_sha TEXT NOT NULL,
       cosine_similarity REAL, judge_verdict TEXT NOT NULL, judge_rationale TEXT, judge_model TEXT,
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
      "INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path, source_content_sha, conflict_content_sha, judge_verdict, judge_rationale, status, detected_at) VALUES (?, 'v1', 'sc', ?, 'cc', ?, ?, ?, 'contradiction', 'because', ?, 0)",
    );
    ins.run("c1", "notes/a.md", "notes/z.md", "s1", "x1", "open"); // source side matches
    ins.run("c2", "notes/y.md", "notes/b.md", "s2", "x2", "open"); // conflict side matches
    ins.run("c3", "notes/a.md", "notes/w.md", "s3", "x3", "resolved"); // resolved → excluded
    const got = openContradictionsForPaths(db, "v1", ["notes/a.md", "notes/b.md"], () => true);
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
    expect(openContradictionsForPaths(bare, "v1", ["a.md"], () => true)).toEqual([]);
  });
});

describe("knowledge_challenge model-egress guard (THE-564)", () => {
  const VAULT = "v1";
  const QVEC = [1, 0]; // fixed dense vector; matched exactly by every seeded chunk's embedding

  function un<T>(r: unknown): T {
    return (r as { data: T }).data;
  }

  /** A decision-tagged chunk (isDecisionChunk fires on the tag, not the path prefix) with an
   *  embedding identical to the query vector, so it is always the top semantic hit. */
  function seedDecisionChunk(db: any, id: string, path: string): void {
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, '0', '[]', ?, ?, 10, 0, 0)",
    ).run(id, VAULT, path, `evidence body for ${path}`, `h-${id}`);
    db.prepare(
      "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, 'stub-embed', ?, ?, 1, 0)",
    ).run(id, QVEC.length, floatBlob(QVEC));
    db.prepare(
      "INSERT INTO notes (vault_id, path, title, tags, content_hash, mtime, size, indexed_at) VALUES (?, ?, '', ?, 'h', 0, 0, 0)",
    ).run(VAULT, path, JSON.stringify(["decision"]));
  }

  /** Captures the full composed request (system + user) the challenge core sends to the gateway
   *  `judge` role, then returns a canned verdict — the egress path text under test IS this
   *  captured content, not a mock internal. */
  function mockJudgeCapturing(sink: (composed: string) => void): GatewayRoles {
    return {
      extract: async () => ({ text: "", model: "m" }),
      synthesize: async () => ({ text: "", model: "m" }),
      judge: async (req) => {
        sink(req.messages.map((m) => m.content).join("\n"));
        return {
          text: JSON.stringify({ verdict: "proceed", summary: "ok", categories: [] }),
          model: "mock-judge",
        };
      },
    };
  }

  function harness(db: any, acl: FolderAcl, roles: GatewayRoles) {
    const registry = new ToolRegistry({});
    const vaultRegistry = new VaultRegistry([{ id: VAULT, name: VAULT, path: tmpdir() }]);
    registerM7Tools(registry, {
      vaultRegistry,
      embeddingProvider: {
        id: "stub-embed",
        provider: "ollama",
        model: "stub-embed",
        dimensions: QVEC.length,
        embed: async () => [QVEC],
      } as any,
      reranker: null,
      roles,
    });
    const ctx = {
      caller: "tester",
      authenticated: true,
      grantedScopes: new Set(["read:notes"]),
      vaultId: VAULT,
      db,
      now: () => 0,
      acl,
    };
    return { registry, ctx };
  }

  const restrictedToNotes = new FolderAcl({
    readOnly: false,
    defaultScopes: [],
    rules: [],
    readPaths: ["notes/**"],
  });

  it("never sends an unreadable contradiction source to the model (THE-564)", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedDecisionChunk(db, "c1", "notes/a.md"); // source side: readable
    db.prepare(
      `INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id,
         conflict_path, source_content_sha, conflict_content_sha, judge_verdict, judge_rationale,
         status, detected_at)
       VALUES ('x1', ?, 'sc1', 'notes/a.md', 'cc1', 'private/b.md', 's1', 'x1sha', 'tension',
               'private rationale that must never egress', 'open', 0)`,
    ).run(VAULT); // conflict side: private/b.md — outside the ACL

    const seen: string[] = [];
    const { registry, ctx } = harness(
      db,
      restrictedToNotes,
      mockJudgeCapturing((m) => seen.push(m)),
    );
    const res = un<{ available: boolean; evidence_count: number }>(
      await registry.dispatch(
        "knowledge_challenge",
        { vault: VAULT, proposal: "we should proceed with this plan regardless of history" },
        ctx,
      ),
    );
    expect(res.available).toBe(true);
    expect(res.evidence_count).toBeGreaterThan(0); // sanity: the tool actually ran, not short-circuited

    const composed = seen.join("\n");
    expect(composed).not.toContain("private/b.md");
    expect(composed).not.toContain("private rationale that must never egress");
  });

  it("keeps a contradiction whose both sides are readable under the same restrictive ACL (THE-564, folded Task-5 nit)", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedDecisionChunk(db, "c1", "notes/a.md");
    seedDecisionChunk(db, "c2", "notes/c.md"); // both sides readable under notes/**
    db.prepare(
      `INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id,
         conflict_path, source_content_sha, conflict_content_sha, judge_verdict, judge_rationale,
         status, detected_at)
       VALUES ('x2', ?, 'sc2', 'notes/a.md', 'cc2', 'notes/c.md', 's2', 'x2sha', 'tension',
               'both sides readable rationale', 'open', 0)`,
    ).run(VAULT);

    const seen: string[] = [];
    const { registry, ctx } = harness(
      db,
      restrictedToNotes,
      mockJudgeCapturing((m) => seen.push(m)),
    );
    const res = un<{ available: boolean }>(
      await registry.dispatch(
        "knowledge_challenge",
        { vault: VAULT, proposal: "we should proceed with this other plan regardless of history" },
        ctx,
      ),
    );
    expect(res.available).toBe(true);

    const composed = seen.join("\n");
    expect(composed).toContain("notes/c.md");
    expect(composed).toContain("both sides readable rationale");
  });
});
