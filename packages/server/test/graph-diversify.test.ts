// THE-393 — capped graph stream + note-collapse/MMR diversification. Proves: (1) hub notes are
// suppressed from expansion when the capped stream is on and kept when off, (2) the per-seed cap
// bounds one seed's expansion share, (3) note-collapse caps chunks per note and backfills from
// the next candidates, (4) MMR skips a near-duplicate in favor of a diverse pick while never
// displacing the rank-1 hit, and (5) everything off reproduces the historical ranking exactly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { graphSearch } from "../src/search/graph_search";
import { expandGraph } from "../src/search/graph_search_stages/graph_expansion";
import type { GraphSearchOptions } from "../src/search/graph_search_stages/types";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function vd(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function seedDb(): Database {
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

function addChunk(
  db: Database,
  id: string,
  path: string,
  content: string,
  vec: number[],
  index = "0",
): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, index, "[]", content, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

function addEdge(db: Database, source: string, target: string): void {
  db.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, provenance, created_at, updated_at) VALUES (?, ?, ?, 'links_to', 'wikilink', 0, 0)",
  ).run(VAULT, source, target);
}

function addAclSet(db: Database, setId: number, paths: string[]): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS acl_path_members (set_id INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (set_id, path)) WITHOUT ROWID",
  );
  const insert = db.prepare("INSERT INTO acl_path_members (set_id, path) VALUES (?, ?)");
  for (const path of paths) insert.run(setId, path);
}

interface HubAclFixture {
  db: Database;
  readableSetId: number;
  unrestrictedSetId: number;
}

function hubAclFixture(includeDenied: boolean): HubAclFixture {
  const db = seedDb();
  addChunk(db, "root", "Root.md", "root seed", vd(0.99));
  addChunk(db, "candidate", "S.md", "candidate hub", vd(0.6));
  addChunk(db, "public", "public/N.md", "readable neighbor", vd(0.5));
  addEdge(db, "Root.md", "S.md");
  addEdge(db, "S.md", "public/N.md");

  const deniedPaths: string[] = [];
  if (includeDenied) {
    for (let i = 0; i < 6; i++) {
      const path = `denied/N${i}.md`;
      deniedPaths.push(path);
      addChunk(db, `denied-${i}`, path, `denied neighbor ${i}`, vd(0.4));
      addEdge(db, "S.md", path);
    }
    // Unindexed edge targets are absent from acl_path_members even for an unrestricted caller.
    // Their degree contribution must remain unchanged for that caller.
    addEdge(db, "S.md", "denied/unindexed.md");
  }

  const readablePaths = ["Root.md", "S.md", "public/N.md"];
  addAclSet(db, 1, readablePaths);
  addAclSet(db, 2, [...readablePaths, ...deniedPaths]);
  return { db, readableSetId: 1, unrestrictedSetId: 2 };
}

function expandHubFixture(
  fixture: HubAclFixture,
  access: "restricted" | "predicate" | "unrestricted" | "legacy",
  smooth = false,
) {
  const isReadable = (path: string) => !path.startsWith("denied/");
  let accessOpts: Partial<GraphSearchOptions> = {};
  if (access === "restricted") {
    accessOpts = {
      isReadable,
      aclSetId: fixture.readableSetId,
      aclWalkFilter: { enabled: true, restricted: true },
    };
  } else if (access === "predicate") {
    accessOpts = { isReadable };
  } else if (access === "unrestricted") {
    accessOpts = {
      isReadable: () => true,
      aclSetId: fixture.unrestrictedSetId,
      aclWalkFilter: { enabled: true, unrestricted: true },
    };
  }
  return expandGraph({
    db: fixture.db,
    opts: {
      ...BASE,
      ...accessOpts,
      graphStream: { enabled: true, hubDegreeCap: 3, perSeedCap: 20 },
      ...(smooth ? { smoothExpansion: { enabled: true, hubMu: 1, hubGamma: 1 } } : {}),
    },
    seedPaths: ["Root.md"],
    seedChunkIds: new Set(["root"]),
    hopLimit: 2,
    similarityThreshold: 0.2,
    maxExpansionChunks: 20,
    decayEnabled: false,
    decayLambda: 0,
    decayNowMs: 0,
  });
}

const BASE = {
  query: "anything",
  queryVec: [1, 0, 0, 0],
  vaultId: VAULT,
  finalTopK: 10,
  router: { enabled: false as const },
  lexical: { enabled: false as const },
};

describe("THE-393 capped graph stream", () => {
  // S seeds; S links to a normal note N and a hub H (degree over the cap via fan-out edges).
  function hubDb(): Database {
    const db = seedDb();
    addChunk(db, "seed", "S.md", "seed body", vd(0.99));
    addChunk(db, "n", "N.md", "normal neighbor", vd(0.5));
    addChunk(db, "hub", "H.md", "hub page", vd(0.5));
    addEdge(db, "S.md", "N.md");
    addEdge(db, "S.md", "H.md");
    for (let i = 0; i < 6; i++) addEdge(db, "H.md", `x${i}.md`); // degree(H) = 7 > cap 5
    return db;
  }

  it("suppresses hub-note expansion candidates when enabled; keeps them when off", async () => {
    const db = hubDb();
    const off = await graphSearch(db, { ...BASE, seedCount: 1 });
    expect(off.map((r) => r.chunk_id)).toContain("hub");
    const on = await graphSearch(db, {
      ...BASE,
      seedCount: 1,
      graphStream: { enabled: true, hubDegreeCap: 5 },
    });
    const ids = on.map((r) => r.chunk_id);
    expect(ids).toContain("n");
    expect(ids).not.toContain("hub");
  });

  it("caps expansion chunks per root seed", async () => {
    const db = seedDb();
    addChunk(db, "seed", "S.md", "seed body", vd(0.99));
    for (const [i, t] of ["A", "B", "C"].entries()) {
      addChunk(db, `t${t}`, `${t}.md`, `neighbor ${t}`, vd(0.6 - i * 0.05));
      addEdge(db, "S.md", `${t}.md`);
    }
    const on = await graphSearch(db, {
      ...BASE,
      seedCount: 1,
      graphStream: { enabled: true, perSeedCap: 2, hubDegreeCap: 100 },
    });
    const expansions = on.filter((r) => r.source === "expansion");
    expect(expansions).toHaveLength(2);
    // Best-similarity neighbors kept, worst dropped.
    expect(expansions.map((r) => r.chunk_id).sort()).toEqual(["tA", "tB"]);
  });

  it("does not suppress a candidate whose degree exceeds the cap only through denied neighbors", () => {
    const fixture = hubAclFixture(true);
    const result = expandHubFixture(fixture, "restricted");

    expect(result.expansionChunks.map((candidate) => candidate.path)).toContain("S.md");
  });

  it("makes restricted hard-cap results independent of denied notes and edges", () => {
    const withDenied = hubAclFixture(true);
    const withoutDenied = hubAclFixture(false);

    expect(expandHubFixture(withDenied, "restricted")).toStrictEqual(
      expandHubFixture(withoutDenied, "restricted"),
    );
  });

  it("makes restricted smooth scores independent of denied notes and edges", () => {
    const withDenied = hubAclFixture(true);
    const withoutDenied = hubAclFixture(false);

    expect(expandHubFixture(withDenied, "restricted", true)).toStrictEqual(
      expandHubFixture(withoutDenied, "restricted", true),
    );
  });

  it("filters neighbor rows with the live predicate when no materialized ACL set is available", () => {
    const fixture = hubAclFixture(true);

    expect(expandHubFixture(fixture, "predicate", true)).toStrictEqual(
      expandHubFixture(fixture, "restricted", true),
    );
  });

  it("preserves the vault-wide degree and expansion result for unrestricted callers", () => {
    const fixture = hubAclFixture(true);
    const legacy = expandHubFixture(fixture, "legacy", true);
    const unrestricted = expandHubFixture(fixture, "unrestricted", true);

    expect(unrestricted).toStrictEqual(legacy);
    expect(legacy.expSimById.get("candidate")).toBeCloseTo(0.6 / (1 + 9), 8);
  });
});

describe("THE-393 diversification", () => {
  it("note-collapse caps chunks per note and backfills the next note", async () => {
    const db = seedDb();
    // Three chunks of one note lead the dense ranking; another note follows.
    addChunk(db, "a1", "A.md", "a first", vd(0.99), "0");
    addChunk(db, "a2", "A.md", "a second", vd(0.98), "1");
    addChunk(db, "a3", "A.md", "a third", vd(0.97), "2");
    addChunk(db, "b1", "B.md", "b body", vd(0.5));
    const plain = await graphSearch(db, { ...BASE, seedCount: 4, finalTopK: 3 });
    expect(plain.map((r) => r.chunk_id)).toEqual(["a1", "a2", "a3"]);
    const collapsed = await graphSearch(db, {
      ...BASE,
      seedCount: 4,
      finalTopK: 3,
      diversify: { maxPerNote: 2 },
    });
    expect(collapsed.map((r) => r.chunk_id)).toEqual(["a1", "a2", "b1"]);
  });

  it("MMR keeps the rank-1 hit and swaps a near-duplicate for a diverse pick", async () => {
    const db = seedDb();
    addChunk(db, "top", "T.md", "top hit", vd(0.95));
    addChunk(db, "dupe", "D.md", "near duplicate of top", vd(0.94)); // cosine(top,dupe) ~ 1
    addChunk(db, "div", "V.md", "diverse doc", [0.1, 0, Math.sqrt(1 - 0.01), 0]); // near-orthogonal
    const plain = await graphSearch(db, { ...BASE, seedCount: 3, finalTopK: 2 });
    expect(plain.map((r) => r.chunk_id)).toEqual(["top", "dupe"]);
    const mmr = await graphSearch(db, {
      ...BASE,
      seedCount: 3,
      finalTopK: 2,
      diversify: { mmr: { enabled: true, lambda: 0.5 } },
    });
    expect(mmr.map((r) => r.chunk_id)).toEqual(["top", "div"]);
  });

  it("MMR still runs when maxPerCluster is set (cluster cap no longer starves MMR — B4)", async () => {
    const db = seedDb();
    addChunk(db, "top", "T.md", "top hit", vd(0.95));
    addChunk(db, "dupe", "D.md", "near duplicate of top", vd(0.94));
    addChunk(db, "div", "V.md", "diverse doc", [0.1, 0, Math.sqrt(1 - 0.01), 0]);
    // maxPerCluster set but cluster_id never populated (the common case). Before the fix,
    // diversifyByCluster truncated the pool to finalTopK and mmrSelect early-returned it
    // unchanged (pure RRF order → "dupe"); with the fix MMR runs and swaps in the diverse pick.
    const res = await graphSearch(db, {
      ...BASE,
      seedCount: 3,
      finalTopK: 2,
      maxPerCluster: 5,
      diversify: { mmr: { enabled: true, lambda: 0.5 } },
    });
    expect(res.map((r) => r.chunk_id)).toEqual(["top", "div"]);
  });

  it("all options off reproduces the historical ranking exactly", async () => {
    const db = seedDb();
    addChunk(db, "seed", "S.md", "seed body", vd(0.99));
    addChunk(db, "n", "N.md", "neighbor", vd(0.5));
    addEdge(db, "S.md", "N.md");
    const a = (await graphSearch(db, { ...BASE, seedCount: 2 })).map((r) => r.chunk_id);
    const b = (
      await graphSearch(db, {
        ...BASE,
        seedCount: 2,
        graphStream: { enabled: false },
        diversify: {},
      })
    ).map((r) => r.chunk_id);
    expect(b).toEqual(a);
  });
});
