// Note-level vectors: mean of a note's active chunk vectors for the serving model, and the
// near-duplicate pair scan over them. Read-only over chunks / chunk_embeddings.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { loadNoteVectors, nearDuplicatePairs, nearestNotes } from "../src/search/note-vectors";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

function db() {
  const d = openMemoryDb();
  provisionCacheDb(d);
  return d;
}

let n = 0;
function chunk(
  d: ReturnType<typeof db>,
  path: string,
  vec: number[],
  o: { model?: string; active?: number; vault?: string } = {},
): void {
  const id = `c${++n}`;
  d.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
     VALUES (?, ?, ?, '0', '[]', 'x', ?, 1, 0, 0)`,
  ).run(id, o.vault ?? "v", path, id);
  d.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, ?, 0)",
  ).run(id, o.model ?? "m", vec.length, floatBlob(vec), o.active ?? 1);
}

const OPTS = { model: "m", maxNotes: 100 };

/** 1/sqrt(2) at the 4-decimal precision these tests compare at. */
const HALF_DIAGONAL = Number(Math.SQRT1_2.toFixed(4));

describe("loadNoteVectors", () => {
  it("a note's vector is the unit-length mean of its active chunk vectors", () => {
    const d = db();
    chunk(d, "a.md", [2, 0, 0]);
    chunk(d, "a.md", [0, 2, 0]);
    const nv = loadNoteVectors(d, "v", OPTS);
    expect(nv.paths).toEqual(["a.md"]);
    expect([...nv.flat].map((x) => Number(x.toFixed(4)))).toEqual([
      HALF_DIAGONAL,
      HALF_DIAGONAL,
      0,
    ]);
  });

  it("ignores inactive vectors, other models, other vaults", () => {
    const d = db();
    chunk(d, "a.md", [1, 0, 0]);
    chunk(d, "a.md", [0, 1, 0], { active: 0 });
    chunk(d, "a.md", [0, 0, 1], { model: "old" });
    chunk(d, "b.md", [1, 0, 0], { vault: "other" });
    const nv = loadNoteVectors(d, "v", OPTS);
    expect(nv.paths).toEqual(["a.md"]);
    expect([...nv.flat]).toEqual([1, 0, 0]);
  });

  it("include() filters whole notes; folder restricts by prefix", () => {
    const d = db();
    chunk(d, "wiki/a.md", [1, 0, 0]);
    chunk(d, "wiki/b.md", [0, 1, 0]);
    chunk(d, "wikipedia/c.md", [0, 0, 1]);
    expect(loadNoteVectors(d, "v", { ...OPTS, folder: "wiki" }).paths).toEqual([
      "wiki/a.md",
      "wiki/b.md",
    ]);
    expect(loadNoteVectors(d, "v", { ...OPTS, include: (p) => p !== "wiki/a.md" }).paths).toEqual([
      "wiki/b.md",
      "wikipedia/c.md",
    ]);
  });

  it("maxNotes caps the load and says so", () => {
    const d = db();
    for (const p of ["a.md", "b.md", "c.md"]) chunk(d, p, [1, 0, 0]);
    const nv = loadNoteVectors(d, "v", { ...OPTS, maxNotes: 2 });
    expect(nv.paths).toEqual(["a.md", "b.md"]);
    expect(nv.truncated).toBe(true);
  });

  it("pages past one page of rows without dropping or double-counting a note", () => {
    const d = db();
    d.exec("BEGIN");
    for (let i = 0; i < 1100; i++) {
      chunk(d, `n${String(i).padStart(4, "0")}.md`, [1, 0, 0]);
      chunk(d, `n${String(i).padStart(4, "0")}.md`, [0, 1, 0]);
    }
    d.exec("COMMIT");
    const nv = loadNoteVectors(d, "v", { ...OPTS, maxNotes: 5000 });
    expect(nv.paths).toHaveLength(1100);
    expect([...nv.flat.subarray(0, 3)].map((x) => Number(x.toFixed(4)))).toEqual([
      HALF_DIAGONAL,
      HALF_DIAGONAL,
      0,
    ]);
  });

  it("empty store -> no notes, no throw", () => {
    expect(loadNoteVectors(db(), "v", OPTS).paths).toEqual([]);
  });
});

describe("nearDuplicatePairs / nearestNotes", () => {
  const build = () => {
    const d = db();
    chunk(d, "a.md", [1, 0, 0]);
    chunk(d, "b.md", [0.99, 0.14, 0]); // cos ~0.990 with a
    chunk(d, "c.md", [0.9, 0.44, 0]); // cos ~0.898 with a
    chunk(d, "d.md", [0, 0, 1]);
    return loadNoteVectors(d, "v", OPTS);
  };

  it("returns pairs at or above the floor, strongest first, each pair once", () => {
    const pairs = nearDuplicatePairs(build(), 0.89, 10);
    expect(pairs.map((p) => `${p.a}|${p.b}`)).toEqual(["a.md|b.md", "b.md|c.md", "a.md|c.md"]);
    expect(pairs[0]?.score).toBeGreaterThan(0.98);
  });

  it("the floor is exclusive of lower pairs and limit truncates", () => {
    expect(nearDuplicatePairs(build(), 0.97, 10).map((p) => `${p.a}|${p.b}`)).toEqual([
      "a.md|b.md",
    ]);
    expect(nearDuplicatePairs(build(), 0.5, 1)).toHaveLength(1);
  });

  it("nearestNotes ranks by cosine and tolerates a non-unit query", () => {
    const top = nearestNotes(build(), new Float32Array([5, 0, 0]), 2);
    expect(top.map((t) => t.path)).toEqual(["a.md", "b.md"]);
    expect(nearestNotes(build(), new Float32Array([1, 0]), 2)).toEqual([]);
  });
});
