// THE-1122 review round 2 (High 1) — GH #995's ACTUAL regression, reopened: `obsidian-tc index`
// loaded a schema-defaulted config via `resolveOrUsageExit` (no provenance, no db) and passed it
// straight to `wireIndexResources`, never going through the sticky resolution `serve`'s boot
// (server-runtime.ts) and `doctor` (doctor.ts) both apply. An unconfigured pre-1.31.4 install that
// ran `obsidian-tc index <vault>` before ever starting `serve` — the documented use case index.ts's
// own header describes ("the derived-state job that had no CLI") — got a fresh "local" provider
// wired up instead of its existing "ollama" one, silently re-embedding on first contact.
//
// RED on main (pre-fix): `run_index` never calls `applyStickyEmbeddings`, so `wireIndexResources`
// constructs the schema-defaulted "local" provider and the fingerprint this test reads back says
// "local", not "ollama" — contradicting `buildServerRuntime`'s resolution over the SAME cache db
// (see embeddings-sticky-provider-wiring.test.ts).
//
// `vec_index_fingerprint` is only created inside `ensureVecChunks` when the sqlite-vec extension
// actually loads (search/vec.ts's `loadVec`) — CI's Node 24 `build-test` legs delete
// better-sqlite3 after install, so `openDatabase` falls back to the
// `node:sqlite` adapter, which exposes no `loadExtension` (db/node-node-sqlite.ts's own header),
// and the table never gets created. This test's PRIMARY evidence is therefore the sticky notice
// `run_index` prints to stdout before any vec DDL runs (index.ts) — proven in every environment —
// with the fingerprint/chunk_embeddings checks below as an ADDITIONAL, guarded assertion for the
// ones that can see vec DDL, matching the pattern embeddings-sticky-every-caller.test.ts uses.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run_index } from "../src/cli/commands/index";
import { tableExists } from "../src/db/introspect";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { makeTempDir, rmTemp } from "./tmp";

describe("run_index — GH #995 sticky embeddings provider (CLI one-shot path)", () => {
  const tmpDirs: string[] = [];
  const tmpDir = (prefix: string): string => {
    const d = makeTempDir(prefix);
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmTemp(d);
      } catch {
        // best-effort, matching every other buildServerRuntime/CLI temp-dir test in this suite.
      }
    }
  });

  it("keeps an existing ollama index's provider instead of wiring the schema-defaulted local one", async () => {
    const vaultDir = tmpDir("otc-cli-index-sticky-vault-");
    const cacheDir = tmpDir("otc-cli-index-sticky-cache-");
    const confDir = tmpDir("otc-cli-index-sticky-conf-");
    // No `embeddings` block at all — the real "unconfigured install" shape, same as
    // configFromVaultPath's own synthetic object and resolveServeConfigWithProvenance's
    // zero-config branch.
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ cacheDir, vaults: [{ id: "main", path: vaultDir }] }),
    );

    // Seed cache.db exactly as a pre-1.31.4 install would have left it (same fixture shape as the
    // wiring test): an active ollama-model embedding, no config file supplying `embeddings` either.
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
         VALUES ('c1', 'ollama:nomic-embed-text', 768, ?, 1, ?)`,
      )
      .run(Buffer.alloc(768 * 4), now);
    seedDb.close?.();

    // The vault dir itself has no notes — indexVaultRecorded finds nothing to embed, so this
    // exercises the resolution wiring without needing a real ollama server reachable.
    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    try {
      await run_index({ kind: "index", input: configPath });
    } finally {
      stdoutSpy.mockRestore();
    }
    // The sticky notice names the kept provider — primary evidence, present regardless of whether
    // this environment can load the sqlite-vec extension (see this file's header).
    expect(chunks.join(""), "no sticky notice printed").toMatch(/ollama/);

    const probeDb = await openDatabase(join(cacheDir, "cache.db"), undefined, { readonly: true });
    try {
      // The seeded row itself must survive untouched — the regression drops/rebuilds vec_chunks
      // and marks every stored chunk a model mismatch, but chunk_embeddings itself is the ground
      // truth this assertion protects. Always present (provisionCacheDb), unlike vec_chunks.
      const stillActive = probeDb
        .prepare("SELECT model, is_active FROM chunk_embeddings WHERE chunk_id = 'c1'")
        .get() as { model: string; is_active: number } | undefined;
      expect(stillActive).toEqual({ model: "ollama:nomic-embed-text", is_active: 1 });

      // vec_index_fingerprint's fingerprint string is "<provider>|..." (representationFingerprint) —
      // wireIndexResources writes it from whatever provider it was ACTUALLY constructed with, so
      // this reads the real wired provider, not just a resolver's return value. Only created when
      // the sqlite-vec extension loaded (see this file's header) — additional, guarded assertion.
      if (tableExists(probeDb, "vec_index_fingerprint")) {
        const row = probeDb
          .prepare("SELECT fingerprint FROM vec_index_fingerprint WHERE id = 1")
          .get() as { fingerprint?: string } | undefined;
        expect(row?.fingerprint?.split("|")[0]).toBe("ollama");
      }
    } finally {
      probeDb.close?.();
    }
  });
});
