// THE-628 (first PR) — the note-level summary tier: store/search (search/note-summaries.ts) and
// the index-time summarizer (search/indexing/summarize-notes.ts). Covers the ticket's required
// tests: (a) flag-off makes ZERO gateway calls, (b) a leaf summary is written+embedded and skipped
// when content_hash is unchanged, (c) the SECURITY assertion — an unreadable note's summary never
// surfaces as a candidate, (d) the dark candidate stream doesn't change results when the flag is
// off, (e) covered separately by migrations-manifest.test.ts + migration-impact (no hand-built
// chain touches note_summaries, per `just migration-impact`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import type { GatewayClient } from "../src/gateway/client";
import { compileEgressFilter, EgressViolationError } from "../src/plane/egress-filter";
import { assembleCandidates } from "../src/search/graph_search_stages/candidate_assembly";
import { maybeSummarizeVault, summarizeNotes } from "../src/search/indexing/summarize-notes";
import {
  existingSummaryHash,
  NOTE_SUMMARY_SCAN_CEILING,
  noteSummaryId,
  noteSummaryScanCount,
  searchNoteSummaries,
  upsertNoteSummary,
} from "../src/search/note-summaries";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const CACHE_CHAIN = CACHE_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) }));

function makeDb(): Database {
  const d = openMemoryDb();
  runMigrations(d as unknown as Database, CACHE_CHAIN);
  return d as unknown as Database;
}

function insertNote(db: Database, vaultId: string, path: string, hash: string): void {
  db.prepare(
    "INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(vaultId, path, path, "[]", null, hash, 0, 0, 0);
}

function insertChunk(db: Database, vaultId: string, path: string, content: string): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(`chk_${vaultId}_${path}`, vaultId, path, "0", "[]", content, `h_${content}`, 10, 0, 0);
}

const fakeGateway = (text = "A short summary."): GatewayClient =>
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

describe("note-summaries store", () => {
  it("noteSummaryId is stable, and distinct from a chunk id prefix", () => {
    const id1 = noteSummaryId("v1", "A.md");
    const id2 = noteSummaryId("v1", "A.md");
    expect(id1).toBe(id2);
    expect(id1.startsWith("sum_")).toBe(true);
    expect(id1).not.toBe(noteSummaryId("v1", "B.md"));
  });

  it("upsert + existingSummaryHash round-trip, and a re-upsert replaces rather than accumulates", () => {
    const db = makeDb();
    upsertNoteSummary(db, "v1", {
      path: "A.md",
      contentHash: "h1",
      summary: "first",
      model: "m",
      createdAt: 1,
    });
    expect(existingSummaryHash(db, "v1", "A.md")).toBe("h1");
    upsertNoteSummary(db, "v1", {
      path: "A.md",
      contentHash: "h2",
      summary: "second",
      model: "m",
      createdAt: 2,
    });
    expect(existingSummaryHash(db, "v1", "A.md")).toBe("h2");
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM note_summaries WHERE vault_id = ?").get("v1") as {
        n: number;
      }
    ).n;
    expect(count).toBe(1); // one CURRENT row per note, not a history table
  });

  it("searchNoteSummaries excludes rows with no embedding and honors isReadable", () => {
    const db = makeDb();
    upsertNoteSummary(db, "v1", {
      path: "readable.md",
      contentHash: "h1",
      summary: "about apples",
      model: "m",
      embedding: [1, 0, 0, 0],
      embeddingModel: "e",
      createdAt: 1,
    });
    upsertNoteSummary(db, "v1", {
      path: "denied.md",
      contentHash: "h2",
      summary: "about oranges",
      model: "m",
      embedding: [1, 0, 0, 0],
      embeddingModel: "e",
      createdAt: 1,
    });
    upsertNoteSummary(db, "v1", {
      path: "unembedded.md",
      contentHash: "h3",
      summary: "no vector yet",
      model: "m",
      createdAt: 1,
    });
    const hits = searchNoteSummaries(db, "v1", [1, 0, 0, 0], {
      k: 10,
      isReadable: (p) => p !== "denied.md",
    });
    expect(hits.map((h) => h.path)).toEqual(["readable.md"]); // denied + unembedded both excluded
  });

  // THE-891 item 5 — the doctor probe's cheap read: exactly the rows searchNoteSummaries would
  // actually scan (embedded only), scoped by vault.
  it("noteSummaryScanCount counts only embedded rows, scoped by vault", () => {
    const db = makeDb();
    upsertNoteSummary(db, "v1", {
      path: "embedded.md",
      contentHash: "h1",
      summary: "s",
      model: "m",
      embedding: [1, 0, 0, 0],
      embeddingModel: "e",
      createdAt: 1,
    });
    upsertNoteSummary(db, "v1", {
      path: "unembedded.md",
      contentHash: "h2",
      summary: "s",
      model: "m",
      createdAt: 1,
    });
    upsertNoteSummary(db, "other-vault", {
      path: "embedded.md",
      contentHash: "h3",
      summary: "s",
      model: "m",
      embedding: [1, 0, 0, 0],
      embeddingModel: "e",
      createdAt: 1,
    });
    expect(noteSummaryScanCount(db, "v1")).toBe(1);
    expect(noteSummaryScanCount(db, "other-vault")).toBe(1);
    expect(noteSummaryScanCount(db, "no-such-vault")).toBe(0);
  });

  it("noteSummaryScanCount is 0 on a store that predates the note_summaries migration", () => {
    const bare = openMemoryDb();
    expect(noteSummaryScanCount(bare as unknown as Database, "v1")).toBe(0);
  });

  it("NOTE_SUMMARY_SCAN_CEILING is a positive, sane bound (sanity, not a behavior pin)", () => {
    // Not a magic-number pin — the derivation lives in the module header. This guards against a
    // future edit silently making the constant 0, negative, or non-numeric.
    expect(Number.isFinite(NOTE_SUMMARY_SCAN_CEILING)).toBe(true);
    expect(NOTE_SUMMARY_SCAN_CEILING).toBeGreaterThan(0);
  });
});

describe("summarizeNotes (index-time pass)", () => {
  it("writes + embeds a summary for a note, keyed on content_hash", async () => {
    const db = makeDb();
    insertNote(db, "v1", "A.md", "hashA");
    insertChunk(db, "v1", "A.md", "This note is about retrieval systems.");
    const gateway = fakeGateway("Retrieval systems summary.");
    const embed = fakeEmbedProvider();
    const stats = await summarizeNotes(db, "v1", gateway, embed);
    expect(stats).toEqual({ considered: 1, summarized: 1, skipped: 0, failed: 0 });
    expect(gateway.extract).toHaveBeenCalledTimes(1);
    expect(embed.embed).toHaveBeenCalledTimes(1);
    expect(existingSummaryHash(db, "v1", "A.md")).toBe("hashA");
  });

  it("egress.excludePaths: an excluded note never reaches gateway.extract; the report counts it skipped (THE-934 fix round 2, N1)", async () => {
    const db = makeDb();
    insertNote(db, "v1", "Public/A.md", "hashA");
    insertChunk(db, "v1", "Public/A.md", "public content about retrieval systems.");
    insertNote(db, "v1", "Private/B.md", "hashB");
    insertChunk(db, "v1", "Private/B.md", "SECRET_MARKER content that must never egress.");
    const gateway = fakeGateway("A summary.");
    const embed = fakeEmbedProvider();
    const stats = await summarizeNotes(db, "v1", gateway, embed, {
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    expect(stats).toEqual({ considered: 2, summarized: 1, skipped: 1, failed: 0 });
    expect(gateway.extract).toHaveBeenCalledTimes(1);
    const call = (gateway.extract as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const userMsg = call.messages.find((m: { role: string }) => m.role === "user")
      .content as string;
    expect(userMsg).not.toContain("SECRET_MARKER");
    expect(userMsg).toContain("public content");
    expect(existingSummaryHash(db, "v1", "Public/A.md")).toBe("hashA");
    expect(existingSummaryHash(db, "v1", "Private/B.md")).toBeNull(); // never written
  });

  // THE-934 fix round 4 (2): "never written" was only half the requirement. Skipping an excluded
  // note leaves an EXISTING row in place for ever -- and this pass can run with no reconcile
  // before it (the `obsidian-tc index` summarize phase, a cluster build), so it cannot delegate
  // the cleanup to index-vault.ts. A row is model-generated text derived from the note; while it
  // exists it is searchable through searchNoteSummaries and feeds buildClusterSummaries.
  it("egress.excludePaths: a summarize pass DELETES an excluded note's existing summary row, with no reconcile in front of it (THE-934 fix round 4, 2)", async () => {
    const db = makeDb();
    insertNote(db, "v1", "Private/B.md", "hashB");
    insertChunk(db, "v1", "Private/B.md", "SECRET_MARKER content that must never egress.");
    // A row written before the folder was excluded (or by a pre-THE-934 build).
    upsertNoteSummary(db, "v1", {
      path: "Private/B.md",
      contentHash: "hashB",
      summary: "a stale summary of a now-excluded note",
      model: "m",
      embedding: [0.5, 0.5, 0.5, 0.5],
      embeddingModel: "e",
      createdAt: 1,
    });
    expect(existingSummaryHash(db, "v1", "Private/B.md")).toBe("hashB");

    const gateway = fakeGateway("A summary.");
    const embed = fakeEmbedProvider();
    await summarizeNotes(db, "v1", gateway, embed, {
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    expect(existingSummaryHash(db, "v1", "Private/B.md")).toBeNull();
    expect(gateway.extract).not.toHaveBeenCalled(); // and it was never re-summarized to get there
  });

  it("control: a summarize pass leaves a NON-excluded note's existing row alone (the cleanup narrows, it does not blind)", async () => {
    const db = makeDb();
    insertNote(db, "v1", "Public/A.md", "hashA");
    insertChunk(db, "v1", "Public/A.md", "public content.");
    upsertNoteSummary(db, "v1", {
      path: "Public/A.md",
      contentHash: "hashA",
      summary: "a perfectly good summary",
      model: "m",
      embedding: [0.5, 0.5, 0.5, 0.5],
      embeddingModel: "e",
      createdAt: 1,
    });
    const gateway = fakeGateway("A summary.");
    await summarizeNotes(db, "v1", gateway, fakeEmbedProvider(), {
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    expect(existingSummaryHash(db, "v1", "Public/A.md")).toBe("hashA");
    expect(gateway.extract).not.toHaveBeenCalled(); // content_hash unchanged: still a skip
  });

  it("is SKIPPED (no gateway call) when content_hash is unchanged from a prior pass", async () => {
    const db = makeDb();
    insertNote(db, "v1", "A.md", "hashA");
    insertChunk(db, "v1", "A.md", "Unchanged content.");
    const gateway = fakeGateway();
    const embed = fakeEmbedProvider();
    const first = await summarizeNotes(db, "v1", gateway, embed);
    expect(first.summarized).toBe(1);
    const second = await summarizeNotes(db, "v1", gateway, embed);
    expect(second).toEqual({ considered: 1, summarized: 0, skipped: 1, failed: 0 });
    expect(gateway.extract).toHaveBeenCalledTimes(1); // NOT called again on the second pass
  });

  it("re-summarizes when content_hash CHANGES (the note was edited)", async () => {
    const db = makeDb();
    insertNote(db, "v1", "A.md", "hashA");
    insertChunk(db, "v1", "A.md", "Version one.");
    const gateway = fakeGateway();
    const embed = fakeEmbedProvider();
    await summarizeNotes(db, "v1", gateway, embed);
    expect(gateway.extract).toHaveBeenCalledTimes(1);

    // Simulate an edit: the note row's content_hash moves, and its chunk content changes.
    db.prepare("UPDATE notes SET content_hash = ? WHERE vault_id = ? AND path = ?").run(
      "hashA2",
      "v1",
      "A.md",
    );
    db.prepare("DELETE FROM chunks WHERE vault_id = ? AND path = ?").run("v1", "A.md");
    insertChunk(db, "v1", "A.md", "Version two, edited.");

    const second = await summarizeNotes(db, "v1", gateway, embed);
    expect(second.summarized).toBe(1);
    expect(gateway.extract).toHaveBeenCalledTimes(2);
    expect(existingSummaryHash(db, "v1", "A.md")).toBe("hashA2");
  });

  it("does not call the gateway for a note with no chunk content (e.g. fully secret-gated)", async () => {
    const db = makeDb();
    insertNote(db, "v1", "Empty.md", "hashE");
    // No chunks row for this path.
    const gateway = fakeGateway();
    const embed = fakeEmbedProvider();
    const stats = await summarizeNotes(db, "v1", gateway, embed);
    expect(stats).toEqual({ considered: 1, summarized: 0, skipped: 1, failed: 0 });
    expect(gateway.extract).not.toHaveBeenCalled();
  });

  it("counts a gateway failure as failed, without crashing the pass", async () => {
    const db = makeDb();
    insertNote(db, "v1", "A.md", "hashA");
    insertChunk(db, "v1", "A.md", "content");
    const gateway = {
      extract: vi.fn(async () => {
        throw new Error("gateway down");
      }),
    } as unknown as GatewayClient;
    const embed = fakeEmbedProvider();
    const stats = await summarizeNotes(db, "v1", gateway, embed);
    expect(stats).toEqual({ considered: 1, summarized: 0, skipped: 0, failed: 1 });
  });

  it("still writes the summary (gating future passes) when the EMBED call fails", async () => {
    const db = makeDb();
    insertNote(db, "v1", "A.md", "hashA");
    insertChunk(db, "v1", "A.md", "content");
    const gateway = fakeGateway("a summary");
    const embed = {
      ...fakeEmbedProvider(),
      embed: vi.fn(async () => {
        throw new Error("embed provider down");
      }),
    };
    const stats = await summarizeNotes(db, "v1", gateway, embed);
    expect(stats.summarized).toBe(1);
    expect(existingSummaryHash(db, "v1", "A.md")).toBe("hashA"); // gates re-summarization
    // But the row carries no embedding, so it is invisible to the candidate stream.
    const hits = searchNoteSummaries(db, "v1", [1, 0, 0, 0], { k: 10 });
    expect(hits).toEqual([]);
  });

  it("THE-934 fix round 3 (B): an EgressViolationError from gateway.extract PROPAGATES, distinct from an ordinary gateway failure counted as `failed`", async () => {
    const db = makeDb();
    insertNote(db, "v1", "A.md", "hashA");
    insertChunk(db, "v1", "A.md", "content");
    const gateway = {
      extract: vi.fn(async () => {
        throw new EgressViolationError("guard fired");
      }),
    } as unknown as GatewayClient;
    const embed = fakeEmbedProvider();
    await expect(summarizeNotes(db, "v1", gateway, embed)).rejects.toBeInstanceOf(
      EgressViolationError,
    );
  });

  it("THE-934 fix round 3 (B): an EgressViolationError from embed.embed PROPAGATES, distinct from an ordinary embed failure that still writes the summary", async () => {
    const db = makeDb();
    insertNote(db, "v1", "A.md", "hashA");
    insertChunk(db, "v1", "A.md", "content");
    const gateway = fakeGateway("a summary");
    const embed = {
      ...fakeEmbedProvider(),
      embed: vi.fn(async () => {
        throw new EgressViolationError("guard fired");
      }),
    };
    await expect(summarizeNotes(db, "v1", gateway, embed)).rejects.toBeInstanceOf(
      EgressViolationError,
    );
  });
});

describe("maybeSummarizeVault — the flag-off / zero-gateway-calls contract (test a)", () => {
  it("returns null and NEVER constructs a gateway when enabled is false", async () => {
    const db = makeDb();
    insertNote(db, "v1", "A.md", "hashA");
    insertChunk(db, "v1", "A.md", "content");
    const makeGateway = vi.fn(() => fakeGateway());
    const embed = fakeEmbedProvider();
    const result = await maybeSummarizeVault(db, "v1", { enabled: false }, makeGateway, embed);
    expect(result).toBeNull();
    expect(makeGateway).not.toHaveBeenCalled(); // the gateway FACTORY itself is never invoked
    expect(embed.embed).not.toHaveBeenCalled();
    expect(existingSummaryHash(db, "v1", "A.md")).toBeNull(); // no row written either
  });

  it("runs the pass (and does call the gateway) when enabled is true", async () => {
    const db = makeDb();
    insertNote(db, "v1", "A.md", "hashA");
    insertChunk(db, "v1", "A.md", "content");
    const gateway = fakeGateway();
    const makeGateway = vi.fn(() => gateway);
    const embed = fakeEmbedProvider();
    const result = await maybeSummarizeVault(db, "v1", { enabled: true }, makeGateway, embed);
    expect(result?.summarized).toBe(1);
    expect(makeGateway).toHaveBeenCalledTimes(1);
    expect(gateway.extract).toHaveBeenCalledTimes(1);
  });
});

describe("assembleCandidates — the summary stream (tests c, d)", () => {
  it("(d) an absent/empty summaryHits leaves candidates byte-identical to omitting the field", () => {
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
    const withEmptyArray = assembleCandidates({ ...baseInput, summaryHits: [] });
    const withUndefined = assembleCandidates({ ...baseInput, summaryHits: undefined });
    expect(withoutField.candidates).toEqual([]);
    expect(withEmptyArray.candidates).toEqual([]);
    expect(withUndefined.candidates).toEqual([]);
  });

  it("(c) SECURITY: a caller denied note N never sees N's summary as a candidate", () => {
    const db = makeDb();
    const isReadable = (path: string) => path !== "secret.md";
    const summaryHits = [
      {
        chunk_id: noteSummaryId("v1", "secret.md"),
        path: "secret.md",
        content: "denied",
        score: 0.9,
      },
      { chunk_id: noteSummaryId("v1", "open.md"), path: "open.md", content: "allowed", score: 0.5 },
    ];
    const result = assembleCandidates({
      db,
      opts: { vaultId: "v1", query: "q", isReadable } as never,
      seedCount: 10,
      seeds: [],
      expansionChunks: [],
      lexHits: [],
      sparseHits: [],
      summaryHits,
      onStage: undefined,
    });
    expect(result.candidates.map((c) => c.path)).toEqual(["open.md"]);
    expect(result.candidates.every((c) => c.path !== "secret.md")).toBe(true);
    expect(result.candidates[0]?.source).toBe("summary");
  });
});

// THE-934 fix round 4 (2) — the query-time backstop searchClusterSummaries got in fix round 3.
// The write path now deletes an excluded note's summary row at three sites, so a row here under an
// excluded path is one that PREDATES the exclusion -- the case that must not leak. A note summary
// does carry a real vault path, so a downstream isExcludedPath check could in principle catch it,
// but only the reranker performs one and only when a reranker is configured; on a default install
// the summary would reach the fused result set and reflect unchecked.
describe("searchNoteSummaries — egress.excludePaths (THE-934 fix round 4, 2)", () => {
  function seedTwo(db: Database): void {
    for (const [path, summary] of [
      ["Public/a.md", "a public summary"],
      ["Private/secret.md", "SECRET_MARKER a private summary"],
    ] as const) {
      upsertNoteSummary(db, "v1", {
        path,
        contentHash: `h_${path}`,
        summary,
        model: "m",
        embedding: [1, 0, 0, 0],
        embeddingModel: "e",
        createdAt: 1,
      });
    }
  }

  it("never returns a row under an excluded path, and never scores one", () => {
    const db = makeDb();
    seedTwo(db);
    const hits = searchNoteSummaries(db, "v1", [1, 0, 0, 0], {
      k: 10,
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    expect(hits.map((h) => h.path)).toEqual(["Public/a.md"]);
    expect(hits.some((h) => h.content.includes("SECRET_MARKER"))).toBe(false);
  });

  it("control: with no filter configured, BOTH rows surface — the filter narrows, it does not blind", () => {
    const db = makeDb();
    seedTwo(db);
    const hits = searchNoteSummaries(db, "v1", [1, 0, 0, 0], { k: 10 });
    expect(hits.map((h) => h.path).sort()).toEqual(["Private/secret.md", "Public/a.md"]);
  });

  it("holds through the REAL graphSearch wiring, not only when called directly", async () => {
    const db = makeDb();
    seedTwo(db);
    const { graphSearch } = await import("../src/search/graph_search");
    const excludedId = noteSummaryId("v1", "Private/secret.md");
    const filtered = await graphSearch(db, {
      query: "q",
      queryVec: [1, 0, 0, 0],
      vaultId: "v1",
      isReadable: () => true,
      summaries: { enabled: true },
      rerankExcludeFilter: compileEgressFilter(["Private/**"]),
    });
    expect(filtered.some((r) => r.chunk_id === excludedId)).toBe(false);
    expect(filtered.some((r) => r.content?.includes("SECRET_MARKER"))).toBe(false);

    // Control through the same wiring: with no filter the summary IS a candidate, so the assertion
    // above is the filter working rather than an empty query.
    const unfiltered = await graphSearch(db, {
      query: "q",
      queryVec: [1, 0, 0, 0],
      vaultId: "v1",
      isReadable: () => true,
      summaries: { enabled: true },
    });
    expect(unfiltered.some((r) => r.chunk_id === excludedId)).toBe(true);
  });
});
