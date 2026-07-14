// THE-44/46 — derive-don't-mutate pins. chunk_access_stats is a VIEW over chunk_retrievals
// (no writer mutates the authored store; the numbers cannot drift from the log), and
// vaultMetrics composes it with the authored store into the cycle scorecard: totals, access
// + staleness cuts, the `linear:` frontmatter convention, surface breakdown, top notes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { vaultMetrics } from "../src/experiential/metrics";
import { openMemoryDb } from "./helpers";

const sql = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${p}`, import.meta.url)), "utf8");
const notesSql = sql("20260702_001_notes.sql");
const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [
    { version: "20260626_001", sql: sql("20260626_001_experiential_init.sql") },
    { version: "20260711_001", sql: sql("20260711_001_experiential_outcome.sql") },
    { version: "20260712_002", sql: sql("20260712_002_access_views.sql") },
  ]);
  return db;
}

function logHit(
  db: Database,
  id: string,
  chunkId: string,
  at: number,
  over: Partial<{ cited: number | null; outcome: number | null; surface: string }> = {},
): void {
  db.prepare(
    "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results, cited_in_response, outcome) VALUES (?, ?, ?, ?, 'q', 1, ?, ?)",
  ).run(
    id,
    chunkId,
    at,
    over.surface ?? "search_semantic",
    over.cited ?? null,
    over.outcome ?? null,
  );
}

function cache0(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  db.exec(notesSql);
  const ins = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, 0, '[]', 'c', ?, 10, ?, ?)",
  );
  ins.run("a1", "notes/a.md", "h1", NOW - 100 * DAY, NOW);
  ins.run("a2", "notes/a.md", "h2", NOW - 100 * DAY, NOW);
  ins.run("b1", "notes/b.md", "h3", NOW - 1 * DAY, NOW); // new this window
  ins.run("c1", "notes/c.md", "h4", NOW - 100 * DAY, NOW); // never accessed
  const note = db.prepare(
    "INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at) VALUES ('main', ?, ?, '[]', ?, ?, ?, 1, ?)",
  );
  note.run("notes/a.md", "a", JSON.stringify({ linear: "THE-44" }), "n1", NOW, NOW);
  note.run("notes/b.md", "b", JSON.stringify({ linear: "THE-46" }), "n2", NOW, NOW);
  note.run("notes/c.md", "c", null, "n3", NOW, NOW);
  return db;
}

describe("chunk_access_stats view (THE-44)", () => {
  it("derives count, last access, citations, and outcome balance from the log", () => {
    const edb = edb0();
    logHit(edb, "r1", "a1", NOW - 5 * DAY);
    logHit(edb, "r2", "a1", NOW - 2 * DAY, { cited: 1, outcome: 1 });
    logHit(edb, "r3", "a1", NOW - 1 * DAY, { outcome: -1 });
    const row = edb
      .prepare("SELECT * FROM chunk_access_stats WHERE chunk_id = 'a1'")
      .get() as Record<string, number>;
    expect(row.access_count).toBe(3);
    expect(row.last_accessed_at).toBe(NOW - 1 * DAY);
    expect(row.citations).toBe(1);
    expect(row.outcome_balance).toBe(0); // +1 - 1
  });
});

describe("vaultMetrics (THE-46)", () => {
  it("composes totals, access + staleness cuts, linear links, surfaces, top notes", () => {
    const edb = edb0();
    const cache = cache0();
    logHit(edb, "r1", "a1", NOW - 2 * DAY, { cited: 1 });
    logHit(edb, "r2", "a2", NOW - 2 * DAY);
    logHit(edb, "r3", "b1", NOW - 40 * DAY, { surface: "vault_context" }); // stale access
    // unknown chunk: counts as a retrieval event but is ignored in the note cuts
    logHit(edb, "r4", "zz-foreign", NOW - 1 * DAY, { surface: "work_search" });

    const m = vaultMetrics(edb, cache, {
      vaultId: "main",
      nowMs: NOW,
      since: NOW - 7 * DAY,
      staleDays: 30,
    });
    expect(m.totals).toMatchObject({ chunks: 4, notes: 3, new_chunks: 1 });
    // window: r1, r2, r4 in the last 7d (r3 is older)
    expect(m.totals.retrievals).toBe(3);
    expect(m.totals.citations).toBe(1);
    // access cuts are all-time: a1, a2, b1 touched; c1 never
    expect(m.access.chunks_accessed).toBe(3);
    expect(m.access.never_accessed_chunks).toBe(1);
    // stale = never (c1) + last-touch older than 30d (b1)
    expect(m.access.stale_chunks).toBe(2);
    expect(m.access.notes_accessed).toBe(2);
    // linear: frontmatter convention
    expect(m.linked).toEqual({ notes_with_linear: 2, distinct_issues: 2 });
    // surface breakdown covers the window
    expect(m.surfaces.find((s) => s.surface === "search_semantic")?.retrievals).toBe(2);
    // top notes ranked by derived access
    expect(m.top_notes[0]?.path).toBe("notes/a.md");
    expect(m.top_notes[0]?.access_count).toBe(2);
    expect(m.top_notes[0]?.citations).toBe(1);
  });
});
