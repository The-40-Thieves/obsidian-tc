// THE-563 — vault_context's syntheses leg predates the vault_id column syntheses now carries
// (THE-563's own migration, 20260724_001_plane_vault_id.sql): the SELECT LIKE-matched patterns
// across every vault's rows. This pins that a synthesis row written under one vault never
// surfaces through another vault's vault_context call — same harness shape as
// knowledge-search.test.ts / vault-context.test.ts (ToolRegistry + registerM7Tools + a
// no-ACL ctx, so readableRel treats every path as readable and only the query-given path is
// exercised, never the bootstrap/next-session file read).
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATIONS } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const NOW = 1_700_000_000_000;

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

describe("vault_context syntheses are vault-scoped (THE-563)", () => {
  it("does not surface another vault's synthesis patterns", async () => {
    const db = openMemoryDb();
    runMigrations(db, CACHE_MIGRATIONS);

    // A v1 chunk carrying the query term as a corpus-rare token (df=1) so the class router
    // takes the lexical path and never calls the throwing embed stub below.
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('c1', 'v1', 'notes/k8s.md', 0, '[]', ?, 'h1', 40, ?, ?)",
    ).run("the kubernetes drift note", NOW, NOW);
    ensureChunkFts(db, { now: () => NOW, enrich: false });

    // A v2-owned synthesis row whose patterns JSON contains the same significant query token.
    db.prepare(
      "INSERT INTO syntheses (vault_id, iso_year, iso_week, generated_at, cluster_count, pattern_count, clusters, patterns) VALUES ('v2', 2026, 30, 1, 0, 1, '[]', ?)",
    ).run(
      JSON.stringify([
        { title: "kubernetes drift", summary: "s", evidence_paths: [], contradiction_ids: [] },
      ]),
    );

    const registry = new ToolRegistry({});
    const vaultRegistry = new VaultRegistry([
      { id: "v1", name: "v1", path: "/tmp" },
      { id: "v2", name: "v2", path: "/tmp" },
    ]);
    registerM7Tools(registry, {
      vaultRegistry,
      embeddingProvider: {
        provider: "ollama",
        model: "stub",
        embed: async () => {
          throw new Error("embed must not be called on the lexical route");
        },
      } as any,
      reranker: null,
      roles: null,
      classRouter: true,
    });
    const ctx = {
      caller: "tester",
      authenticated: true,
      grantedScopes: new Set(["read:notes"]),
      vaultId: "v1",
      db,
      now: () => NOW,
    };

    const out = un<{ syntheses: Array<{ iso_year: number }> }>(
      await registry.dispatch(
        "vault_context",
        {
          vault: "v1",
          query: "kubernetes",
          token_budget: 4000,
          k: 30,
          include_work: false,
          include_lessons: true,
        },
        ctx,
      ),
    );
    // The v2 synthesis row's pattern text matches the "kubernetes" token, but it must never
    // leak into a v1 call.
    expect(out.syntheses).toEqual([]);
  });
});
