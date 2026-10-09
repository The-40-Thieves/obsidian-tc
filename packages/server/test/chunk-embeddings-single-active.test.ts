// GH #1160: nothing enforced "one active embedding per chunk". Two writers kept it by convention;
// any third writer that inserted `is_active = 1` without deactivating siblings left the store in a
// state note-plan's `LEFT JOIN ... is_active = 1` misread (non-deterministic active_model), which
// emptied the dense index and produced phantom "concurrent write" skips. These tests pin the
// enforcement (unique partial index), the repair of existing violations, and that both production
// writers still work under the constraint (deactivate BEFORE insert).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATIONS, provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexNote, indexVault } from "../src/search/indexer";
import { copyDedupVectors } from "../src/search/indexing/dedup";
import { preloadChunkState, readExistingChunkRows } from "../src/search/indexing/note-plan";
import { createStaleSkipLog } from "../src/search/indexing/stale-skip";
import { buildRepresentationManifest } from "../src/search/representation";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

// The repair migration is picked by version, not by position: later migrations land after it.
const REPAIR_VERSION = "20261008_001";
const beforeRepair = () =>
  CACHE_MIGRATIONS.slice(
    0,
    CACHE_MIGRATIONS.findIndex((m) => m.version === REPAIR_VERSION),
  );

const blob = (n: number): Buffer => Buffer.alloc(n * 4);

function seedChunk(db: any, id: string, path = `${id}.md`): void {
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash,
                         token_count, created_at, updated_at)
     VALUES (?, 'v1', ?, '0', '[]', 'c', ?, 1, 0, 0)`,
  ).run(id, path, `h-${id}`);
}

function seedEmb(
  db: any,
  chunkId: string,
  model: string,
  dims: number,
  active: 0 | 1,
  generatedAt: number,
): void {
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(chunkId, model, dims, blob(dims), active, generatedAt);
}

const activeModels = (db: any, chunkId: string): string[] =>
  (
    db
      .prepare("SELECT model FROM chunk_embeddings WHERE chunk_id = ? AND is_active = 1")
      .all(chunkId) as Array<{ model: string }>
  ).map((r) => r.model);

describe("chunk_embeddings allows at most one active row per chunk (GH #1160)", () => {
  it("refuses a second active embedding for a chunk (the issue's reproduction INSERT)", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedChunk(db, "c1");
    seedEmb(db, "c1", "fake:good", 16, 1, 5);
    // The reproduction from the issue: a second ACTIVE row at a different width.
    expect(() => seedEmb(db, "c1", "other:model", 384, 1, 0)).toThrow(/UNIQUE|constraint/i);
    expect(activeModels(db, "c1")).toEqual(["fake:good"]);
  });

  it("still allows any number of INACTIVE generations beside the active one", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedChunk(db, "c1");
    seedEmb(db, "c1", "fake:good", 16, 1, 5);
    seedEmb(db, "c1", "old:a", 8, 0, 1);
    seedEmb(db, "c1", "old:b", 8, 0, 2);
    expect(activeModels(db, "c1")).toEqual(["fake:good"]);
  });

  it("repairs pre-existing violations deterministically: newest generated_at wins, model breaks ties", () => {
    const db = openMemoryDb();
    // Everything BEFORE the repair migration: the old non-unique index permits the violation.
    runMigrations(db, beforeRepair());
    for (const id of ["newest", "tie", "single", "stale-inactive", "triple"]) seedChunk(db, id);
    seedEmb(db, "newest", "m:old", 384, 1, 10);
    seedEmb(db, "newest", "m:new", 768, 1, 20);
    seedEmb(db, "tie", "z:model", 8, 1, 7);
    seedEmb(db, "tie", "a:model", 16, 1, 7);
    seedEmb(db, "single", "m:only", 16, 1, 1);
    seedEmb(db, "stale-inactive", "m:cur", 16, 1, 3);
    seedEmb(db, "stale-inactive", "m:prev", 16, 0, 99);
    seedEmb(db, "triple", "m:a", 8, 1, 1);
    seedEmb(db, "triple", "m:b", 8, 1, 3);
    seedEmb(db, "triple", "m:c", 8, 1, 2);
    const rowsBefore = (db.prepare("SELECT COUNT(*) AS n FROM chunk_embeddings").get() as any).n;

    provisionCacheDb(db); // applies only the repair + unique-index migration

    expect(activeModels(db, "newest")).toEqual(["m:new"]);
    expect(activeModels(db, "tie")).toEqual(["a:model"]);
    expect(activeModels(db, "single")).toEqual(["m:only"]);
    // An already-inactive row is never promoted, however new it is.
    expect(activeModels(db, "stale-inactive")).toEqual(["m:cur"]);
    expect(activeModels(db, "triple")).toEqual(["m:b"]);
    // Deactivated, never deleted: audit/rollback rows survive.
    expect((db.prepare("SELECT COUNT(*) AS n FROM chunk_embeddings").get() as any).n).toBe(
      rowsBefore,
    );
    // And the constraint is live afterwards.
    expect(() => seedEmb(db, "single", "m:other", 16, 1, 9)).toThrow(/UNIQUE|constraint/i);
  });
});

describe("both production writers deactivate siblings BEFORE activating the new row", () => {
  const VAULT = "v1";
  const NOW = 1_700_000_000_000;

  const vaultRunner = (db: any, root: string) => (model: string) => {
    const provider = fakeEmbeddingProvider({ dimensions: 8, model });
    return indexVault({
      db,
      provider,
      vaultId: VAULT,
      root,
      isReadable: () => true,
      now: () => NOW,
      representation: buildRepresentationManifest(provider, {}),
      chunkContext: false,
    });
  };

  it("indexVault re-embeds an unchanged note under a new model without tripping the index", async () => {
    const root = makeTempDir("obtc-1160-");
    try {
      writeFileSync(join(root, "a.md"), "## S\nalpha body one\n");
      const db = openMemoryDb();
      provisionCacheDb(db);
      const run = vaultRunner(db, root);
      await run("m1");
      const s = await run("m2");
      expect(s.chunks_upserted).toBeGreaterThan(0);
      const rows = db
        .prepare("SELECT model, is_active FROM chunk_embeddings ORDER BY model")
        .all() as Array<{ model: string; is_active: number }>;
      expect(rows).toEqual([
        { model: "fake:m1", is_active: 0 },
        { model: "fake:m2", is_active: 1 },
      ]);
    } finally {
      rmTemp(root);
    }
  });

  it("indexNote re-embedding under a new model leaves exactly one active row", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const note = (model: string) =>
      indexNote(
        db,
        fakeEmbeddingProvider({ dimensions: 8, model }),
        VAULT,
        "n.md",
        "## S\nbody\n",
        false,
        () => NOW,
        undefined,
        false,
      );
    await note("m1");
    await note("m2");
    const active = db
      .prepare("SELECT model FROM chunk_embeddings WHERE is_active = 1")
      .all() as Array<{ model: string }>;
    expect(active).toEqual([{ model: "fake:m2" }]);
  });

  it("copyDedupVectors (the cross-path dedup copy) retires the superseded model BEFORE activating the copy", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    // owner: already re-embedded under the new model this run; target: still active under the old.
    for (const [id, path] of [
      ["owner", "one.md"],
      ["target", "two.md"],
    ] as const) {
      db.prepare(
        `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash,
                             body_sha, token_count, created_at, updated_at)
         VALUES (?, 'v1', ?, '0', '[]', 'c', 'ch', 'bs', 1, 0, 0)`,
      ).run(id, path);
    }
    seedEmb(db, "owner", "fake:m2", 8, 1, 5);
    seedEmb(db, "target", "fake:m1", 8, 1, 1);
    const r = copyDedupVectors(
      db,
      {
        targetId: "target",
        bodySha: "bs",
        contentHash: "ch",
        vaultId: "v1",
        path: "two.md",
        model: "fake:m2",
        ts: 9,
        hasVec: false,
        hasChunkSparse: false,
        hasChunkColbert: false,
      },
      new Map(),
    );
    expect(r.resolved).toBe(true);
    expect(activeModels(db, "target")).toEqual(["fake:m2"]);
    const old = db
      .prepare(
        "SELECT is_active FROM chunk_embeddings WHERE chunk_id = 'target' AND model = 'fake:m1'",
      )
      .get() as { is_active: number };
    expect(old.is_active).toBe(0);
  });
});

describe("the stale-plan skip reports what it observed (GH #1160)", () => {
  const row = (id: string, active_model: string | null, content_hash = "h") => ({
    rowid: 1,
    id,
    content_hash,
    active_model,
  });

  it("names the expected and found active_model instead of asserting a concurrent write", () => {
    const db = openMemoryDb();
    const log = createStaleSkipLog(db, "v1");
    log.rowMismatch(
      "a.md",
      [row("chunkaaaaaaaaaaaa", "m:old")],
      [row("chunkaaaaaaaaaaaa", "m:new")],
    );
    const text = log.report() ?? "";
    expect(text).toContain('active_model was "m:old" when planned, now "m:new"');
    expect(text).toContain("a.md");
  });

  it("detects and names a chunk carrying more than one active embedding", () => {
    const db = openMemoryDb();
    runMigrations(db, beforeRepair()); // a pre-migration store can hold the violation
    seedChunk(db, "dup", "dup.md");
    seedEmb(db, "dup", "m:one", 16, 1, 1);
    seedEmb(db, "dup", "m:two", 8, 1, 2);
    const planned = preloadChunkState(db, "v1").get("dup.md") ?? [];
    const current = readExistingChunkRows(db, "v1", "dup.md");
    // The join fans out: two rows for ONE chunk, which is exactly what made active_model arbitrary.
    expect(current).toHaveLength(2);
    const log = createStaleSkipLog(db, "v1");
    log.rowMismatch("dup.md", planned, current);
    const text = log.report() ?? "";
    expect(text).toContain("MORE THAN ONE ACTIVE embedding");
    expect(text).toContain("m:one");
    expect(text).toContain("m:two");
    expect(text).toContain("not a concurrent write");
  });

  it("says so when the same skip repeats identically across passes", () => {
    const db = openMemoryDb();
    const planned = [row("chunkbbbbbbbbbbbb", "m:old")];
    const current = [row("chunkbbbbbbbbbbbb", "m:new")];
    const first = createStaleSkipLog(db, "v1");
    first.rowMismatch("b.md", planned, current);
    expect(first.report()).toContain("concurrent write_note/watcher commit is the usual cause");
    const second = createStaleSkipLog(db, "v1");
    second.rowMismatch("b.md", planned, current);
    const text = second.report() ?? "";
    expect(text).toContain("skipped before with this identical difference");
    expect(text).toContain("a concurrent write would not repeat identically");
  });
});
