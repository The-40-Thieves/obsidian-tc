// Offline (Modal-batched) embedder arms: the pure rules of eval/embedder-arms-offline.ts. The export
// text, the id and query-key checks, the vector assembly, the log shapes and the score guard are each
// pinned here so a wrong export or a silently reordered vector file cannot reach a score. No network,
// no database: the chunk rows come from a stub that answers the one query exportChunkTexts makes.
import { describe, expect, it } from "vitest";
import { armByName } from "../eval/embedder-arms-lib";
import {
  armChunkTexts,
  assembleQueryVecs,
  assertIdsMatch,
  buildArmEmbedLog,
  embedLogBatches,
  missingPoolsError,
  nextEmbedCommand,
  nextQueryCommand,
  queryEmbedMs,
  queryExportLines,
  queryLatencyRecord,
} from "../eval/embedder-arms-offline";
import type { Database } from "../src/db/types";
import { compileEgressFilter } from "../src/plane/egress-filter";
import { enrichChunkText } from "../src/search/chunk";

const nomic = armByName("nomic-v1.5-768");
const gemma = armByName("embeddinggemma-2-768");
const EXP = "/exp/arms/x/export";

const f32 = (xs: number[]): Uint8Array => new Uint8Array(new Float32Array(xs).buffer);

/** A db stub answering the single SELECT exportChunkTexts makes. */
const stubDb = (rows: unknown[]): Database =>
  ({ prepare: () => ({ all: () => rows }) }) as unknown as Database;

const row = (id: string, path: string, headings: string[], content: string) => ({
  id,
  path,
  headings: JSON.stringify(headings),
  content,
});

describe("the printed next command", () => {
  it("nomic: modal_embed_nomic.py reads the export's texts and writes vecs-768.f32", () => {
    expect(nextEmbedCommand(nomic, EXP)).toMatch(
      /^modal run eval\/modal_embed_nomic\.py --texts .*texts\.jsonl --out .*vecs-768\.f32$/,
    );
  });

  it("gemma2: one modal_embed_gemma2.py run writes both MRL widths and the embed log", () => {
    expect(nextEmbedCommand(gemma, EXP)).toMatch(
      /modal_embed_gemma2\.py --texts .*texts\.jsonl --out-prefix .*vecs --dims 768,256 --log .*embed-log\.json$/,
    );
  });

  it("queries: nomic maps rows by position, gemma2 writes qvecs under a prefix", () => {
    expect(nextQueryCommand(nomic, EXP)).toMatch(
      /^modal run eval\/modal_embed_nomic\.py --texts .*queries\.jsonl --out .*qvecs-768\.f32$/,
    );
    expect(nextQueryCommand(gemma, EXP)).toMatch(
      /modal_embed_gemma2\.py --queries .*queries\.jsonl --qout-prefix .*qvecs --dims 768,256$/,
    );
  });
});

describe("export text per family (armChunkTexts)", () => {
  const egress = compileEgressFilter(["private/**"]);
  const db = stubDb([
    row("c1", "notes/Alpha.md", ["Intro"], "first body"),
    row("c2", "private/Secret.md", [], "must not leave"),
  ]);

  it("nomic exports the production text with no search_document prefix", () => {
    const out = armChunkTexts(db, ["v1"], nomic, egress);
    expect(out.ids).toEqual(["c1"]);
    expect(JSON.parse(out.lines[0] as string)).toEqual({
      chunk_id: "c1",
      text: enrichChunkText("notes/Alpha.md", ["Intro"], "first body"),
    });
    expect(JSON.parse(out.lines[0] as string).text).not.toMatch(/search_document/);
  });

  it("gemma2 exports the title/text shape, and withholds egress-excluded paths and counts them", () => {
    const out = armChunkTexts(db, ["v1"], gemma, egress);
    expect(JSON.parse(out.lines[0] as string).text).toBe(
      "title: Alpha | text: Intro\n\nfirst body",
    );
    expect(out.lines.join("\n")).not.toContain("must not leave");
    expect(out.excluded).toBe(1);
  });
});

describe("the ids checked against the fresh export", () => {
  it("passes on identical ids in the same order", () => {
    expect(() => assertIdsMatch(["c1", "c2"], ["c1", "c2"])).not.toThrow();
  });

  it("names the count when the lengths differ", () => {
    expect(() => assertIdsMatch(["c1", "c2"], ["c1"])).toThrow(/1 given.*2 in the fresh export/);
  });

  it("names the first differing position and never echoes the id", () => {
    let msg = "";
    try {
      assertIdsMatch(["c1", "c2"], ["c1", "c9"]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/position 1/);
    expect(msg).not.toContain("c9");
    expect(msg).not.toContain("c2");
  });
});

describe("query vectors assembled from the GPU run", () => {
  it("keys the map by raw query, rows in export order", () => {
    expect(
      assembleQueryVecs({
        dims: 2,
        exportKeys: ["a", "b"],
        qids: ["a", "b"],
        vecs: f32([1, 0, 0, 1]),
      }),
    ).toEqual({ a: [1, 0], b: [0, 1] });
  });

  it("refuses keys out of the export's order, naming the position", () => {
    expect(() =>
      assembleQueryVecs({
        dims: 2,
        exportKeys: ["a", "b"],
        qids: ["b", "a"],
        vecs: f32([1, 0, 0, 1]),
      }),
    ).toThrow(/position 0/);
  });

  it("refuses a row count that differs from the key count", () => {
    expect(() =>
      assembleQueryVecs({
        dims: 2,
        exportKeys: ["a", "b"],
        qids: ["a", "b"],
        vecs: f32([1, 0, 0, 1, 1, 1]),
      }),
    ).toThrow(/rows/);
  });

  it("refuses a width that does not divide the buffer", () => {
    expect(() =>
      assembleQueryVecs({
        dims: 3,
        exportKeys: ["a", "b"],
        qids: ["a", "b"],
        vecs: f32([1, 0, 0, 1]),
      }),
    ).toThrow(/width/);
  });

  it("refuses a non-finite value, naming the row", () => {
    expect(() =>
      assembleQueryVecs({
        dims: 2,
        exportKeys: ["a", "b"],
        qids: ["a", "b"],
        vecs: f32([1, Number.NaN, 0, 1]),
      }),
    ).toThrow(/row 0.*finite/);
  });
});

describe("embed log and query latency shapes", () => {
  it("maps the GPU script's shards to batches with zero retries", () => {
    expect(embedLogBatches({ shards: [{ n: 16, chars: 100, ms: 250 }] })).toEqual([
      { n: 16, chars: 100, ms: 250, retries: 0 },
    ]);
  });

  it("no embed log gives no batches; a log without shards is refused", () => {
    expect(embedLogBatches(undefined)).toEqual([]);
    expect(() => embedLogBatches({})).toThrow(/shards/);
  });

  it("the arm embed log has the shape score reads", () => {
    expect(buildArmEmbedLog({ arm: nomic, corpus: "public", chunks: 3, batches: [] })).toEqual({
      arm: "nomic-v1.5-768",
      corpus: "public",
      model: "nomic-embed-text-v1.5",
      dims: 768,
      chunks: 3,
      batches: [],
    });
  });

  it("an offline query has no latency: null percentiles and a note saying why", () => {
    expect(queryLatencyRecord(nomic, "public", 2)).toEqual({
      arm: "nomic-v1.5-768",
      corpus: "public",
      n: 2,
      p50_ms: null,
      p95_ms: null,
      mean_ms: null,
      ms: [],
      note: "batch-embedded off-box; per-query latency not applicable",
    });
  });

  it("score records query_embed_ms as null, not Math.round(null) = 0, when there is no latency", () => {
    expect(queryEmbedMs({ p50_ms: null, p95_ms: null })).toBeNull();
    expect(queryEmbedMs(undefined)).toBeNull();
    expect(queryEmbedMs({ p50_ms: 12.4, p95_ms: 30.6 })).toEqual({ p50: 12, p95: 31 });
  });

  it("writes the query export as {key, text} lines, text through the arm's query side", () => {
    expect(queryExportLines(gemma, ["q"])).toEqual([
      JSON.stringify({ key: "q", text: "task: search result | query: q" }),
    ]);
    expect(queryExportLines(nomic, ["q"])).toEqual([JSON.stringify({ key: "q", text: "q" })]);
  });
});

describe("score refuses an arm with no pools file", () => {
  it("names the arm and the expected path", () => {
    const msg = missingPoolsError(
      "/exp",
      ["embeddinggemma-2-768", "nomic-v1.5-768"],
      (p) => !p.includes("pools-nomic-v1.5-768"),
    );
    expect(msg).toMatch(/arm "nomic-v1\.5-768" has no pools file at .*pools-nomic-v1\.5-768\.json/);
  });

  it("is silent when every named arm has its pools", () => {
    expect(missingPoolsError("/exp", ["nomic-v1.5-768"], () => true)).toBeNull();
  });
});
