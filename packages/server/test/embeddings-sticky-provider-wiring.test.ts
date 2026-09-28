// GH #995: real-wiring proof that the sticky-embeddings-provider resolution (embeddings/sticky-
// provider.ts) is not just a pure function returning the right answer — the PROVIDER buildServerRuntime
// actually constructs, and every tool surface that reports it, must agree. Uses the SAME
// buildServerRuntime + configFromVaultPath composition root run_serve uses (server-runtime.test.ts's
// own pattern), with a cache.db pre-seeded as if a pre-1.31.4 install had already indexed this vault
// under "ollama" — the exact upgrade scenario GH #995 reports.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { rmTemp } from "./tmp";

// THE-1122 review round 2 (Medium 6): the fixture used to seed 4-dim vectors while production
// resolution forced a hardcoded 768 — the mismatch never failed because the test only asserted
// provider/model, not dimensions. A REALISTIC, non-768 width (1024, matching a real
// mxbai-embed-large index) proves the resolved width actually comes from the stored row.
const SEEDED_DIMENSIONS = 1024;

describe("buildServerRuntime — GH #995 sticky embeddings provider (real wiring)", () => {
  const tmpDirs: string[] = [];
  const tmpDir = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmTemp(d);
      } catch {
        // Best-effort, matching server-runtime.test.ts's other buildServerRuntime tests: a real
        // boot can leave a handle Windows refuses to unlink immediately.
      }
    }
  });

  it("keeps the vault's existing ollama provider — not the current 'local' default — and every reader of config.embeddings agrees", async () => {
    const vaultDir = tmpDir("otc-sticky-vault-");
    const cacheDir = tmpDir("otc-sticky-cache-");

    // Seed cache.db as a pre-1.31.4 install would have left it: an active ollama-model embedding,
    // no `embeddings` config block at all (configFromVaultPath below supplies none).
    const seedDb = await openDatabase(join(cacheDir, "cache.db"));
    provisionCacheDb(seedDb);
    const now = Date.now();
    seedDb
      .prepare(
        `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
         VALUES ('c1', 'main', 'a.md', '0', '[]', 'x', 'hash', 1, ?, ?)`,
      )
      .run(now, now);
    seedDb
      .prepare(
        `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
         VALUES ('c1', 'ollama:mxbai-embed-large', ?, ?, 1, ?)`,
      )
      .run(SEEDED_DIMENSIONS, Buffer.alloc(SEEDED_DIMENSIONS * 4), now);
    seedDb.close?.();

    const config = configFromVaultPath(vaultDir);
    config.cacheDir = cacheDir;
    // configFromVaultPath's synthetic raw object never sets `embeddings` at all — the real
    // "unconfigured install" shape — so finalizeConfig marks config.embeddings NOT explicit (GH
    // #995 fix round 2: read off the config object itself, not a parameter — see
    // embeddings/provider-explicit.ts), same as before this refactor.
    expect(config.embeddings.provider).toBe("local"); // the schema default, before sticky resolution

    const runtime = await buildServerRuntime(
      config,
      undefined,
      undefined,
      true, // planeEnabledExplicit — irrelevant here, matches the "never nag" default
    );
    try {
      // 1) config itself was mutated to the kept provider — every later reader in the SAME
      //    composition (tool-wiring, doctor, etc.) shares this object.
      expect(config.embeddings.provider).toBe("ollama");
      expect(config.embeddings.model).toBe("mxbai-embed-large");
      // THE-1122 review round 2 (High 2): the STORED width, not a hardcoded default — proves the
      // resolver reads chunk_embeddings.dimensions rather than assuming 768 for every reconstructed
      // provider.
      expect(config.embeddings.dimensions).toBe(SEEDED_DIMENSIONS);

      // 2) the ACTUALLY WIRED tool surface — list_vaults' embeddings_provider field, built from
      //    tool-wiring.ts's `deps.embeddings` at construction time, not re-read live — reports the
      //    same kept provider. This is the "not just the resolver's return value" proof: if
      //    server-runtime.ts had mutated config too late (after wireM1Tools captured `deps.embeddings`
      //    by reference at a stale value, or a copy), this would still read "local".
      const probeDb = await openDatabase(join(cacheDir, "cache.db"), undefined, { readonly: true });
      try {
        const result = await runtime.registry.dispatch(
          "list_vaults",
          {},
          {
            caller: "test",
            authenticated: true,
            grantedScopes: new Set(["read:vault"]),
            vaultId: "main",
            db: probeDb,
          },
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          const vaults = (result.data as { vaults: Array<{ embeddings_provider: string }> }).vaults;
          expect(vaults[0]?.embeddings_provider).toBe("ollama");
        }

        // 3) the SEEDED vector survived boot untouched — ensureVecChunks' first-ever call on a
        //    fresh cache.db only CREATEs vec_chunks (never drops/rebuilds an existing one), so the
        //    seeded chunk_embeddings row is still the sole source of truth; assert it was never
        //    mutated or removed by boot (the exact regression: booting at the WRONG dimensions
        //    would have rejected/dropped this row rather than left it alone).
        const stillActive = probeDb
          .prepare(
            "SELECT model, dimensions, is_active FROM chunk_embeddings WHERE chunk_id = 'c1'",
          )
          .get() as { model: string; dimensions: number; is_active: number } | undefined;
        expect(stillActive).toEqual({
          model: "ollama:mxbai-embed-large",
          dimensions: SEEDED_DIMENSIONS,
          is_active: 1,
        });
      } finally {
        probeDb.close?.();
      }
    } finally {
      await runtime.close("test cleanup");
    }
  });
});
