// THE-538 — retrieval POLICY provenance.
//
// chunk_retrievals recorded what was returned and where it ranked, but nothing about HOW it was
// ranked: GraphSearchResult.source was discarded at every call site and the fusion configuration
// was never written down. That makes a logged outcome unattributable to a ranking policy — not
// merely noisy, but unidentifiable, so any later weight-learning work would be unsound.
//
// This pins the join (one policy row per call, matching every hit row from that call), the
// back-compatibility (no policy -> byte-identical to pre-THE-538 behaviour, old rows NULL), and the
// atomicity (a policy row and its hits commit together or not at all).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { recomputeActivation } from "../src/experiential/activation";
import { createRetrievalLogger } from "../src/experiential/log";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: read(file),
}));
/** The chain as it stood BEFORE this ticket — used to prove a live db migrates forward. */
const CHAIN_BEFORE = CHAIN.filter((m) => m.version !== "20260725_001");
const NOW = 1_700_000_000_000;

function edb(chain = CHAIN): Database {
  const db = openMemoryDb();
  runMigrations(db, chain);
  return db;
}

const logger = (db: Database) => createRetrievalLogger(db, { now: () => NOW });

const HITS = [
  { chunkId: "c1", rank: 1, score: 0.9, streamSource: "seed" },
  { chunkId: "c2", rank: 2, score: 0.8, streamSource: "expansion" },
  { chunkId: "c3", rank: 3, score: 0.7, streamSource: "lexical" },
];

const POLICY = {
  vaultId: "main",
  policyId: "idf",
  denseW: 0.75,
  lexW: 1.25,
  sparseW: 1.25,
  fusionMode: "graph_rrf",
  rrfK: 10,
  routeClass: "standard",
};

interface PolicyRow {
  event_group: string;
  ts: number;
  vault_id: string | null;
  surface_type: string | null;
  policy_id: string | null;
  arm: string | null;
  dense_w: number | null;
  lex_w: number | null;
  sparse_w: number | null;
  fusion_mode: string | null;
  rrf_k: number | null;
  route_class: string | null;
  propensity: number | null;
}

describe("THE-538 retrieval policy provenance", () => {
  it("writes exactly one policy row per call, joined to every hit by event_group", () => {
    const db = edb();
    logger(db)({
      queryText: "alpha",
      surfaceType: "vault_graph_search",
      hits: HITS,
      policy: POLICY,
    });

    const policies = db.prepare("SELECT * FROM retrieval_policy").all() as PolicyRow[];
    expect(policies).toHaveLength(1);
    const p = policies[0] as PolicyRow;
    expect(p).toMatchObject({
      vault_id: "main",
      surface_type: "vault_graph_search",
      policy_id: "idf",
      dense_w: 0.75,
      lex_w: 1.25,
      sparse_w: 1.25,
      fusion_mode: "graph_rrf",
      rrf_k: 10,
      route_class: "standard",
      ts: NOW,
    });

    const rows = db
      .prepare(
        "SELECT chunk_id, event_group, stream_source FROM chunk_retrievals ORDER BY rank_in_results",
      )
      .all() as Array<{
      chunk_id: string;
      event_group: string | null;
      stream_source: string | null;
    }>;
    expect(rows).toHaveLength(3);
    // Every hit carries the SAME event_group as the policy row — that join is the whole feature.
    for (const r of rows) expect(r.event_group).toBe(p.event_group);
    expect(rows.map((r) => r.stream_source)).toEqual(["seed", "expansion", "lexical"]);
  });

  it("defaults arm to 'control' and propensity to 1.0 — logged, not derived", () => {
    const db = edb();
    logger(db)({ queryText: "q", surfaceType: "s", hits: HITS, policy: POLICY });
    const p = db.prepare("SELECT arm, propensity FROM retrieval_policy").get() as PolicyRow;
    // This ticket adds no exploration arm and randomizes nothing. propensity is stored anyway
    // because it is the one field that cannot be reconstructed after the fact.
    expect(p.arm).toBe("control");
    expect(p.propensity).toBe(1);
  });

  it("gives each call its own event_group", () => {
    const db = edb();
    const log = logger(db);
    log({ queryText: "a", surfaceType: "s", hits: HITS, policy: POLICY });
    log({ queryText: "b", surfaceType: "s", hits: HITS, policy: POLICY });
    const groups = db.prepare("SELECT event_group FROM retrieval_policy").all() as PolicyRow[];
    expect(new Set(groups.map((g) => g.event_group)).size).toBe(2);
  });

  it("writes NO policy row and a NULL event_group when the surface describes no policy", () => {
    const db = edb();
    // Byte-identical to pre-THE-538 behaviour for any surface not yet taught to describe itself.
    logger(db)({ queryText: "q", surfaceType: "s", hits: [{ chunkId: "c1", rank: 1, score: 1 }] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM retrieval_policy").get()).toMatchObject({ n: 0 });
    const row = db.prepare("SELECT event_group, stream_source FROM chunk_retrievals").get() as {
      event_group: string | null;
      stream_source: string | null;
    };
    expect(row.event_group).toBeNull();
    expect(row.stream_source).toBeNull();
  });

  it("records a NULL weight for a policy that genuinely has none (dense-only surfaces)", () => {
    const db = edb();
    logger(db)({
      queryText: "q",
      surfaceType: "knowledge_challenge",
      hits: [{ chunkId: "c1", rank: 1, score: 1 }],
      policy: {
        vaultId: "main",
        policyId: "dense-only",
        denseW: 1,
        lexW: null,
        sparseW: null,
        fusionMode: null,
        rrfK: null,
        routeClass: null,
      },
    });
    const p = db.prepare("SELECT * FROM retrieval_policy").get() as PolicyRow;
    // A NULL here must read as "this policy has no such weight", never "we forgot to log it" —
    // which is why the row exists at all rather than being omitted for non-fusing surfaces.
    expect(p.policy_id).toBe("dense-only");
    expect(p.dense_w).toBe(1);
    expect(p.lex_w).toBeNull();
    expect(p.sparse_w).toBeNull();
  });

  it("commits the policy row and its hits together, or neither", () => {
    const db = edb();
    const errors: unknown[] = [];
    const log = createRetrievalLogger(db, { now: () => NOW, onError: (e) => errors.push(e) });
    // A duplicate chunk_retrievals PK is impossible (randomUUID), so force the failure on the
    // policy side: insert a row, then make the SAME event_group collide is also impossible.
    // Instead drop the hits table mid-flight — any failure inside the transaction must roll the
    // policy row back too, or a later join would find a policy with no hits.
    db.exec("DROP TABLE chunk_retrievals");
    log({ queryText: "q", surfaceType: "s", hits: HITS, policy: POLICY });
    expect(errors).toHaveLength(1); // the logger swallowed it, as telemetry must
    expect(db.prepare("SELECT COUNT(*) AS n FROM retrieval_policy").get()).toMatchObject({ n: 0 });
  });

  it("migrates a pre-THE-538 db forward, leaving old rows NULL in both columns", () => {
    const db = edb(CHAIN_BEFORE);
    // Old-shape row written before the migration existed.
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results) VALUES ('old', 'c-old', ?, 's', 'q', 1)",
    ).run(NOW);

    runMigrations(db, CHAIN); // forward migration, in place

    const old = db
      .prepare("SELECT event_group, stream_source FROM chunk_retrievals WHERE id = 'old'")
      .get() as { event_group: string | null; stream_source: string | null };
    expect(old.event_group).toBeNull();
    expect(old.stream_source).toBeNull();

    // ...and the new columns work for rows written after it.
    logger(db)({ queryText: "q", surfaceType: "s", hits: HITS, policy: POLICY });
    expect(db.prepare("SELECT COUNT(*) AS n FROM retrieval_policy").get()).toMatchObject({ n: 1 });

    // recomputeActivation still runs against the migrated db (it reads chunk_retrievals).
    expect(() => recomputeActivation(db, NOW + 3_600_000)).not.toThrow();
  });
});

// The ticket's stated acceptance, driven through the real tool rather than the logger alone:
// ONE vault_graph_search call -> exactly one retrieval_policy row whose event_group matches every
// chunk_retrievals row from that call, with stream_source values drawn from the real enum and
// matching the returned results' `source` field.
describe("THE-538 acceptance: one vault_graph_search call, end to end", () => {
  it("stamps one policy row and per-hit stream sources that match the returned results", async () => {
    const { FolderAcl } = await import("../src/acl");
    const { fakeEmbeddingProvider } = await import("../src/embeddings");
    const { ToolRegistry } = await import("../src/mcp/registry");
    const { indexVault } = await import("../src/search/indexer");
    const { registerM7Tools } = await import("../src/tools/m7");
    const { VaultRegistry } = await import("../src/vault/registry");
    const { makeM2Vault } = await import("./m2-helpers");

    const provider = () => fakeEmbeddingProvider({ dimensions: 32, model: "A" });
    const v = makeM2Vault({
      files: {
        "a.md": "# A\n\nalpha beta shared topic notes [[b]]",
        "b.md": "# B\n\nalpha beta shared topic more",
      },
      provider: provider(),
    });
    await indexVault({
      db: v.db,
      provider: provider(),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });

    const experiential = edb();
    const registry = new ToolRegistry({});
    registerM7Tools(registry, {
      vaultRegistry: new VaultRegistry([{ id: v.id, path: v.root }]),
      embeddingProvider: provider(),
      reranker: null,
      roles: null,
      retrievalLog: createRetrievalLogger(experiential, { now: () => NOW }),
    });

    const res = await registry.dispatch(
      "vault_graph_search",
      { vault: v.id, query: "alpha beta shared topic", final_top_k: 10 },
      {
        caller: "tester",
        authenticated: true,
        grantedScopes: new Set(["read:notes"]),
        vaultId: v.id,
        db: v.db,
        acl: new FolderAcl({ readOnly: false, defaultScopes: ["read:notes"], rules: [] }),
      },
    );
    const results = (res as { data: { results: Array<{ chunk_id: string; source: string }> } }).data
      .results;
    expect(results.length).toBeGreaterThan(0);

    const policies = experiential.prepare("SELECT * FROM retrieval_policy").all() as PolicyRow[];
    expect(policies).toHaveLength(1);
    const p = policies[0] as PolicyRow;
    expect(p.vault_id).toBe(v.id);
    expect(p.surface_type).toBe("vault_graph_search");
    // Adaptive RRF is off by default, so the weights actually applied are static all-1.
    expect(p.policy_id).toBe("static");
    expect(p.dense_w).toBe(1);
    expect(p.lex_w).toBe(1);
    expect(p.sparse_w).toBe(1);
    expect(p.fusion_mode).toBe("graph_rrf");
    expect(p.route_class).toBe("standard");

    const logged = experiential
      .prepare(
        "SELECT chunk_id, event_group, stream_source FROM chunk_retrievals ORDER BY rank_in_results",
      )
      .all() as Array<{ chunk_id: string; event_group: string | null; stream_source: string }>;
    expect(logged).toHaveLength(results.length);
    const STREAMS = ["seed", "expansion", "lexical", "sparse", "temporal"];
    for (const row of logged) {
      expect(row.event_group).toBe(p.event_group);
      expect(STREAMS).toContain(row.stream_source);
    }
    // ...and each logged stream really is the one the caller was told about.
    expect(logged.map((r) => r.stream_source)).toEqual(results.map((r) => r.source));

    v.cleanup();
  });
});
