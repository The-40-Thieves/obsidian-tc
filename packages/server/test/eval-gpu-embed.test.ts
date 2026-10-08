// GH #1161: the off-box (GPU) embedding workflow — export-chunk-texts.ts / load-gpu-vecs.ts over
// eval/gpu-embed-lib.ts. Each case pins one silent-wrong-result the workflow used to have: the
// provider id was string-concatenated (zero rows updated, reported as success), `--insert` could
// leave two active rows, and the exporter has to emit the SHIPPED text and withhold excluded paths.
// The loader runs against a db built by provisionCacheDb, i.e. WITH the unique partial index from
// migration 20261008_001.
import { describe, expect, it } from "vitest";
import { exportChunkTexts, gpuVecsModelId, loadGpuVecs } from "../eval/gpu-embed-lib";
import { provisionCacheDb } from "../src/db/provision";
import { compileEgressFilter } from "../src/plane/egress-filter";
import { enrichChunkText } from "../src/search/chunk";
import { invalidateVecIndex } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const DIM = 4;
const OLD = "ollama:old-model";
const NEW = "local:nomic-embed-text-v1.5:fp32";
const CACHE_DIR = "/nonexistent/otc-cache"; // never read: the local provider loads its model lazily

const vecBytes = (n: number): Buffer => {
  const out = new Float32Array(n * DIM);
  for (let i = 0; i < out.length; i++) out[i] = i + 1;
  return Buffer.from(out.buffer);
};

function seedChunk(
  db: any,
  id: string,
  path = `${id}.md`,
  headings = "[]",
  content = "body",
): void {
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash,
                         token_count, created_at, updated_at)
     VALUES (?, 'v1', ?, '0', ?, ?, ?, 1, 0, 0)`,
  ).run(id, path, headings, content, `h-${id}`);
}

function seedEmb(db: any, id: string, model: string, active: 0 | 1): void {
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(id, model, DIM, Buffer.alloc(DIM * 4), active);
}

const rows = (db: any, id: string): Array<{ model: string; is_active: number }> =>
  db
    .prepare("SELECT model, is_active FROM chunk_embeddings WHERE chunk_id = ? ORDER BY model")
    .all(id) as Array<{ model: string; is_active: number }>;

function freshDb(chunks: string[]): any {
  const db = openMemoryDb();
  provisionCacheDb(db);
  for (const c of chunks) seedChunk(db, c);
  return db;
}

describe("provider id derivation", () => {
  const local = { provider: "local", model: "nomic-embed-text-v1.5", dimensions: 768 };

  it("is the provider's id, which for the local embedder is NOT provider:model", () => {
    const id = gpuVecsModelId({ ...local, quantized: false }, CACHE_DIR);
    expect(id).toBe("local:nomic-embed-text-v1.5:fp32");
    expect(id).not.toBe(`${local.provider}:${local.model}`);
  });

  it("folds quantization and revision in, so q8, fp32 and a pinned revision each address their own rows", () => {
    expect(gpuVecsModelId({ ...local, quantized: true }, CACHE_DIR)).toBe(
      "local:nomic-embed-text-v1.5:q8",
    );
    expect(gpuVecsModelId({ ...local, quantized: false, revision: "r1" }, CACHE_DIR)).toBe(
      "local:nomic-embed-text-v1.5:fp32:r1",
    );
  });
});

describe("loadGpuVecs", () => {
  it("writes zero rows -> throws, and changes nothing (the old string-concat id updated nothing and reported success)", () => {
    const db = freshDb(["a", "b"]);
    seedEmb(db, "a", OLD, 1);
    seedEmb(db, "b", OLD, 1);
    expect(() =>
      loadGpuVecs(db, {
        model: "ollama:nomic",
        dim: DIM,
        ids: ["a", "b"],
        vecs: vecBytes(2),
        insert: false,
      }),
    ).toThrow(/wrote 0 rows for model "ollama:nomic".*--insert/);
    expect(rows(db, "a")).toEqual([{ model: OLD, is_active: 1 }]);
  });

  it("UPDATE-only mode overwrites the vector of an existing row and never inserts or re-activates", () => {
    const db = freshDb(["a"]);
    seedEmb(db, "a", NEW, 0);
    seedEmb(db, "a", OLD, 1);
    const n = loadGpuVecs(db, {
      model: NEW,
      dim: DIM,
      ids: ["a"],
      vecs: vecBytes(1),
      insert: false,
    });
    expect(n).toBe(1);
    expect(rows(db, "a")).toEqual([
      { model: NEW, is_active: 0 },
      { model: OLD, is_active: 1 },
    ]);
    const blob = db.prepare("SELECT embedding FROM chunk_embeddings WHERE model = ?").get(NEW) as {
      embedding: Uint8Array;
    };
    expect(
      Array.from(new Float32Array(blob.embedding.buffer.slice(blob.embedding.byteOffset))),
    ).toEqual([1, 2, 3, 4]);
  });

  it("--insert upserts under the unique-active index: siblings are retired BEFORE the new row activates", () => {
    const db = freshDb(["a", "b", "c"]);
    seedEmb(db, "a", OLD, 1);
    seedEmb(db, "b", OLD, 1);
    seedEmb(db, "b", NEW, 0); // an existing INACTIVE row of the target model: the ON CONFLICT branch
    // c has no embedding at all: a plain INSERT
    const n = loadGpuVecs(db, {
      model: NEW,
      dim: DIM,
      ids: ["a", "b", "c"],
      vecs: vecBytes(3),
      insert: true,
    });
    expect(n).toBe(3);
    for (const id of ["a", "b", "c"]) {
      expect(
        rows(db, id)
          .filter((r) => r.is_active === 1)
          .map((r) => r.model),
      ).toEqual([NEW]);
    }
    // superseded rows are deactivated, never deleted
    expect(rows(db, "a")).toEqual([
      { model: NEW, is_active: 1 },
      { model: OLD, is_active: 0 },
    ]);
  });

  it("--insert is idempotent: a second load of the same model hits ON CONFLICT and still leaves one active row", () => {
    const db = freshDb(["a"]);
    seedEmb(db, "a", OLD, 1);
    const opts = { model: NEW, dim: DIM, ids: ["a"], vecs: vecBytes(1), insert: true };
    loadGpuVecs(db, opts);
    loadGpuVecs(db, opts);
    expect(rows(db, "a").filter((r) => r.is_active === 1)).toHaveLength(1);
  });

  it("the unique index really is there: activating a second row directly is refused (so the ordering above is load-bearing)", () => {
    const db = freshDb(["a"]);
    seedEmb(db, "a", OLD, 1);
    expect(() => seedEmb(db, "a", NEW, 1)).toThrow(/UNIQUE|constraint/i);
  });

  it("an id that is not a chunk aborts the whole load and rolls back what was written before it", () => {
    const db = freshDb(["a"]);
    seedEmb(db, "a", OLD, 1);
    expect(() =>
      loadGpuVecs(db, {
        model: NEW,
        dim: DIM,
        ids: ["a", "ghost"],
        vecs: vecBytes(2),
        insert: true,
      }),
    ).toThrow();
    expect(rows(db, "a")).toEqual([{ model: OLD, is_active: 1 }]);
  });

  it("refuses a vecs file whose size is not ids * dim * 4", () => {
    const db = freshDb(["a"]);
    expect(() =>
      loadGpuVecs(db, { model: NEW, dim: DIM, ids: ["a", "b"], vecs: vecBytes(1), insert: true }),
    ).toThrow(/size mismatch/);
  });
});

describe("invalidateVecIndex without sqlite-vec (node:sqlite)", () => {
  it("removes the stored fingerprint row, which is what makes the next ensureVecChunks rebuild", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    db.exec(
      "CREATE TABLE IF NOT EXISTS vec_index_fingerprint (id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT INTO vec_index_fingerprint (id, fingerprint) VALUES (1, 'real-fingerprint')",
    ).run();
    invalidateVecIndex(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM vec_index_fingerprint").get()).toEqual({ n: 0 });
  });

  it("is a no-op on a db that never recorded one", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    expect(() => invalidateVecIndex(db)).not.toThrow();
  });
});

describe("exportChunkTexts", () => {
  const egress = compileEgressFilter(["private/**"]);

  function exportDb(): any {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seedChunk(db, "c1", "notes/Alpha.md", JSON.stringify(["Alpha", "Intro"]), "first body");
    seedChunk(db, "c2", "private/Secret.md", "[]", "must not leave the machine");
    seedChunk(db, "c3", "notes/Beta.md", "not json", "third body");
    return db;
  }

  it("emits the SHIPPED enriched text when chunkContext is on", () => {
    const out = exportChunkTexts(exportDb(), ["v1"], { chunkContext: true, egress });
    expect(out.ids).toEqual(["c1", "c3"]);
    expect(out.lines.map((l) => JSON.parse(l))).toEqual([
      { chunk_id: "c1", text: enrichChunkText("notes/Alpha.md", ["Alpha", "Intro"], "first body") },
      // unparseable headings degrade to title-only, not an exception
      { chunk_id: "c3", text: enrichChunkText("notes/Beta.md", [], "third body") },
    ]);
    expect(JSON.parse(out.lines[0] as string).text).toMatch(
      /^Alpha — Alpha — Intro\n\nfirst body$/,
    );
  });

  it("emits bare content when chunkContext is off", () => {
    const out = exportChunkTexts(exportDb(), ["v1"], { chunkContext: false, egress });
    expect(out.lines.map((l) => JSON.parse(l).text)).toEqual(["first body", "third body"]);
  });

  it("drops egress-excluded paths and COUNTS them rather than skipping silently", () => {
    const out = exportChunkTexts(exportDb(), ["v1"], { chunkContext: true, egress });
    expect(out.ids).not.toContain("c2");
    expect(out.lines.join("\n")).not.toContain("must not leave the machine");
    expect(out.excluded).toBe(1);
  });

  it("with no exclusion rules exports every chunk", () => {
    const out = exportChunkTexts(exportDb(), ["v1"], {
      chunkContext: true,
      egress: compileEgressFilter([]),
    });
    expect(out.ids).toEqual(["c1", "c3", "c2"]); // ordered by path
    expect(out.excluded).toBe(0);
  });
});
