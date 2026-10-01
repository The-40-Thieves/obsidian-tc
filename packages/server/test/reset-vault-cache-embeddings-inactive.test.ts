// reset_vault_cache's `include.embeddings` was a blanket boolean that drops every chunk_embeddings
// row for a vault. `"inactive"` is a finer selector: drop only rows for embedding generations the
// vault is no longer searching with (chunk_embeddings.is_active = 0 — the SAME column
// embeddings/sticky-provider.ts already treats as the source of truth for "the vault's current
// embedding identity", see queryActiveEmbeddingModels). Active rows (is_active = 1), and by
// construction vec_chunks (which only ever holds active, dimension-matching rows — see
// search/vec.ts's ensureVecChunks backfill), must survive untouched.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { deterministicVector } from "../src/embeddings";
import { argsHash } from "../src/hash";
import type { CallerContext } from "../src/mcp/registry";
import { ToolRegistry } from "../src/mcp/registry";
import { semanticSearch } from "../src/search/semantic";
import { floatBlob } from "../src/search/vec";
import { registerM1Tools } from "../src/tools/m1";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const DIMS = 16;

interface Harness {
  root: string;
  db: Database;
  call: (
    name: string,
    input: Record<string, unknown>,
    over?: Partial<CallerContext>,
  ) => ReturnType<ToolRegistry["dispatch"]>;
  cleanup: () => void;
}

function makeHarness(extraVaultIds: readonly string[] = []): Harness {
  const root = makeTempDir("obtc-emb-inactive-");
  const abs = join(root, "a.md");
  writeFileSync(abs, "alpha content here");
  const db = openMemoryDb();
  provisionCacheDb(db);
  const vaultRegistry = new VaultRegistry([
    { id: "test", path: root },
    ...extraVaultIds.map((id) => ({ id, path: root })),
  ]);
  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "fake", model: "B" },
  });
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "test",
    db,
    ...over,
  });
  return {
    root,
    db,
    call: (name, input, over) => registry.dispatch(name, input, ctx(over)),
    cleanup: () => rmTemp(root),
  };
}

// Seeds one chunk with two embedding generations: an inactive "fake:A" row and an active
// "fake:B" row — the exact shape a real model swap leaves (see model-swap-reembed.test.ts).
function seedTwoGenerations(db: Database, vaultId: string, chunkId: string, content: string): void {
  const now = 1000;
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(chunkId, vaultId, "a.md", "0", "[]", content, "hash1", 3, now, now);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?,?,?,?,?,?)",
  ).run(chunkId, "fake:A", DIMS, floatBlob(deterministicVector(content, DIMS)), 0, now - 1);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?,?,?,?,?,?)",
  ).run(chunkId, "fake:B", DIMS, floatBlob(deterministicVector(content, DIMS)), 1, now);
}

function seedOneGeneration(db: Database, vaultId: string, chunkId: string, content: string): void {
  const now = 1000;
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(chunkId, vaultId, "a.md", "0", "[]", content, "hash1", 3, now, now);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?,?,?,?,?,?)",
  ).run(chunkId, "fake:B", DIMS, floatBlob(deterministicVector(content, DIMS)), 1, now);
}

async function resetWithElicit(
  h: Harness,
  input: Record<string, unknown>,
): Promise<Awaited<ReturnType<ToolRegistry["dispatch"]>>> {
  const need = await h.call("reset_vault_cache", input);
  expect(need.ok).toBe(false);
  if (need.ok) throw new Error("expected elicit_required");
  expect(need.error.code).toBe("elicit_required");
  const token = issueElicitToken(h.db, {
    vaultId: "test",
    toolName: "reset_vault_cache",
    argsHash: argsHash("reset_vault_cache", input),
    caller: "test",
  });
  return h.call("reset_vault_cache", input, { elicitToken: token });
}

describe('reset_vault_cache include.embeddings: "inactive"', () => {
  it("drops only the non-active generation; search still works on the active one", async () => {
    const h = makeHarness();
    try {
      const content = "alpha content here";
      seedTwoGenerations(h.db, "test", "c1", content);

      const input = { vault: "test", include: { chunks: false, embeddings: "inactive" } };
      const ok = await resetWithElicit(h, input);
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        const d = ok.data as { rows_dropped: { embeddings: number } };
        expect(d.rows_dropped.embeddings).toBe(1);
      }

      const remaining = h.db
        .prepare("SELECT model, is_active FROM chunk_embeddings WHERE chunk_id = ? ORDER BY model")
        .all("c1") as Array<{ model: string; is_active: number }>;
      expect(remaining).toEqual([{ model: "fake:B", is_active: 1 }]);

      // search still finds the chunk under the surviving active model
      const queryVec = deterministicVector(content, DIMS);
      const hits = semanticSearch(h.db, "test", queryVec, { k: 5, model: "fake:B" });
      expect(hits.some((x) => x.chunk_id === "c1")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("true still drops everything (boolean behaviour unchanged)", async () => {
    const h = makeHarness();
    try {
      seedTwoGenerations(h.db, "test", "c1", "alpha content here");
      const input = { vault: "test", include: { embeddings: true } };
      const ok = await resetWithElicit(h, input);
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        const d = ok.data as { rows_dropped: { embeddings: number } };
        expect(d.rows_dropped.embeddings).toBe(2);
      }
      const remaining = h.db
        .prepare("SELECT COUNT(*) AS n FROM chunk_embeddings WHERE chunk_id = ?")
        .get("c1") as { n: number };
      expect(remaining.n).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('a vault with only the active generation: "inactive" drops nothing', async () => {
    const h = makeHarness();
    try {
      seedOneGeneration(h.db, "test", "c1", "alpha content here");
      const input = { vault: "test", include: { chunks: false, embeddings: "inactive" } };
      const ok = await resetWithElicit(h, input);
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        const d = ok.data as { rows_dropped: { embeddings: number } };
        expect(d.rows_dropped.embeddings).toBe(0);
      }
      const remaining = h.db
        .prepare("SELECT model, is_active FROM chunk_embeddings WHERE chunk_id = ?")
        .all("c1") as Array<{ model: string; is_active: number }>;
      expect(remaining).toEqual([{ model: "fake:B", is_active: 1 }]);
    } finally {
      h.cleanup();
    }
  });

  it("scopes to the target vault only; another vault's inactive rows survive", async () => {
    const h = makeHarness(["other"]);
    try {
      seedTwoGenerations(h.db, "test", "c1", "alpha content here");
      seedTwoGenerations(h.db, "other", "c2", "beta content here");

      const input = { vault: "test", include: { chunks: false, embeddings: "inactive" } };
      const ok = await resetWithElicit(h, input);
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        const d = ok.data as { rows_dropped: { embeddings: number } };
        expect(d.rows_dropped.embeddings).toBe(1);
      }

      // "other" vault's inactive row was never touched — the DELETE scopes to the target
      // vault's chunk ids only.
      const otherRemaining = h.db
        .prepare("SELECT model, is_active FROM chunk_embeddings WHERE chunk_id = ? ORDER BY model")
        .all("c2") as Array<{ model: string; is_active: number }>;
      expect(otherRemaining).toEqual([
        { model: "fake:A", is_active: 0 },
        { model: "fake:B", is_active: 1 },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it("rejects an unrecognized include.embeddings string", async () => {
    const h = makeHarness();
    try {
      const r = await h.call("reset_vault_cache", {
        vault: "test",
        include: { embeddings: "bogus" },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("validation_error");
    } finally {
      h.cleanup();
    }
  });
});
