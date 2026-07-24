// THE-491 item 3: list_contradictions — contradiction detection writes the `contradictions`
// table, but results previously only surfaced indirectly (folded into vault_context / reflect /
// knowledge_challenge via openContradictionsForPaths). This is the direct reader: same plumbing,
// no composition, so a caller can inspect flagged conflicts on a note set standalone.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const VAULT = "v1";

function dbWithContradictions(): any {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const ins = db.prepare(
    `INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path,
       source_content_sha, conflict_content_sha, judge_verdict, judge_rationale, status, detected_at)
     VALUES (?, ?, 'sc', ?, 'cc', ?, ?, ?, ?, 'because', ?, 0)`,
  );
  ins.run("c1", VAULT, "notes/a.md", "notes/z.md", "s1", "x1", "contradiction", "open"); // source side
  ins.run("c2", VAULT, "notes/y.md", "notes/b.md", "s2", "x2", "tension", "open"); // conflict side
  ins.run("c3", VAULT, "notes/a.md", "notes/w.md", "s3", "x3", "contradiction", "resolved"); // excluded
  return db;
}

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

const root = mkdtempSync(join(tmpdir(), "obtc-list-contra-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function harness(scopes: string[], acl?: FolderAcl) {
  const registry = new ToolRegistry({});
  const vaultRegistry = new VaultRegistry([{ id: VAULT, name: VAULT, path: root }]);
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: { provider: "ollama", model: "stub", embed: async () => [] } as any,
    reranker: null,
    roles: null,
  });
  const ctx = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(scopes),
    vaultId: VAULT,
    db: dbWithContradictions(),
    now: () => 0,
    ...(acl ? { acl } : {}),
  };
  return { registry, ctx };
}

interface ContraData {
  vault: string;
  available: boolean;
  total: number;
  contradictions: Array<{ id: string; source_path: string; conflict_path: string }>;
}

describe("list_contradictions (THE-491)", () => {
  it("is denied without read:notes", async () => {
    const { registry, ctx } = harness([]);
    const r = (await registry.dispatch(
      "list_contradictions",
      { vault: VAULT, paths: ["notes/a.md"] },
      ctx,
    )) as { ok: boolean };
    expect(r.ok).toBe(false);
  });

  it("returns open rows touching either side of the given paths; excludes resolved", async () => {
    const { registry, ctx } = harness(["read:notes"]);
    const res = un<ContraData>(
      await registry.dispatch(
        "list_contradictions",
        { vault: VAULT, paths: ["notes/a.md", "notes/b.md"] },
        ctx,
      ),
    );
    expect(res.available).toBe(true);
    expect(res.total).toBe(2);
    expect(res.contradictions.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("returns none of the unrelated pair (path not requested)", async () => {
    const { registry, ctx } = harness(["read:notes"]);
    const res = un<ContraData>(
      await registry.dispatch("list_contradictions", { vault: VAULT, paths: ["notes/z.md"] }, ctx),
    );
    expect(res.total).toBe(1);
    expect(res.contradictions[0]?.id).toBe("c1");
  });

  it("reports available:false on a pre-migration db lacking the contradictions table", async () => {
    const { registry, ctx } = harness(["read:notes"]);
    const bare = openMemoryDb();
    bare.exec("CREATE TABLE notes (vault_id TEXT, path TEXT)");
    const res = un<ContraData>(
      await registry.dispatch(
        "list_contradictions",
        { vault: VAULT, paths: ["notes/a.md"] },
        { ...ctx, db: bare },
      ),
    );
    expect(res.available).toBe(false);
    expect(res.total).toBe(0);
    expect(res.contradictions).toEqual([]);
  });

  it("denies a path outside the caller's read ACL", async () => {
    const { registry, ctx } = harness(
      ["read:notes"],
      new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths: ["public/**"] }),
    );
    const r = (await registry.dispatch(
      "list_contradictions",
      { vault: VAULT, paths: ["notes/a.md"] },
      ctx,
    )) as { ok: boolean };
    expect(r.ok).toBe(false);
  });

  it("rejects an empty paths array", async () => {
    const { registry, ctx } = harness(["read:notes"]);
    const r = (await registry.dispatch(
      "list_contradictions",
      { vault: VAULT, paths: [] },
      ctx,
    )) as {
      ok: boolean;
    };
    expect(r.ok).toBe(false);
  });

  it("drops a contradiction whose conflict-side note is unreadable (THE-564)", async () => {
    // ACL grants read on "notes/**" but not "private/**". Row: source in notes/, conflict in private/.
    const readableNotesOnly = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["notes/**"],
    });
    const { registry, ctx } = harness(["read:notes"], readableNotesOnly);
    const db = openMemoryDb();
    provisionCacheDb(db);
    db.prepare(
      `INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id,
         conflict_path, source_content_sha, conflict_content_sha, judge_verdict, status, detected_at)
       VALUES ('x', ?, 'sc', 'notes/a.md', 'cc', 'private/b.md', 's1', 's2', 'tension', 'open', 0)`,
    ).run(VAULT);
    const res = un<ContraData>(
      await registry.dispatch(
        "list_contradictions",
        { vault: VAULT, paths: ["notes/a.md"] },
        { ...ctx, db },
      ),
    );
    expect(res.contradictions).toEqual([]);
  });
});
