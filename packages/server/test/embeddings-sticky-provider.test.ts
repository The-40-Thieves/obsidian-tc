// GH #995: PR #980 (1.31.4) changed embeddings.provider's default from "ollama" to "local" when
// the `embeddings` block is absent — chunk_embeddings is keyed PRIMARY KEY (chunk_id, model), so an
// existing install that never configured embeddings was silently switched to a different provider
// on upgrade, forcing a full in-process re-embed. RED on main (pre-fix): case (i) below resolves to
// "local" instead of keeping "ollama".
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import {
  applyStickyEmbeddings,
  formatStickyEmbeddingsNotice,
  hasOrphanedActiveEmbeddings,
  mapStoredModelToProviderConfig,
  PRE_1_31_4_DEFAULT_DIMENSIONS,
  PRE_1_31_4_DEFAULT_MODEL,
  PRE_1_31_4_DEFAULT_PROVIDER,
  queryActiveEmbeddingModels,
  resolveStickyEmbeddings,
} from "../src/embeddings/sticky-provider";
import { openMemoryDb } from "./helpers";

const CONFIGURED_LOCAL = { provider: "local", model: "nomic-embed-text-v1.5", dimensions: 768 };

/** Seed a chunk + chunk_embeddings row with a given model id and is_active flag, for a given
 *  vault. Bypasses real indexing entirely — this module's functions only ever read these two
 *  columns, so a hand-built row is a faithful, much cheaper fixture. `dimensions` defaults to 4
 *  (the pre-existing fixture width, unrelated to any real model) but is overridable — the review
 *  round 2 dimensions tests need a REALISTIC width (1024) to prove it survives, not just this
 *  fixture's placeholder. */
function seedChunkEmbedding(
  db: import("../src/db/types").Database,
  opts: { vaultId: string; chunkId: string; model: string; isActive: 0 | 1; dimensions?: number },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
     VALUES (?, ?, 'a.md', '0', '[]', 'x', 'hash', 1, ?, ?)`,
  ).run(opts.chunkId, opts.vaultId, now, now);
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opts.chunkId, opts.model, opts.dimensions ?? 4, Buffer.alloc(16), opts.isActive, now);
}

/** Object-form activeModels entries — resolveStickyEmbeddings takes ActiveEmbeddingModel[], not
 *  bare model-id strings, since round 2 threads each row's stored dimensions through. `dim`
 *  defaults to PRE_1_31_4_DEFAULT_DIMENSIONS (768) for tests that don't care about width. */
function am(
  model: string,
  dim = PRE_1_31_4_DEFAULT_DIMENSIONS,
): { model: string; dimensions: number } {
  return { model, dimensions: dim };
}

describe("mapStoredModelToProviderConfig", () => {
  it("maps a plain provider:model id for a reconstructable provider", () => {
    expect(mapStoredModelToProviderConfig("ollama:nomic-embed-text")).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
    });
    expect(mapStoredModelToProviderConfig("openai:text-embedding-3-small")).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
    });
  });

  it("returns undefined for an unreconstructable provider (local, module, a fake test provider)", () => {
    expect(mapStoredModelToProviderConfig("local:nomic-embed-text-v1.5:q8")).toBeUndefined();
    expect(mapStoredModelToProviderConfig("fake:A")).toBeUndefined();
    expect(mapStoredModelToProviderConfig("module:whatever")).toBeUndefined();
  });

  it("returns undefined for a malformed id (no colon, or an empty model half)", () => {
    expect(mapStoredModelToProviderConfig("nomodel")).toBeUndefined();
    expect(mapStoredModelToProviderConfig("ollama:")).toBeUndefined();
  });
});

describe("queryActiveEmbeddingModels", () => {
  it("returns only active rows for the requested vault(s), most-frequent first", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedChunkEmbedding(db, {
      vaultId: "v1",
      chunkId: "c1",
      model: "ollama:nomic-embed-text",
      isActive: 1,
    });
    seedChunkEmbedding(db, {
      vaultId: "v1",
      chunkId: "c2",
      model: "ollama:nomic-embed-text",
      isActive: 1,
    });
    seedChunkEmbedding(db, {
      vaultId: "v1",
      chunkId: "c3",
      model: "openai:text-embedding-3-small",
      isActive: 0,
    });
    seedChunkEmbedding(db, { vaultId: "v2", chunkId: "c4", model: "cohere:embed-v4", isActive: 1 });

    expect(queryActiveEmbeddingModels(db, ["v1"])).toEqual([
      { model: "ollama:nomic-embed-text", dimensions: 4 },
    ]);
    expect(queryActiveEmbeddingModels(db, ["v2"])).toEqual([
      { model: "cohere:embed-v4", dimensions: 4 },
    ]);
    expect(
      queryActiveEmbeddingModels(db, ["v1", "v2"])
        .map((r) => r.model)
        .sort(),
    ).toEqual(["cohere:embed-v4", "ollama:nomic-embed-text"].sort());
  });

  it("is empty for a fresh cache db (no chunk_embeddings rows) or no vault ids", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    expect(queryActiveEmbeddingModels(db, ["v1"])).toEqual([]);
    expect(queryActiveEmbeddingModels(db, [])).toEqual([]);
  });

  // THE-1122 review round 2 (High 2): dimensions is a per-row STORED value, not implied by the
  // model name — a mixed-width history for the SAME model id would be a data bug elsewhere, but
  // the query must still report whatever width is actually stored.
  it("reports the STORED dimensions for each active model, not a hardcoded width", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedChunkEmbedding(db, {
      vaultId: "v1",
      chunkId: "c1",
      model: "ollama:mxbai-embed-large",
      isActive: 1,
      dimensions: 1024,
    });
    expect(queryActiveEmbeddingModels(db, ["v1"])).toEqual([
      { model: "ollama:mxbai-embed-large", dimensions: 1024 },
    ]);
  });
});

describe("hasOrphanedActiveEmbeddings", () => {
  it("is true when active vectors exist under a vault id NOT in the configured set", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedChunkEmbedding(db, {
      vaultId: "old-main",
      chunkId: "c1",
      model: "ollama:nomic-embed-text",
      isActive: 1,
    });
    expect(hasOrphanedActiveEmbeddings(db, ["main"])).toBe(true);
  });

  it("is false when every active row belongs to a configured vault id, or the db is empty", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedChunkEmbedding(db, {
      vaultId: "main",
      chunkId: "c1",
      model: "ollama:nomic-embed-text",
      isActive: 1,
    });
    expect(hasOrphanedActiveEmbeddings(db, ["main"])).toBe(false);
    expect(hasOrphanedActiveEmbeddings(db, [])).toBe(false);

    const empty = openMemoryDb();
    provisionCacheDb(empty);
    expect(hasOrphanedActiveEmbeddings(empty, ["main"])).toBe(false);
  });

  it("ignores an inactive (superseded) row under an unconfigured vault id", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedChunkEmbedding(db, {
      vaultId: "old-main",
      chunkId: "c1",
      model: "ollama:nomic-embed-text",
      isActive: 0,
    });
    expect(hasOrphanedActiveEmbeddings(db, ["main"])).toBe(false);
  });
});

describe("resolveStickyEmbeddings", () => {
  // (i) no config + cache with active ollama-model vectors -> ollama kept, source kept-from-index
  it("(i) keeps an existing ollama index's provider when embeddings.provider is unset", () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "keep",
      configured: CONFIGURED_LOCAL,
      activeModels: [am("ollama:nomic-embed-text")],
    });
    expect(res).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: PRE_1_31_4_DEFAULT_DIMENSIONS,
      source: "kept-from-index",
      keptFromStoredModel: "ollama:nomic-embed-text",
    });
    expect(formatStickyEmbeddingsNotice(res)).toMatch(
      /kept provider "ollama", model "nomic-embed-text"/,
    );
  });

  // (ii) no config + empty cache -> local, source default, no notice
  it("(ii) takes the current default on a fresh install (no active vectors)", () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "keep",
      configured: CONFIGURED_LOCAL,
      activeModels: [],
    });
    expect(res).toEqual({ ...CONFIGURED_LOCAL, source: "default" });
    expect(formatStickyEmbeddingsNotice(res)).toBeUndefined();
  });

  // (iii) explicit provider: "local" with ollama vectors present -> local, configured
  it("(iii) an explicit provider always wins, even over existing ollama vectors", () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: true,
      onProviderChange: "keep",
      configured: CONFIGURED_LOCAL,
      activeModels: [am("ollama:nomic-embed-text")],
    });
    expect(res).toEqual({ ...CONFIGURED_LOCAL, source: "configured" });
    expect(formatStickyEmbeddingsNotice(res)).toBeUndefined();
  });

  // (iv) onProviderChange: "switch" -> local (the current default), even with ollama vectors present
  it('(iv) onProviderChange: "switch" adopts the current default outright', () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "switch",
      configured: CONFIGURED_LOCAL,
      activeModels: [am("ollama:nomic-embed-text")],
    });
    expect(res).toEqual({ ...CONFIGURED_LOCAL, source: "default" });
  });

  // (v) unmappable stored model -> documented pre-1.31.4 fallback + notice, never a guess
  it("(v) falls back to the pre-1.31.4 default identity for an unmappable stored model", () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "keep",
      configured: CONFIGURED_LOCAL,
      activeModels: [am("fake:A")],
    });
    expect(res).toEqual({
      provider: PRE_1_31_4_DEFAULT_PROVIDER,
      model: PRE_1_31_4_DEFAULT_MODEL,
      dimensions: PRE_1_31_4_DEFAULT_DIMENSIONS,
      source: "kept-from-index",
      keptFromStoredModel: "fake:A",
      unmappableFallback: true,
    });
    const notice = formatStickyEmbeddingsNotice(res);
    expect(notice).toMatch(/could not be mapped to a known provider/);
    expect(notice).toMatch(/"fake:A"/);
  });

  // (vi) explicit ollama -> ollama, configured
  it("(vi) an explicit ollama provider resolves as configured, regardless of the cache", () => {
    const configuredOllama = { provider: "ollama", model: "nomic-embed-text", dimensions: 768 };
    const res = resolveStickyEmbeddings({
      providerExplicit: true,
      onProviderChange: "keep",
      configured: configuredOllama,
      activeModels: [],
    });
    expect(res).toEqual({ ...configuredOllama, source: "configured" });
  });

  it("does not treat an index already on the current default's provider family as sticky", () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "keep",
      configured: CONFIGURED_LOCAL,
      activeModels: [am("local:nomic-embed-text-v1.5:q8")],
    });
    expect(res).toEqual({ ...CONFIGURED_LOCAL, source: "default" });
  });

  // (vii) A GH #995 victim who ran 1.31.4 long enough to re-embed most chunks under "local" before
  // rolling back has a MIXED index with local in the MAJORITY (activeModels[0]). Picking
  // activeModels[0] blindly would resolve to "default" (local) and silently continue the switch
  // they never chose — the correct read is "this index still has non-default vectors in it", so the
  // most frequent NON-default-family active model must be kept, not the overall-most-frequent one.
  it("(vii) keeps a minority ollama provider when the majority of active vectors are already local", () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "keep",
      configured: CONFIGURED_LOCAL,
      activeModels: [am("local:nomic-embed-text-v1.5:q8"), am("ollama:nomic-embed-text")],
    });
    expect(res).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: PRE_1_31_4_DEFAULT_DIMENSIONS,
      source: "kept-from-index",
      keptFromStoredModel: "ollama:nomic-embed-text",
    });
    expect(formatStickyEmbeddingsNotice(res)).toMatch(
      /kept provider "ollama", model "nomic-embed-text"/,
    );
  });

  // (viii) Only when EVERY active model already belongs to the current default's provider family is
  // there nothing left to keep sticky about.
  it("(viii) resolves to default when every active model is already the current default's provider family", () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "keep",
      configured: CONFIGURED_LOCAL,
      activeModels: [am("local:nomic-embed-text-v1.5:q8"), am("local:other-rev:fp32")],
    });
    expect(res).toEqual({ ...CONFIGURED_LOCAL, source: "default" });
  });

  // THE-1122 review round 2 (High 2): a pre-1.31.4 config could set model/dimensions explicitly
  // (e.g. mxbai-embed-large at 1024) without ever setting provider — ollama was still the only
  // provider that shape could mean. The KEPT resolution must honor the row's real stored width,
  // not the pre-1.31.4 default's own historical width (768).
  it("(ix) keeps the STORED dimensions for a mapped provider, not the pre-1.31.4 default width", () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "keep",
      configured: CONFIGURED_LOCAL,
      activeModels: [am("ollama:mxbai-embed-large", 1024)],
    });
    expect(res).toEqual({
      provider: "ollama",
      model: "mxbai-embed-large",
      dimensions: 1024,
      source: "kept-from-index",
      keptFromStoredModel: "ollama:mxbai-embed-large",
    });
  });

  // THE-1122 review round 2 (Medium 4): withRevision (embeddings/index.ts) appends `@revision` to
  // the OUTERMOST provider id. Reconstructing "nomic-embed-text@v2" as a bare model name and then
  // re-declaring the SAME revision at construction would double-suffix it
  // (`nomic-embed-text@v2@v2`), which resolves to no real model.
  it("(x) splits a stored revision id into model + revision, never double-suffixing it", () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "keep",
      configured: CONFIGURED_LOCAL,
      activeModels: [am("ollama:nomic-embed-text@v2", 768)],
    });
    expect(res).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
      revision: "v2",
      source: "kept-from-index",
      keptFromStoredModel: "ollama:nomic-embed-text@v2",
    });
    expect(res.model.includes("@")).toBe(false);
  });

  // THE-1122 review round 2 (High 3): empty activeModels is ambiguous between "genuinely fresh
  // install" and "this vault's own rows are orphaned under a different vault id" — the caller
  // (applyStickyEmbeddings) computes orphanedActiveModels only in that case and this must resolve
  // to a DISTINCT, non-silent source rather than reusing "default".
  //
  // THE-1122 review round 2 (finding 3, fix round 2): a renamed vault id's orphaned rows are now
  // KEPT (same most-frequent-non-default-family rule as this vault's own rows), not silently
  // discarded — see resolveKeptIdentity.
  it("(xi) keeps the most-frequent orphaned model's identity when the scoped match is empty but the cache holds orphaned active vectors under a DIFFERENT vault id", () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "keep",
      configured: CONFIGURED_LOCAL,
      activeModels: [],
      orphanedActiveModels: [am("ollama:nomic-embed-text")],
    });
    expect(res).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: PRE_1_31_4_DEFAULT_DIMENSIONS,
      source: "ambiguous-orphaned-index",
      keptFromStoredModel: "ollama:nomic-embed-text",
    });
    const notice = formatStickyEmbeddingsNotice(res);
    expect(notice).toMatch(/could not confirm this vault's existing provider/);
    expect(notice).toMatch(/renamed/);
    expect(notice).toMatch(/kept provider "ollama", model "nomic-embed-text"/);
  });

  it("(xi-b) resolves to ambiguous-orphaned-index with NO identity change when every orphaned row already belongs to the default's own family", () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "keep",
      configured: CONFIGURED_LOCAL,
      activeModels: [],
      orphanedActiveModels: [am("local:nomic-embed-text-v1.5:q8")],
    });
    expect(res).toEqual({ ...CONFIGURED_LOCAL, source: "ambiguous-orphaned-index" });
    expect(formatStickyEmbeddingsNotice(res)).toMatch(/found nothing to keep/);
  });

  it("(xii) a genuinely fresh install (no orphaned vectors either) still resolves to default, silently", () => {
    const res = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "keep",
      configured: CONFIGURED_LOCAL,
      activeModels: [],
      orphanedActiveModels: [],
    });
    expect(res).toEqual({ ...CONFIGURED_LOCAL, source: "default" });
    expect(formatStickyEmbeddingsNotice(res)).toBeUndefined();
  });
});

describe("applyStickyEmbeddings — orphan detection wiring", () => {
  it("only queries hasOrphanedActiveEmbeddings when the scoped match is empty, and mutates config.embeddings.revision when the kept identity carries one", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedChunkEmbedding(db, {
      vaultId: "main",
      chunkId: "c1",
      model: "ollama:nomic-embed-text@v3",
      isActive: 1,
      dimensions: 900,
    });
    const config = {
      embeddings: {
        provider: "local",
        model: "nomic-embed-text-v1.5",
        dimensions: 768,
        onProviderChange: "keep" as const,
      },
      vaults: [{ id: "main" }],
    };
    const resolution = applyStickyEmbeddings(config, db);
    expect(resolution.source).toBe("kept-from-index");
    expect(config.embeddings.provider).toBe("ollama");
    expect(config.embeddings.model).toBe("nomic-embed-text");
    expect(config.embeddings.dimensions).toBe(900);
    expect((config.embeddings as { revision?: string }).revision).toBe("v3");
  });

  // THE-1122 review round 2 (finding 3, fix round 2): a DIFFERENT vault id's orphaned rows are now
  // KEPT (not discarded) — see resolveStickyEmbeddings' own (xi) test for the pure-function case;
  // this proves applyStickyEmbeddings wires the query and the mutation through correctly.
  it("keeps the orphaned rows' provider when a DIFFERENT vault id owns the only active rows in this cache db", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedChunkEmbedding(db, {
      vaultId: "renamed-away",
      chunkId: "c1",
      model: "ollama:nomic-embed-text",
      isActive: 1,
    });
    const config = {
      embeddings: {
        provider: "local",
        model: "nomic-embed-text-v1.5",
        dimensions: 768,
        onProviderChange: "keep" as const,
      },
      vaults: [{ id: "main" }],
    };
    const resolution = applyStickyEmbeddings(config, db);
    expect(resolution.source).toBe("ambiguous-orphaned-index");
    expect(resolution.keptFromStoredModel).toBe("ollama:nomic-embed-text");
    expect(config.embeddings.provider).toBe("ollama");
    expect(config.embeddings.model).toBe("nomic-embed-text");
  });

  // Item 4 (fix round 2): an UNMAPPABLE stored id must never silently construct a guessed
  // provider — applyStickyEmbeddings fails construction closed instead, before any vec DDL.
  it("throws (never mutates, never guesses) when the kept identity is unmappable", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedChunkEmbedding(db, {
      vaultId: "main",
      chunkId: "c1",
      model: "openai-compatible:custom-embedder",
      isActive: 1,
    });
    const config = {
      embeddings: {
        provider: "local",
        model: "nomic-embed-text-v1.5",
        dimensions: 768,
        onProviderChange: "keep" as const,
      },
      vaults: [{ id: "main" }],
    };
    expect(() => applyStickyEmbeddings(config, db)).toThrow(/could not be mapped back to a real/);
    expect(config.embeddings.provider).toBe("local");
  });
});
