// THE-628 (second PR) — the cluster-level (tier-2, RAPTOR) summary tier: store/search
// (search/cluster-summaries.ts) and the offline cluster-summary builder
// (search/indexing/summarize-clusters.ts). Covers the cluster plan's required tests: (a) flag-off
// makes ZERO gateway/embed calls, (b) a cluster summary is written+embedded and skipped when its
// cluster_key is unchanged, (c) THE MANDATORY SECURITY assertion — a caller denied ANY member note
// of a cluster never sees that cluster's summary, mutation-tested (see the dedicated describe
// block below), (d) the dark candidate stream doesn't change results when the flag is off, (e)
// covered separately by migrations-manifest.test.ts + migration-impact (no hand-built chain
// touches cluster_summaries, per `just migration-impact`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import type { GatewayClient } from "../src/gateway/client";
import {
  clusterKeyOf,
  clusterSummaryId,
  existingClusterKeys,
  hasClusterSummaries,
  searchClusterSummaries,
  upsertClusterSummary,
} from "../src/search/cluster-summaries";
import { assembleCandidates } from "../src/search/graph_search_stages/candidate_assembly";
import {
  buildClusterSummaries,
  maybeBuildClusterSummaries,
} from "../src/search/indexing/summarize-clusters";
import { upsertNoteSummary } from "../src/search/note-summaries";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const CACHE_CHAIN = CACHE_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) }));

function makeDb(): Database {
  const d = openMemoryDb();
  runMigrations(d as unknown as Database, CACHE_CHAIN);
  return d as unknown as Database;
}

const fakeGateway = (text = "A shared-theme summary."): GatewayClient =>
  ({
    extract: vi.fn(async () => ({ text, model: "test-model" })),
  }) as unknown as GatewayClient;

const fakeEmbedProvider = (dim = 4): EmbeddingProvider => ({
  id: "test-embed",
  provider: "test",
  model: "test-embed",
  dimensions: dim,
  embed: vi.fn(async (texts: string[]) => texts.map(() => Array(dim).fill(0.5))),
});

describe("cluster-summaries store", () => {
  it("clusterSummaryId is stable, and distinct from a chunk-id / note-summary-id prefix", () => {
    const id1 = clusterSummaryId("v1", "key1");
    const id2 = clusterSummaryId("v1", "key1");
    expect(id1).toBe(id2);
    expect(id1.startsWith("clu_")).toBe(true);
    expect(id1.startsWith("sum_")).toBe(false);
    expect(id1.startsWith("chk_")).toBe(false);
    expect(id1).not.toBe(clusterSummaryId("v1", "key2"));
  });

  it("clusterKeyOf is order-independent (sorted) and stable", () => {
    const k1 = clusterKeyOf(["hashB", "hashA", "hashC"]);
    const k2 = clusterKeyOf(["hashA", "hashC", "hashB"]);
    expect(k1).toBe(k2);
    expect(clusterKeyOf(["hashA"])).not.toBe(k1);
  });

  it("upsert requires non-empty memberPaths (the ACL filter cannot verify an unresolvable set)", () => {
    const db = makeDb();
    expect(() =>
      upsertClusterSummary(db, "v1", {
        clusterKey: "k1",
        summary: "s",
        model: "m",
        memberPaths: [],
        createdAt: 1,
      }),
    ).toThrow();
  });

  it("upsert + existingClusterKeys round-trip, and a re-upsert replaces the member set", () => {
    const db = makeDb();
    upsertClusterSummary(db, "v1", {
      clusterKey: "k1",
      summary: "first",
      model: "m",
      memberPaths: ["A.md", "B.md"],
      createdAt: 1,
    });
    expect(existingClusterKeys(db, "v1").has("k1")).toBe(true);
    const membersFirst = db
      .prepare(
        "SELECT path FROM cluster_summary_members WHERE vault_id = ? AND cluster_key = ? ORDER BY path",
      )
      .all("v1", "k1") as Array<{ path: string }>;
    expect(membersFirst.map((m) => m.path)).toEqual(["A.md", "B.md"]);

    upsertClusterSummary(db, "v1", {
      clusterKey: "k1",
      summary: "second",
      model: "m",
      memberPaths: ["A.md"], // membership shrank
      createdAt: 2,
    });
    const membersSecond = db
      .prepare("SELECT path FROM cluster_summary_members WHERE vault_id = ? AND cluster_key = ?")
      .all("v1", "k1") as Array<{ path: string }>;
    expect(membersSecond.map((m) => m.path)).toEqual(["A.md"]); // replaced, not accumulated

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM cluster_summaries WHERE vault_id = ?").get("v1") as {
        n: number;
      }
    ).n;
    expect(count).toBe(1); // one CURRENT row per cluster_key, not a history table
  });

  it("hasClusterSummaries reflects table presence", () => {
    const db = makeDb();
    expect(hasClusterSummaries(db)).toBe(true);
  });
});

describe("searchClusterSummaries — THE MANDATORY SECURITY DESIGN (mixed-ACL cluster leak)", () => {
  function seedCluster(
    db: Database,
    vaultId: string,
    clusterKey: string,
    memberPaths: string[],
    summary: string,
  ): void {
    upsertClusterSummary(db, vaultId, {
      clusterKey,
      summary,
      model: "m",
      memberPaths,
      embedding: [1, 0, 0, 0],
      embeddingModel: "e",
      createdAt: 1,
    });
  }

  it("a FULLY readable cluster is returned", () => {
    const db = makeDb();
    seedCluster(db, "v1", "k-open", ["A.md", "B.md"], "about apples and oranges");
    const hits = searchClusterSummaries(db, "v1", [1, 0, 0, 0], { k: 10, isReadable: () => true });
    expect(hits.map((h) => h.path)).toEqual(["k-open"]);
  });

  it("(c) SECURITY: a MIXED-ACL cluster (one member denied) is excluded ENTIRELY — not partially redacted", () => {
    const db = makeDb();
    // Cluster spans "open.md" (readable) and "secret.md" (denied). The summary text is DERIVED
    // from both, so surfacing it at all — even the same text — leaks secret.md's contribution.
    seedCluster(db, "v1", "k-mixed", ["open.md", "secret.md"], "a summary derived from both notes");
    const isReadable = (p: string) => p !== "secret.md";
    const hits = searchClusterSummaries(db, "v1", [1, 0, 0, 0], { k: 10, isReadable });
    expect(hits).toEqual([]); // the WHOLE cluster is gone, not redacted-but-present
  });

  it("a FULLY denied cluster is excluded", () => {
    const db = makeDb();
    seedCluster(db, "v1", "k-denied", ["secret1.md", "secret2.md"], "fully secret content");
    const hits = searchClusterSummaries(db, "v1", [1, 0, 0, 0], {
      k: 10,
      isReadable: () => false,
    });
    expect(hits).toEqual([]);
  });

  it("a mix of one open and one mixed-ACL cluster returns ONLY the open one", () => {
    const db = makeDb();
    seedCluster(db, "v1", "k-open", ["open1.md", "open2.md"], "both readable");
    seedCluster(db, "v1", "k-mixed", ["open1.md", "secret.md"], "one denied");
    const isReadable = (p: string) => p !== "secret.md";
    const hits = searchClusterSummaries(db, "v1", [1, 0, 0, 0], { k: 10, isReadable });
    expect(hits.map((h) => h.path)).toEqual(["k-open"]);
  });

  it("fail-closed: a cluster with NO resolvable member rows (corrupted/partial state) is excluded, not fail-open", () => {
    const db = makeDb();
    seedCluster(db, "v1", "k-orphan", ["A.md"], "orphaned summary");
    // Simulate a corrupted write (member rows lost) — the ACL filter must never assume "no
    // members recorded" means "nothing to check", which would be fail-OPEN.
    db.prepare("DELETE FROM cluster_summary_members WHERE vault_id = ? AND cluster_key = ?").run(
      "v1",
      "k-orphan",
    );
    const hits = searchClusterSummaries(db, "v1", [1, 0, 0, 0], { k: 10, isReadable: () => true });
    expect(hits).toEqual([]);
  });

  it("excludes rows with no embedding, and honors isReadable=undefined as allow-all", () => {
    const db = makeDb();
    upsertClusterSummary(db, "v1", {
      clusterKey: "k-unembedded",
      summary: "no vector yet",
      model: "m",
      memberPaths: ["A.md"],
      createdAt: 1,
    });
    seedCluster(db, "v1", "k-open", ["A.md", "B.md"], "embedded and open");
    const hits = searchClusterSummaries(db, "v1", [1, 0, 0, 0], { k: 10 }); // no isReadable
    expect(hits.map((h) => h.path)).toEqual(["k-open"]);
  });
});

describe("buildClusterSummaries (offline cluster-cadence pass)", () => {
  function seedNoteSummaries(
    db: Database,
    vaultId: string,
    notes: Array<[string, string, string]>,
  ): void {
    // [path, contentHash, summaryText]
    for (const [path, hash, summary] of notes) {
      upsertNoteSummary(db, vaultId, {
        path,
        contentHash: hash,
        summary,
        model: "note-model",
        embedding: [1, 0, 0, 0],
        embeddingModel: "e",
        createdAt: 1,
      });
    }
  }

  it("clusters embedded note summaries and writes+embeds a cluster summary per cluster", async () => {
    const db = makeDb();
    seedNoteSummaries(db, "v1", [
      ["A.md", "hA", "About retrieval systems."],
      ["B.md", "hB", "About retrieval engines."],
    ]);
    const gateway = fakeGateway("A summary of retrieval-related notes.");
    const embed = fakeEmbedProvider();
    // k=1 forces both notes into one cluster deterministically.
    const stats = await buildClusterSummaries(db, "v1", gateway, embed, { k: 1 });
    expect(stats.consideredNotes).toBe(2);
    expect(stats.clusters).toBe(1);
    expect(stats.summarized).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.failed).toBe(0);
    expect(gateway.extract).toHaveBeenCalledTimes(1);
    expect(embed.embed).toHaveBeenCalledTimes(1);

    // RAPTOR: the gateway call is over the MEMBER NOTE SUMMARIES, not raw note content.
    const call = (gateway.extract as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const userMsg = call.messages.find((m: { role: string }) => m.role === "user")
      .content as string;
    expect(userMsg).toContain("About retrieval systems.");
    expect(userMsg).toContain("About retrieval engines.");

    const keys = existingClusterKeys(db, "v1");
    expect(keys.size).toBe(1);
  });

  it("is SKIPPED (no gateway call) when the cluster_key is unchanged from a prior pass", async () => {
    const db = makeDb();
    seedNoteSummaries(db, "v1", [
      ["A.md", "hA", "content A"],
      ["B.md", "hB", "content B"],
    ]);
    const gateway = fakeGateway();
    const embed = fakeEmbedProvider();
    const first = await buildClusterSummaries(db, "v1", gateway, embed, { k: 1 });
    expect(first.summarized).toBe(1);
    const second = await buildClusterSummaries(db, "v1", gateway, embed, { k: 1 });
    expect(second.summarized).toBe(0);
    expect(second.skipped).toBe(1);
    expect(gateway.extract).toHaveBeenCalledTimes(1); // NOT called again
  });

  it("RE-summarizes when membership content changes (a different cluster_key)", async () => {
    const db = makeDb();
    seedNoteSummaries(db, "v1", [
      ["A.md", "hA", "content A"],
      ["B.md", "hB", "content B"],
    ]);
    const gateway = fakeGateway();
    const embed = fakeEmbedProvider();
    await buildClusterSummaries(db, "v1", gateway, embed, { k: 1 });
    expect(gateway.extract).toHaveBeenCalledTimes(1);

    // Simulate a member note's summary being regenerated (content_hash moves) — cluster_key must
    // change, so the (now-different) cluster is summarized again rather than skipped.
    upsertNoteSummary(db, "v1", {
      path: "A.md",
      contentHash: "hA2",
      summary: "content A, edited",
      model: "note-model",
      embedding: [1, 0, 0, 0],
      embeddingModel: "e",
      createdAt: 2,
    });
    const second = await buildClusterSummaries(db, "v1", gateway, embed, { k: 1 });
    expect(second.summarized).toBe(1);
    expect(gateway.extract).toHaveBeenCalledTimes(2);
    expect(existingClusterKeys(db, "v1").size).toBe(2); // old key untouched, new key added
  });

  it("batch-embeds cluster summaries via a VARIABLE array (query-encoder.test.ts's invariant)", async () => {
    const db = makeDb();
    seedNoteSummaries(db, "v1", [
      ["A.md", "hA", "a"],
      ["B.md", "hB", "b"],
      ["C.md", "hC", "c"],
      ["D.md", "hD", "d"],
    ]);
    const gateway = fakeGateway();
    const embed = fakeEmbedProvider();
    // k=2 -> up to 2 clusters, both summarized in the SAME phase-2 batch call.
    const stats = await buildClusterSummaries(db, "v1", gateway, embed, { k: 2 });
    expect(stats.summarized).toBeGreaterThan(0);
    // One batched embed call handles every cluster this pass produced — never one call per cluster.
    const embedCalls = (embed.embed as ReturnType<typeof vi.fn>).mock.calls;
    expect(embedCalls.length).toBe(1);
    expect(Array.isArray(embedCalls[0]?.[0])).toBe(true);
  });

  it("counts a gateway failure as failed, without crashing the pass", async () => {
    const db = makeDb();
    seedNoteSummaries(db, "v1", [
      ["A.md", "hA", "a"],
      ["B.md", "hB", "b"],
    ]);
    const gateway = {
      extract: vi.fn(async () => {
        throw new Error("gateway down");
      }),
    } as unknown as GatewayClient;
    const embed = fakeEmbedProvider();
    const stats = await buildClusterSummaries(db, "v1", gateway, embed, { k: 1 });
    expect(stats.summarized).toBe(0);
    expect(stats.failed).toBe(1);
  });

  it("still writes the cluster summary (gating future passes) when the EMBED call fails", async () => {
    const db = makeDb();
    seedNoteSummaries(db, "v1", [
      ["A.md", "hA", "a"],
      ["B.md", "hB", "b"],
    ]);
    const gateway = fakeGateway("a cluster summary");
    const embed = {
      ...fakeEmbedProvider(),
      embed: vi.fn(async () => {
        throw new Error("embed provider down");
      }),
    };
    const stats = await buildClusterSummaries(db, "v1", gateway, embed, { k: 1 });
    expect(stats.summarized).toBe(1);
    expect(existingClusterKeys(db, "v1").size).toBe(1); // gates re-summarization
    // But the row carries no embedding, so it is invisible to the candidate stream.
    const hits = searchClusterSummaries(db, "v1", [1, 0, 0, 0], { k: 10 });
    expect(hits).toEqual([]);
  });

  it("no-ops (zero calls) when there are no embedded note_summaries yet", async () => {
    const db = makeDb();
    const gateway = fakeGateway();
    const embed = fakeEmbedProvider();
    const stats = await buildClusterSummaries(db, "v1", gateway, embed);
    expect(stats).toEqual({
      consideredNotes: 0,
      clusters: 0,
      summarized: 0,
      skipped: 0,
      failed: 0,
    });
    expect(gateway.extract).not.toHaveBeenCalled();
  });
});

describe("maybeBuildClusterSummaries — the flag-off / zero-gateway-calls contract (test a)", () => {
  it("returns null and NEVER constructs a gateway when enabled is false", async () => {
    const db = makeDb();
    upsertNoteSummary(db, "v1", {
      path: "A.md",
      contentHash: "hA",
      summary: "s",
      model: "m",
      embedding: [1, 0, 0, 0],
      embeddingModel: "e",
      createdAt: 1,
    });
    const makeGateway = vi.fn(() => fakeGateway());
    const embed = fakeEmbedProvider();
    const result = await maybeBuildClusterSummaries(
      db,
      "v1",
      { enabled: false },
      makeGateway,
      embed,
    );
    expect(result).toBeNull();
    expect(makeGateway).not.toHaveBeenCalled();
    expect(embed.embed).not.toHaveBeenCalled();
    expect(existingClusterKeys(db, "v1").size).toBe(0);
  });

  it("runs the pass (and does call the gateway) when enabled is true", async () => {
    const db = makeDb();
    upsertNoteSummary(db, "v1", {
      path: "A.md",
      contentHash: "hA",
      summary: "s",
      model: "m",
      embedding: [1, 0, 0, 0],
      embeddingModel: "e",
      createdAt: 1,
    });
    const gateway = fakeGateway();
    const makeGateway = vi.fn(() => gateway);
    const embed = fakeEmbedProvider();
    const result = await maybeBuildClusterSummaries(
      db,
      "v1",
      { enabled: true, k: 1 },
      makeGateway,
      embed,
    );
    expect(result?.summarized).toBe(1);
    expect(makeGateway).toHaveBeenCalledTimes(1);
    expect(gateway.extract).toHaveBeenCalledTimes(1);
  });
});

describe("assembleCandidates — the cluster-summary stream", () => {
  it("(d) an absent/empty clusterSummaryHits leaves candidates byte-identical to omitting the field", () => {
    const db = makeDb();
    const baseInput = {
      db,
      opts: { vaultId: "v1", query: "q", isReadable: () => true } as never,
      seedCount: 10,
      seeds: [],
      expansionChunks: [],
      lexHits: [],
      sparseHits: [],
      onStage: undefined,
    };
    const withoutField = assembleCandidates(baseInput);
    const withEmptyArray = assembleCandidates({ ...baseInput, clusterSummaryHits: [] });
    const withUndefined = assembleCandidates({ ...baseInput, clusterSummaryHits: undefined });
    expect(withoutField.candidates).toEqual([]);
    expect(withEmptyArray.candidates).toEqual([]);
    expect(withUndefined.candidates).toEqual([]);
  });

  it("a pre-filtered clusterSummaryHits flows through as source: cluster_summary candidates", () => {
    const db = makeDb();
    const clusterSummaryHits = [
      {
        chunk_id: clusterSummaryId("v1", "k-open"),
        path: "k-open",
        content: "a summary",
        score: 0.7,
      },
    ];
    const result = assembleCandidates({
      db,
      opts: { vaultId: "v1", query: "q", isReadable: () => true } as never,
      seedCount: 10,
      seeds: [],
      expansionChunks: [],
      lexHits: [],
      sparseHits: [],
      clusterSummaryHits,
      onStage: undefined,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.source).toBe("cluster_summary");
    expect(result.candidates[0]?.chunk_id).toBe(clusterSummaryId("v1", "k-open"));
  });

  it("candidate ids never collide across the chunk / note-summary / cluster-summary id spaces", () => {
    const chunkId = "chk_abc";
    const noteSumId = "sum_abc";
    const clusterSumId = clusterSummaryId("v1", "abc");
    expect(new Set([chunkId, noteSumId, clusterSumId]).size).toBe(3);
  });
});

describe("graphSearch — the DARK guarantee (test a, at the top-level entry point)", () => {
  it("flag off: cluster_summaries is NEVER QUERIED — no SQL statement even mentions the table", async () => {
    const db = makeDb();
    // A populated cluster (so there IS something a leaky code path could wrongly surface) —
    // proves absence-of-query, not merely absence-of-data.
    upsertClusterSummary(db, "v1", {
      clusterKey: "k1",
      summary: "should never be seen",
      model: "m",
      memberPaths: ["A.md"],
      embedding: [1, 0, 0, 0],
      embeddingModel: "e",
      createdAt: 1,
    });
    const seenSql: string[] = [];
    const realPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      seenSql.push(sql);
      return realPrepare(sql);
    }) as typeof db.prepare;

    const { graphSearch } = await import("../src/search/graph_search");
    // opts.summaries is entirely ABSENT — the default-config path, exactly as a caller who never
    // touched retrieval.summaries.clusters would produce.
    const results = await graphSearch(db, {
      query: "q",
      queryVec: [1, 0, 0, 0],
      vaultId: "v1",
      isReadable: () => true,
    });
    expect(results).toEqual([]);
    expect(seenSql.some((sql) => sql.toLowerCase().includes("cluster_summar"))).toBe(false);
  });

  it("flag on: the SAME cluster IS queried (proves the spy above is a real negative, not a dead probe)", async () => {
    const db = makeDb();
    upsertClusterSummary(db, "v1", {
      clusterKey: "k1",
      summary: "should be visible",
      model: "m",
      memberPaths: ["A.md"],
      embedding: [1, 0, 0, 0],
      embeddingModel: "e",
      createdAt: 1,
    });
    const seenSql: string[] = [];
    const realPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      seenSql.push(sql);
      return realPrepare(sql);
    }) as typeof db.prepare;

    const { graphSearch } = await import("../src/search/graph_search");
    const results = await graphSearch(db, {
      query: "q",
      queryVec: [1, 0, 0, 0],
      vaultId: "v1",
      isReadable: () => true,
      summaries: { clusters: { enabled: true } },
    });
    expect(results.some((r) => r.source === "cluster_summary")).toBe(true);
    expect(seenSql.some((sql) => sql.toLowerCase().includes("cluster_summar"))).toBe(true);
  });
});
