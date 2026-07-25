// THE-537 — the note_quality rollup.
//
// The ticket's acceptance, literally: a fixture vault with ONE deliberately duplicated body, ONE
// note with no in/out edges, ONE note untouched for >365d, and ONE open contradiction produces
// exactly those four flag assignments and no others. Plus: running twice is idempotent, a note with
// zero retrievals scores NULL rather than 0, and no ranking module imports the scorer.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  flagsFor,
  readNoteQuality,
  recomputeNoteQuality,
  STALE_EDIT_DAYS,
  scoreNote,
} from "../src/experiential/note-quality";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) }));

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const VAULT = "main";

function stores(): { cacheDb: Database; edb: Database } {
  const cacheDb = openMemoryDb();
  provisionCacheDb(cacheDb);
  const edb = openMemoryDb();
  runMigrations(edb, CHAIN);
  return { cacheDb, edb };
}

/**
 * The fixture the ticket describes. Each note carries EXACTLY ONE problem, so a flag appearing on
 * the wrong note is a failure rather than a coincidence:
 *
 *   dup.md          — a body shared with other.md (duplicate)
 *   orphan.md       — no edges in either direction (orphan)
 *   ancient.md      — mtime 400 days ago (stale_edit)
 *   contradicted.md — one open contradiction (contradicted)
 *   clean.md        — none of the above; the control
 */
function seed(cacheDb: Database, edb: Database): void {
  const note = cacheDb.prepare(
    "INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at) VALUES (?, ?, ?, '[]', NULL, ?, ?, 10, ?)",
  );
  const chunk = cacheDb.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at, body_sha) VALUES (?, ?, ?, ?, '[]', ?, ?, 10, ?, ?, ?)",
  );
  const edge = cacheDb.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, edge_kind, provenance, created_at, updated_at) VALUES (?, ?, ?, 'links_to', 'literal', 'wikilink', ?, ?)",
  );

  const paths = ["dup.md", "other.md", "orphan.md", "ancient.md", "contradicted.md", "clean.md"];
  for (const p of paths) {
    const mtime = p === "ancient.md" ? NOW - 400 * DAY : NOW - DAY;
    note.run(VAULT, p, p, `h-${p}`, mtime, NOW);
  }

  // dup.md and other.md share a body_sha -> both carry a duplicated body.
  chunk.run("c-dup", VAULT, "dup.md", 0, "shared body", "h1", NOW, NOW, "SHA-SHARED");
  chunk.run("c-other", VAULT, "other.md", 0, "shared body", "h2", NOW, NOW, "SHA-SHARED");
  // Everyone else gets a unique body.
  for (const p of ["orphan.md", "ancient.md", "contradicted.md", "clean.md"]) {
    chunk.run(`c-${p}`, VAULT, p, 0, `body of ${p}`, `h-${p}`, NOW, NOW, `SHA-${p}`);
  }

  // Edges for everyone EXCEPT orphan.md, so exactly one note has degree 0.
  for (const p of ["dup.md", "other.md", "ancient.md", "contradicted.md"]) {
    edge.run(VAULT, p, "clean.md", NOW, NOW);
  }
  edge.run(VAULT, "clean.md", "dup.md", NOW, NOW);

  cacheDb
    .prepare(
      "INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path, source_content_sha, conflict_content_sha, judge_verdict, status, detected_at) VALUES ('x1', ?, 'c-contradicted.md', 'contradicted.md', 'c-clean.md', 'zz-not-a-note.md', 's1', 's2', 'contradiction', 'open', ?)",
    )
    .run(VAULT, NOW);
  void edb;
}

const flagsOf = (edb: Database): Map<string, string[]> =>
  new Map(
    readNoteQuality(edb, { vaultId: VAULT }).map((r) => [r.path, JSON.parse(r.flags) as string[]]),
  );

describe("THE-537 note_quality rollup", () => {
  it("assigns exactly the four fixture flags, and no others", () => {
    const { cacheDb, edb } = stores();
    seed(cacheDb, edb);
    recomputeNoteQuality(cacheDb, edb, { vaultId: VAULT, nowMs: NOW });

    const flags = flagsOf(edb);
    expect(flags.get("dup.md")).toEqual(["duplicate"]);
    expect(flags.get("other.md")).toEqual(["duplicate"]);
    expect(flags.get("orphan.md")).toEqual(["orphan"]);
    expect(flags.get("ancient.md")).toEqual(["stale_edit"]);
    expect(flags.get("contradicted.md")).toEqual(["contradicted"]);
    // The control note carries nothing — a flag here would mean a rule fires on healthy notes.
    expect(flags.get("clean.md")).toEqual([]);
  });

  it("counts a body as duplicated only across DIFFERENT paths", () => {
    const { cacheDb, edb } = stores();
    seed(cacheDb, edb);
    // Repetition WITHIN one note is structure, not duplication.
    cacheDb
      .prepare(
        "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at, body_sha) VALUES ('c-clean2', ?, 'clean.md', 1, '[]', 'body of clean.md', 'h9', 10, ?, ?, 'SHA-clean.md')",
      )
      .run(VAULT, NOW, NOW);
    recomputeNoteQuality(cacheDb, edb, { vaultId: VAULT, nowMs: NOW });
    expect(flagsOf(edb).get("clean.md")).toEqual([]);
  });

  it("scores NULL — not 0 — when there is no usage evidence", () => {
    const { cacheDb, edb } = stores();
    seed(cacheDb, edb);
    const stats = recomputeNoteQuality(cacheDb, edb, { vaultId: VAULT, nowMs: NOW });
    // Nothing has been retrieved, so nothing is scorable. "Unmeasured" must not read as "bad".
    expect(stats.unscored).toBe(6);
    expect(stats.scored).toBe(0);
    for (const r of readNoteQuality(edb, { vaultId: VAULT })) expect(r.quality_score).toBeNull();
  });

  it("scores a note once it has retrieval evidence", () => {
    const { cacheDb, edb } = stores();
    seed(cacheDb, edb);
    const ins = edb.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results, cited_in_response) VALUES (?, 'c-clean.md', ?, 's', 'q', 1, ?)",
    );
    ins.run("r1", NOW - DAY, 1);
    ins.run("r2", NOW - DAY, 0);
    recomputeNoteQuality(cacheDb, edb, { vaultId: VAULT, nowMs: NOW });
    const clean = readNoteQuality(edb, { vaultId: VAULT }).find((r) => r.path === "clean.md");
    expect(clean?.retrievals).toBe(2);
    expect(clean?.citations).toBe(1);
    expect(clean?.quality_score).not.toBeNull();
  });

  it("keeps stale-by-edit and stale-by-access as SEPARATE signals", () => {
    const { cacheDb, edb } = stores();
    seed(cacheDb, edb);
    // clean.md: edited yesterday (not stale_edit) but last read 60 days ago (stale_access).
    edb
      .prepare(
        "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results) VALUES ('r1', 'c-clean.md', ?, 's', 'q', 1)",
      )
      .run(NOW - 60 * DAY);
    recomputeNoteQuality(cacheDb, edb, { vaultId: VAULT, nowMs: NOW });
    const flags = flagsOf(edb);
    expect(flags.get("clean.md")).toEqual(["stale_access"]);
    // ...and ancient.md is the reverse: stale by edit, never read, so no stale_access.
    expect(flags.get("ancient.md")).toEqual(["stale_edit"]);
  });

  it("is idempotent — a re-run at the same clock reproduces the rows exactly", () => {
    const { cacheDb, edb } = stores();
    seed(cacheDb, edb);
    recomputeNoteQuality(cacheDb, edb, { vaultId: VAULT, nowMs: NOW });
    const first = readNoteQuality(edb, { vaultId: VAULT });
    recomputeNoteQuality(cacheDb, edb, { vaultId: VAULT, nowMs: NOW });
    const second = readNoteQuality(edb, { vaultId: VAULT });

    expect(second).toHaveLength(first.length); // upsert on (vault_id, path), never an append
    expect(second).toEqual(first); // byte-identical, computed_at included
  });

  it("advances computed_at and the clock-dependent columns on a later run", () => {
    // age_days and stale_access are functions of the CLOCK, not just of the data — so
    // "idempotent" above means "at a fixed clock". A later run legitimately moves them, and a
    // test that demanded otherwise would be asserting that time does not pass.
    const { cacheDb, edb } = stores();
    seed(cacheDb, edb);
    recomputeNoteQuality(cacheDb, edb, { vaultId: VAULT, nowMs: NOW });
    const before = readNoteQuality(edb, { vaultId: VAULT }).find((r) => r.path === "clean.md");
    recomputeNoteQuality(cacheDb, edb, { vaultId: VAULT, nowMs: NOW + 10 * DAY });
    const after = readNoteQuality(edb, { vaultId: VAULT }).find((r) => r.path === "clean.md");

    expect(after?.computed_at).toBe(NOW + 10 * DAY);
    expect(after?.age_days).toBeCloseTo((before?.age_days ?? 0) + 10, 6);
    // The data-derived columns are untouched by the clock alone.
    expect(after?.chunk_count).toBe(before?.chunk_count);
    expect(after?.in_degree).toBe(before?.in_degree);
  });

  it("reports dup_ratio as NULL when body_sha is unavailable, not 0", () => {
    // "No duplicate bodies" and "we cannot tell" are different claims; a 0 asserts the first.
    const base = {
      vault_id: VAULT,
      path: "p",
      computed_at: NOW,
      chunk_count: 0,
      dup_chunk_count: 0,
      dup_ratio: null,
      mtime: NOW,
      age_days: 0,
      last_retrieved_at: null,
      retrievals: 0,
      citations: 0,
      outcome_balance: 0,
      in_degree: 1,
      out_degree: 1,
      orphan: 0,
      contradictions_open: 0,
      tombstoned: 0,
      score_version: 1,
    };
    expect(scoreNote(base)).toBeNull();
    expect(flagsFor(base, NOW)).toEqual([]);
    expect(flagsFor({ ...base, age_days: STALE_EDIT_DAYS + 1 }, NOW)).toEqual(["stale_edit"]);
  });

  it("filters by flag and honours the limit", () => {
    const { cacheDb, edb } = stores();
    seed(cacheDb, edb);
    recomputeNoteQuality(cacheDb, edb, { vaultId: VAULT, nowMs: NOW });
    const dups = readNoteQuality(edb, { vaultId: VAULT, flags: ["duplicate"] });
    expect(dups.map((r) => r.path).sort()).toEqual(["dup.md", "other.md"]);
    expect(readNoteQuality(edb, { vaultId: VAULT, limit: 2 })).toHaveLength(2);
    // An AND filter with no matching row is empty, not everything.
    expect(readNoteQuality(edb, { vaultId: VAULT, flags: ["duplicate", "orphan"] })).toEqual([]);
  });

  it("scopes to one vault", () => {
    const { cacheDb, edb } = stores();
    seed(cacheDb, edb);
    recomputeNoteQuality(cacheDb, edb, { vaultId: "other-vault", nowMs: NOW });
    expect(readNoteQuality(edb, { vaultId: "other-vault" })).toEqual([]);
    expect(readNoteQuality(edb, { vaultId: VAULT })).toEqual([]);
  });
});

// The ticket's explicit boundary: feeding quality_score into fusion would be a RANKING change
// needing its own eval gate, so nothing on the retrieval path may import the scorer. Asserted
// structurally, because "we won't do that" is not a mechanism.
describe("THE-537 note_quality is NOT the ranker", () => {
  it("no retrieval or ranking module imports the scorer", async () => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const tracked = execFileSync(
      "git",
      ["ls-files", "packages/server/src/search/*.ts", "packages/server/src/search/**/*.ts"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    // A zero-file scan would pass vacuously — the exact failure this repo's other source gates
    // refuse. The search tree is large; a floor well below its real size still catches collapse.
    expect(tracked.length).toBeGreaterThan(20);

    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const offenders = tracked.filter((f) =>
      readFileSync(join(root, f), "utf8").includes("note-quality"),
    );
    expect(offenders).toEqual([]);
  });
});
