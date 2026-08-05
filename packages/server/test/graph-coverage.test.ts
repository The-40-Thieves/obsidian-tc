// THE-631: an honest, additive coverage estimate for a graphSearch() call — reported via
// opts.onCoverage, never fed back into scoring or ordering (see graph_search.ts's
// estimateCoverage() doc comment for exactly what each field means). This file pins the value
// for known fixtures: a single-arm/seeds-only case (low coverage), a seed+expansion case (higher
// coverage), an expansion-capped case, and an under-filled page — plus a same-ranking check
// proving the callback is a pure side-channel.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { type CoverageEstimate, graphSearch } from "../src/search/graph_search";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function vecDim01(cos: number): number[] {
  return [cos, Math.sqrt(1 - cos * cos), 0, 0];
}

function addChunk(db: Database, id: string, path: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", `body ${id}`, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

function addEdge(db: Database, source: string, target: string): void {
  db.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, provenance, created_at, updated_at) VALUES (?, ?, ?, 'links_to', 'wikilink_forward', 0, 0)",
  ).run(VAULT, source, target);
}

function db0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  return db;
}

async function coverageOf(
  db: Database,
  opts: Parameters<typeof graphSearch>[1],
): Promise<CoverageEstimate | undefined> {
  let coverage: CoverageEstimate | undefined;
  await graphSearch(db, { ...opts, onCoverage: (c) => (coverage = c) });
  return coverage;
}

describe("THE-631: graphSearch coverage estimate", () => {
  it("low coverage: an isolated seed hit with no linked note reports one arm, expansion skipped", async () => {
    const db = db0();
    addChunk(db, "cD", "D.md", vecDim01(0.99)); // dominant, isolated seed
    const noise = [0.1, 0.08, 0.06, 0.04];
    noise.forEach((c, i) => {
      addChunk(db, `cN${i}`, `N${i}.md`, vecDim01(c));
    });
    const coverage = await coverageOf(db, {
      query: "direct",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      finalTopK: 10,
    });
    expect(coverage).toEqual({
      arms: ["seed"],
      armsContributed: 1,
      armsPossible: 5,
      confidence: { available: false as const, reason: "not_calibrated" as const },
      expansionSkipped: true, // router: top1 dominance routes to seeds-only
      expansionTruncated: false, // expansion never ran
      requested: 10,
      returned: 5,
      underfilled: true, // only 5 candidates exist in this corpus; the page asked for 10
      // THE-631 item 2: this fixture's migration chain stops at 20260519_001, so `notes` does not
      // exist. Every returned path is therefore UNKNOWN age rather than fresh — 5 chunks on 5
      // distinct paths — and nothing is counted stale from an absent table.
      staleReturned: 0,
      staleUnknown: 5,
      staleThresholdDays: 365,
    } satisfies CoverageEstimate);
  });

  it("higher coverage: a linked bridge note adds the expansion arm", async () => {
    const db = db0();
    addChunk(db, "cA", "A.md", vecDim01(0.95)); // top seed
    addChunk(db, "cB", "B.md", vecDim01(0.25)); // bridge: outside vector top-k, linked from A
    addEdge(db, "A.md", "B.md");
    const coverage = await coverageOf(db, {
      query: "bridge",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 1, // B's cosine (0.25) must lose the seed cut to be reachable via expansion only
      finalTopK: 10,
      router: { enabled: false }, // exercise expansion regardless of seed strength
    });
    expect(coverage?.arms.sort()).toEqual(["expansion", "seed"]);
    expect(coverage?.armsContributed).toBe(2);
    expect(coverage?.expansionSkipped).toBe(false);
    expect(coverage?.expansionTruncated).toBe(false); // one candidate, cap never binds
  });

  it("expansion capped: maxExpansionChunks discards qualifying candidates", async () => {
    const db = db0();
    addChunk(db, "cA", "A.md", vecDim01(0.95));
    for (let i = 0; i < 5; i++) {
      addChunk(db, `cB${i}`, `B${i}.md`, vecDim01(0.3));
      addEdge(db, "A.md", `B${i}.md`);
    }
    const coverage = await coverageOf(db, {
      query: "bridge",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 1, // the B* chunks must lose the seed cut to be reachable via expansion only
      finalTopK: 10,
      router: { enabled: false },
      maxExpansionChunks: 2, // 5 candidates qualify, only 2 fit
    });
    expect(coverage?.expansionTruncated).toBe(true);
    expect(coverage?.arms).toContain("expansion");
  });

  it("under-filled page: fewer candidates exist than the caller asked for", async () => {
    const db = db0();
    addChunk(db, "cA", "A.md", vecDim01(0.9));
    addChunk(db, "cB", "B.md", vecDim01(0.85));
    const coverage = await coverageOf(db, {
      query: "small corpus",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      finalTopK: 25,
    });
    expect(coverage?.requested).toBe(25);
    expect(coverage?.returned).toBeLessThan(25);
    expect(coverage?.underfilled).toBe(true);
  });

  it("is a pure side-channel: attaching onCoverage never changes the returned ranking", async () => {
    const db = db0();
    addChunk(db, "cA", "A.md", vecDim01(0.95));
    addChunk(db, "cB", "B.md", vecDim01(0.25));
    addEdge(db, "A.md", "B.md");
    const opts: Parameters<typeof graphSearch>[1] = {
      query: "bridge",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 10,
      finalTopK: 10,
      router: { enabled: false },
    };
    const without = await graphSearch(db, opts);
    const withCallback = await graphSearch(db, { ...opts, onCoverage: () => {} });
    expect(withCallback).toEqual(without);
  });
});

describe("THE-631 item 2: staleness signal on the coverage estimate", () => {
  const DAY = 86_400_000;

  /** The coverage fixtures above stop at 20260519_001, which has no `notes`. This adds the table
   *  the way 20260702_001 declares it, so age can actually be resolved. */
  function withNotes(db: Database): Database {
    db.exec(
      `CREATE TABLE notes (
         vault_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT, tags TEXT, frontmatter TEXT,
         content_hash TEXT, mtime INTEGER NOT NULL, size INTEGER, indexed_at INTEGER,
         PRIMARY KEY (vault_id, path)
       );`,
    );
    return db;
  }
  const addNote = (db: Database, path: string, ageDays: number) =>
    db
      .prepare("INSERT INTO notes (vault_id, path, mtime) VALUES (?, ?, ?)")
      .run(VAULT, path, Date.now() - ageDays * DAY);

  const search = (db: Database, extra: Record<string, unknown> = {}) =>
    coverageOf(db, {
      query: "age",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      finalTopK: 10,
      ...extra,
    } as Parameters<typeof graphSearch>[1]);

  it("counts a note past the threshold as stale and leaves a recent one alone", async () => {
    const db = withNotes(db0());
    addChunk(db, "cOld", "old.md", vecDim01(0.95));
    addChunk(db, "cNew", "new.md", vecDim01(0.9));
    addNote(db, "old.md", 400); // past the 365 default
    addNote(db, "new.md", 10);
    const c = await search(db);
    expect(c?.staleReturned).toBe(1);
    expect(c?.staleUnknown).toBe(0);
    expect(c?.staleThresholdDays).toBe(365);
  });

  it("a note with NO row is UNKNOWN, never counted fresh", async () => {
    // The distinction this pins: absent age is not evidence of recency. Folding unknown into
    // fresh would silently understate staleness on any vault with pruned or unindexed notes.
    const db = withNotes(db0());
    addChunk(db, "cGhost", "ghost.md", vecDim01(0.95));
    addChunk(db, "cOld", "old.md", vecDim01(0.9));
    addNote(db, "old.md", 400); // ghost.md deliberately has no notes row
    const c = await search(db);
    expect(c?.staleUnknown).toBe(1);
    expect(c?.staleReturned).toBe(1);
  });

  it("counts NOTES, not chunks — three chunks of one stale note is one stale note", async () => {
    // Otherwise the number tracks chunking granularity rather than the vault, and a long note
    // would dominate the signal purely by being long.
    const db = withNotes(db0());
    addChunk(db, "c1", "big.md", vecDim01(0.95));
    addChunk(db, "c2", "big.md", vecDim01(0.94));
    addChunk(db, "c3", "big.md", vecDim01(0.93));
    addNote(db, "big.md", 400);
    const c = await search(db);
    expect(c?.returned).toBe(3); // three chunks came back...
    expect(c?.staleReturned).toBe(1); // ...from one stale note
  });

  it("staleThresholdDays overrides the default, and is echoed back", async () => {
    // The right value is a property of a vault's authoring cadence, not of the engine: measured
    // 2026-08-04 the live vault's oldest note is 107 days, so at the 365 default this count is 0
    // there for every query. A 30-day threshold makes the same corpus report a stale note.
    const db = withNotes(db0());
    addChunk(db, "cA", "a.md", vecDim01(0.95));
    addNote(db, "a.md", 60);
    expect((await search(db))?.staleReturned).toBe(0); // 60 < 365
    const tight = await search(db, { staleThresholdDays: 30 });
    expect(tight?.staleReturned).toBe(1); // 60 > 30
    expect(tight?.staleThresholdDays).toBe(30);
  });

  it("survives a store with no `notes` table — every path unknown, no throw", async () => {
    // An unguarded SELECT would throw "no such table: notes" from inside a search request, so an
    // additive observability field would become a query outage on any pre-20260702_001 cache.
    const db = db0(); // deliberately WITHOUT the notes table
    addChunk(db, "cA", "a.md", vecDim01(0.95));
    addChunk(db, "cB", "b.md", vecDim01(0.9));
    const c = await search(db);
    expect(c?.staleUnknown).toBe(2);
    expect(c?.staleReturned).toBe(0);
  });
});
