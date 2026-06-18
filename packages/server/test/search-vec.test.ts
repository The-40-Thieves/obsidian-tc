import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { blobToFloats, ensureVecChunks, floatBlob, loadVec } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

describe("vector blob codec", () => {
  it("round-trips a float vector through the float32 blob format", () => {
    const v = [0.5, -0.25, 0, 1, 0.125];
    const back = blobToFloats(floatBlob(v));
    expect(back).toHaveLength(v.length);
    for (let i = 0; i < v.length; i++) expect(back[i]).toBeCloseTo(v[i] ?? 0, 6);
  });
  it("encodes exactly 4 bytes per dimension", () => {
    expect(floatBlob([1, 2, 3]).byteLength).toBe(12);
  });
});

// node:sqlite (the vitest runtime) opens without allowExtension, so the whole
// sqlite-vec path must degrade silently to false rather than throw. The real
// vec0 KNN behavior is exercised under bun:sqlite in the bun-smoke job.
describe("sqlite-vec degradation under node:sqlite", () => {
  it("loadVec returns false instead of throwing", () => {
    expect(loadVec(openMemoryDb())).toBe(false);
  });
  it("ensureVecChunks returns false and records no migration row", () => {
    const db = openMemoryDb();
    runMigrations(db, []);
    expect(ensureVecChunks(db, 768)).toBe(false);
    const row = db.prepare("SELECT count(*) c FROM schema_migrations").get() as { c: number };
    expect(row.c).toBe(0);
  });
});
