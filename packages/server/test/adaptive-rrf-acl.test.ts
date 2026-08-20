// THE-853 (security): querySpecificity computed `n` (corpus size) and per-term `df` over the
// ENTIRE vault (`WHERE vault_id = ?`, no ACL partition) — `graph_search_stages/fusion.ts` passed
// no aclSetId/blocked into it, so a restricted caller's adaptive-RRF tilt was always the
// whole-corpus signal. The specificity value reorders the caller's OWN readable results (rare
// terms upweight lexical/sparse, common terms upweight dense), so a term whose document frequency
// is entirely inside notes the caller cannot read still moves their ranking — a cross-ACL
// term-presence oracle riding the RANKING channel, not the content channel: query a rare term,
// watch adaptive RRF pull the lexical stream up, learn the term's whole-vault frequency without
// ever seeing a hit for it.
//
// Two-world differential (same shape as THE-852's graph-walk-acl.test.ts / THE-695's
// bm25-acl-exact.test.ts): World A has an unreadable note containing a query term; World B is the
// SAME corpus with that note physically removed (the "as if it never existed" ground truth). A
// caller who can read the same documents in both worlds must get the SAME specificity signal in
// both — today (no aclSetId threaded) they do not; with the caller's aclSetId joined, they do.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { querySpecificity } from "../src/search/adaptive_rrf";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { graphSearch } from "../src/search/graph_search";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";
const READABLE_SET = 1;

function baseDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    "CREATE TABLE acl_path_sets (set_id INTEGER PRIMARY KEY, acl_fingerprint TEXT NOT NULL, vault_id TEXT NOT NULL, generation INTEGER NOT NULL, built_at INTEGER NOT NULL, path_count INTEGER NOT NULL, UNIQUE (acl_fingerprint, vault_id))",
  );
  db.exec(
    "CREATE TABLE acl_path_members (set_id INTEGER NOT NULL REFERENCES acl_path_sets(set_id) ON DELETE CASCADE, path TEXT NOT NULL, PRIMARY KEY (set_id, path)) WITHOUT ROWID",
  );
  return db;
}

function addChunk(db: Database, id: string, path: string, content: string): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", content, `h-${id}`, 1, 0, 0);
}

/** Three readable notes share "banana"; `includeUnreadable` optionally adds a note containing the
 *  rare term "zephyr" that the caller's permitted set never includes. */
function buildWorld(includeUnreadable: boolean): Database {
  const db = baseDb();
  addChunk(db, "r1", "public/a.md", "banana common text");
  addChunk(db, "r2", "public/b.md", "banana more text");
  addChunk(db, "r3", "public/c.md", "banana filler text");
  if (includeUnreadable) {
    addChunk(db, "u1", "secret/s.md", "zephyr classified codeword");
  }
  db.prepare("INSERT INTO acl_path_sets VALUES (?,'fp','v1',1,1,3)").run(READABLE_SET);
  const m = db.prepare("INSERT INTO acl_path_members VALUES (?, ?)");
  for (const p of ["public/a.md", "public/b.md", "public/c.md"]) m.run(READABLE_SET, p);
  if (!ensureChunkFts(db)) {
    throw new Error(
      "FTS5 unavailable — THE-853's assertions cannot run. Refusing to pass vacuously.",
    );
  }
  return db;
}

describe("THE-853 querySpecificity ACL partition", () => {
  it("leaks today: whole-corpus df differs across worlds when no aclSetId is passed", () => {
    // Documents the defect and keeps the next test non-vacuous — this is the SAME call a
    // restricted caller's query used to make before this ticket.
    const worldA = querySpecificity(buildWorld(true), VAULT, "zephyr");
    const worldB = querySpecificity(buildWorld(false), VAULT, "zephyr");
    // World A: "zephyr" exists once, corpus-unique -> near-max specificity (a real, non-null tilt).
    expect(worldA).not.toBeNull();
    // World B: the unreadable note (and the term) never existed -> no signal.
    expect(worldB).toBeNull();
    // The two worlds are IDENTICAL from the caller's readable point of view, yet the signal
    // differs — a caller watching adaptive RRF tilt could infer the unreadable note's existence.
    expect(worldA).not.toBe(worldB);
  });

  it("closes it: identical specificity across both worlds once the caller's aclSetId is joined", () => {
    const worldA = querySpecificity(buildWorld(true), VAULT, "zephyr", READABLE_SET);
    const worldB = querySpecificity(buildWorld(false), VAULT, "zephyr", READABLE_SET);
    // Neither world has "zephyr" among READABLE notes, so both report no signal — the caller's
    // ranking no longer depends on whether the unreadable note exists.
    expect(worldA).toBeNull();
    expect(worldB).toBeNull();
    expect(worldA).toBe(worldB);
  });

  it("still produces a real (non-vacuous) signal for a term readable notes actually share", () => {
    // The fix must not just always return null for a restricted caller — a term with genuine
    // readable-side specificity must still score. All chunks are added BEFORE the single
    // ensureChunkFts call — it caches its result per db handle, so (as every other fixture in this
    // file does) provisioning must happen once, after every chunk exists.
    const db = baseDb();
    addChunk(db, "r1", "public/a.md", "banana common text");
    addChunk(db, "r2", "public/b.md", "banana more text");
    addChunk(db, "r3", "public/c.md", "banana filler text");
    addChunk(db, "u1", "secret/s.md", "zephyr classified codeword");
    addChunk(db, "r4", "public/d.md", "banana rarequalifier");
    db.prepare("INSERT INTO acl_path_sets VALUES (?,'fp','v1',1,1,4)").run(READABLE_SET);
    const m = db.prepare("INSERT INTO acl_path_members VALUES (?, ?)");
    for (const p of ["public/a.md", "public/b.md", "public/c.md", "public/d.md"]) {
      m.run(READABLE_SET, p);
    }
    if (!ensureChunkFts(db)) throw new Error("FTS5 unavailable");
    const spec = querySpecificity(db, VAULT, "rarequalifier", READABLE_SET);
    expect(spec).not.toBeNull();
    expect(spec as number).toBeGreaterThan(0.5);
  });

  it("blocked:true returns null unconditionally — fail-closed when no set could be resolved", () => {
    // Mirrors resolveAclWalkFilter's restricted+unresolved case: there is no aclSetId to join on,
    // so computing anything here would silently fall back to the leaky whole-corpus stat.
    const db = buildWorld(true);
    expect(querySpecificity(db, VAULT, "zephyr", undefined, true)).toBeNull();
    expect(querySpecificity(db, VAULT, "banana", undefined, true)).toBeNull();
  });

  it("is a no-op for an unrestricted caller — dark-ship contract preserved", () => {
    // No aclSetId, not blocked: byte-identical to before this ticket.
    const db = buildWorld(true);
    expect(querySpecificity(db, VAULT, "zephyr")).not.toBeNull();
  });
});

// Integration: proves `graph_search_stages/fusion.ts` actually THREADS opts.aclSetId /
// opts.aclWalkFilter?.blocked into querySpecificity — the unit tests above cover the function
// itself, this covers the call site a restricted caller's search actually takes.
describe("THE-853 fusion.ts wiring: adaptive-RRF tilt no longer rides an unreadable-only term", () => {
  function vd(c: number): number[] {
    return [c, Math.sqrt(1 - c * c), 0, 0];
  }

  function fusionAclDb(): Database {
    const db = baseDb();
    db.exec(
      `CREATE TABLE vault_edges (
         source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
         edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
       );`,
    );
    const embed = (id: string, vec: number[]) =>
      db
        .prepare(
          "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
        )
        .run(id, "test:embed", vec.length, floatBlob(vec));
    const add = (id: string, path: string, content: string, vec: number[]) => {
      addChunk(db, id, path, content);
      embed(id, vec);
    };
    add("seed", "public/seed.md", "unrelated seed text", vd(0.99));
    add("n0", "public/n0.md", "filler noise one", vd(0.8));
    add("n1", "public/n1.md", "filler noise two", vd(0.7));
    // Rare term lives ONLY in a private note the caller cannot read.
    add("priv", "secret/private.md", "zephyr classified keyword", vd(0.0));
    db.prepare("INSERT INTO acl_path_sets VALUES (?,'fp','v1',1,1,3)").run(READABLE_SET);
    const m = db.prepare("INSERT INTO acl_path_members VALUES (?, ?)");
    for (const p of ["public/seed.md", "public/n0.md", "public/n1.md"]) m.run(READABLE_SET, p);
    if (!ensureChunkFts(db)) throw new Error("FTS5 unavailable — cannot run THE-853 assertions");
    return db;
  }

  const readable = (p: string): boolean => p.startsWith("public/");

  it("leaks today: an unreadable-only rare term still tilts fusion when aclSetId is omitted", async () => {
    const db = fusionAclDb();
    let policyId = "";
    await graphSearch(db, {
      query: "zephyr",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 3,
      finalTopK: 10,
      router: { enabled: false },
      isReadable: readable,
      adaptiveRrf: { enabled: true },
      // Deliberately NOT passing aclSetId — the pre-fix call shape.
      onFusionWeights: (w) => {
        policyId = w.policyId;
      },
    });
    // "idf": the whole-corpus df for "zephyr" (1, from the private note) drove a real tilt, even
    // though the caller cannot read the one note that term appears in.
    expect(policyId).toBe("idf");
  });

  it("closes it: the same query stays neutral once the caller's aclSetId is threaded", async () => {
    const db = fusionAclDb();
    let policyId = "";
    await graphSearch(db, {
      query: "zephyr",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 3,
      finalTopK: 10,
      router: { enabled: false },
      isReadable: readable,
      adaptiveRrf: { enabled: true },
      aclSetId: READABLE_SET,
      onFusionWeights: (w) => {
        policyId = w.policyId;
      },
    });
    // No readable note contains "zephyr" -> querySpecificity returns null -> static (neutral)
    // weights, exactly as if the term did not exist in the corpus at all.
    expect(policyId).toBe("static");
  });
});
