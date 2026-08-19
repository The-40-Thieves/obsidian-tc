// THE-635 v1 — point-in-time filter + changed-since-D flag. Deterministic FILTER + FLAG, NOT
// content reconstruction and NOT a ranking change (see the ticket's "Sketch"/scope): a chunk
// created after `range.end` (D) did not exist at D and is excluded outright; a chunk that existed
// at D but has since been edited is INCLUDED (never silently dropped) and flagged `changedSinceD:
// true` so the caller is never handed current content presented as the D-state.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { changedSinceD, filterChunksAsOf } from "../src/search/point_in_time";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function dbWithChunks(): Database {
  const d = openMemoryDb();
  runMigrations(d, [{ version: "20260519_001", sql: INIT_SQL }]);
  return d;
}

function addChunk(
  db: Database,
  id: string,
  path: string,
  createdAt: number,
  updatedAt: number,
  vaultId = VAULT,
): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, vaultId, path, "0", "[]", `body ${id}`, `h-${id}`, 1, createdAt, updatedAt);
}

describe("THE-635 changedSinceD (pure)", () => {
  it("flags unchanged-since-D when updated_at <= D", () => {
    expect(changedSinceD(100, 100, 200)).toBe(false);
    expect(changedSinceD(100, 200, 200)).toBe(false);
  });

  it("flags changed-since-D when created_at <= D < updated_at", () => {
    expect(changedSinceD(100, 250, 200)).toBe(true);
  });
});

describe("THE-635 filterChunksAsOf", () => {
  it("excludes a chunk created after D — it did not exist yet", () => {
    const d = dbWithChunks();
    addChunk(d, "c1", "a.md", 300, 300); // created after D=200
    const out = filterChunksAsOf(d, VAULT, { start: 0, end: 200 });
    expect(out).toHaveLength(0);
  });

  it("includes and flags changedSinceD:false for a chunk untouched since D", () => {
    const d = dbWithChunks();
    addChunk(d, "c1", "a.md", 50, 100); // created 50, last touched 100, D=200
    const out = filterChunksAsOf(d, VAULT, { start: 0, end: 200 });
    expect(out).toHaveLength(1);
    expect(out[0]?.changedSinceD).toBe(false);
  });

  it("includes and flags changedSinceD:true for a chunk existing at D but edited since", () => {
    const d = dbWithChunks();
    addChunk(d, "c1", "a.md", 50, 250); // existed at D=200 (created 50 <= 200), edited after (250 > 200)
    const out = filterChunksAsOf(d, VAULT, { start: 0, end: 200 });
    expect(out).toHaveLength(1);
    expect(out[0]?.changedSinceD).toBe(true);
  });

  it("never presents a changed chunk as unflagged — same query, same content, correct flag only differs by date", () => {
    const d = dbWithChunks();
    addChunk(d, "c1", "a.md", 50, 100);
    addChunk(d, "c2", "b.md", 50, 250);
    const out = filterChunksAsOf(d, VAULT, { start: 0, end: 200 });
    const byId = new Map(out.map((c) => [c.id, c]));
    expect(byId.get("c1")?.changedSinceD).toBe(false);
    expect(byId.get("c2")?.changedSinceD).toBe(true);
  });

  it("excludes a chunk last touched before `since` (range.start) — outside the requested window", () => {
    const d = dbWithChunks();
    addChunk(d, "c1", "a.md", 10, 20); // created+updated well before since=100
    const out = filterChunksAsOf(d, VAULT, { start: 100, end: 200 });
    expect(out).toHaveLength(0);
  });

  it("a since of 0 (or the default when start is 0) applies no lower bound", () => {
    const d = dbWithChunks();
    addChunk(d, "c1", "a.md", 0, 0);
    const out = filterChunksAsOf(d, VAULT, { start: 0, end: 200 });
    expect(out).toHaveLength(1);
  });

  it("scopes strictly to the given vault — another vault's chunks never leak", () => {
    const d = dbWithChunks();
    addChunk(d, "c1", "a.md", 50, 100, VAULT);
    addChunk(d, "c2", "a.md", 50, 100, "other-vault");
    const out = filterChunksAsOf(d, VAULT, { start: 0, end: 200 });
    expect(out.map((c) => c.id)).toEqual(["c1"]);
  });

  it("is a boundary-inclusive filter at exactly D (created_at === end)", () => {
    const d = dbWithChunks();
    addChunk(d, "c1", "a.md", 200, 200);
    const out = filterChunksAsOf(d, VAULT, { start: 0, end: 200 });
    expect(out).toHaveLength(1);
    expect(out[0]?.changedSinceD).toBe(false);
  });
});
