// Offline (Modal-batched) embedder arms: the pure rules of eval/embedder-arms-offline.ts. The export
// text, the id and query-key checks, the vector assembly, the log shapes and the score guard are each
// pinned here so a wrong export or a silently reordered vector file cannot reach a score. No network,
// no database: the chunk rows come from a stub that answers the one query exportChunkTexts makes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { armByName } from "../eval/embedder-arms-lib";
import {
  armChunkTexts,
  assembleQueryVecs,
  assertIdsMatch,
  bhFamilyRecord,
  buildArmEmbedLog,
  embedLogBatches,
  indexRerunArgs,
  loadOfflineDocVecs,
  missingPoolsError,
  nextEmbedCommand,
  nextQueryCommand,
  omittedDecisionArms,
  queryEmbedMs,
  queryExportLines,
  queryLatencyRecord,
  queryRerunArgs,
} from "../eval/embedder-arms-offline";
import { gpuVecsModelId } from "../eval/gpu-embed-lib";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { compileEgressFilter } from "../src/plane/egress-filter";
import { enrichChunkText } from "../src/search/chunk";
import { openMemoryDb } from "./helpers";

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

  it("control arm: a run with only the 256 arm still needs bge-m3's pools, and the message names it", () => {
    const msg = missingPoolsError(
      "/exp",
      ["embeddinggemma-2-256"],
      (p) => !p.includes("pools-bge-m3"),
    );
    expect(msg).toMatch(/arm "bge-m3" has no pools file at .*pools-bge-m3\.json/);
  });
});

describe("CLI contract with modal_embed_gemma2.py main()", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../eval/modal_embed_gemma2.py", import.meta.url)),
    "utf8",
  );
  const sig = /def main\(([\s\S]*?)\):/.exec(src)?.[1] ?? "";
  const params = sig
    .split("\n")
    .map((l) => l.trim().replace(/,$/, ""))
    .filter((l) => /^\w+\s*:/.test(l))
    .map((l) => ({
      flag: `${l.split(":")[0]?.trim().replace(/_/g, "-")}`,
      hasDefault: l.includes("="),
    }));
  const printed = [nextEmbedCommand(gemma, EXP), nextQueryCommand(gemma, EXP)];
  const flagsOf = (cmd: string): string[] =>
    [...cmd.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1] as string);

  it("parses a non-empty main() signature (floor: the regex found the function)", () => {
    expect(params.length).toBeGreaterThan(0);
  });

  it("every parameter without a default is passed by each printed command", () => {
    for (const cmd of printed) {
      for (const p of params.filter((x) => !x.hasDefault)) {
        expect(flagsOf(cmd), `${cmd} lacks --${p.flag}`).toContain(p.flag);
      }
    }
  });

  it("every flag a printed command passes is a parameter of main()", () => {
    const known = params.map((p) => p.flag);
    for (const cmd of printed) {
      for (const f of flagsOf(cmd)) expect(known, `${cmd} passes --${f}`).toContain(f);
    }
  });
});

describe("BH family and score guards", () => {
  it("bhFamilyRecord: the decision-bearing arms the correction ran over, m and q", () => {
    expect(bhFamilyRecord(["embeddinggemma-2-768", "nomic-v1.5-768"])).toEqual({
      arms: ["embeddinggemma-2-768", "nomic-v1.5-768"],
      m: 2,
      q: 0.1,
    });
  });

  it("omittedDecisionArms: names each decision-bearing arm with pools that --arms left out", () => {
    expect(omittedDecisionArms(["bge-m3", "gemini-embedding-2-1024"], "/exp", () => true)).toEqual([
      "gemini-embedding-001-1024",
      "nomic-v1.5-768",
      "embeddinggemma-2-768",
    ]);
    expect(
      omittedDecisionArms(["bge-m3"], "/exp", (p) => p.includes("pools-nomic-v1.5-768")),
    ).toEqual(["nomic-v1.5-768"]);
  });

  it("omittedDecisionArms: nothing when every decision arm is named or has no pools file", () => {
    expect(omittedDecisionArms(["nomic-v1.5-768"], "/exp", () => true)).not.toContain(
      "nomic-v1.5-768",
    );
    expect(omittedDecisionArms(["bge-m3"], "/exp", () => false)).toEqual([]);
  });
});

describe("re-run hints", () => {
  it("gemma2: the run's own ids file and its embed log; the query hint names the query ids file", () => {
    expect(indexRerunArgs(gemma, EXP)).toBe(
      `--vecs ${join(EXP, "vecs-768.f32")} --ids ${join(EXP, "vecs-ids.json")} --embed-log ${join(EXP, "embed-log.json")}`,
    );
    expect(queryRerunArgs(gemma, EXP)).toBe(
      `--qvecs ${join(EXP, "qvecs-768.f32")} --qids ${join(EXP, "qvecs-ids.json")}`,
    );
  });

  it("nomic: the export's ids.json, no embed log (its script writes neither)", () => {
    expect(indexRerunArgs(nomic, EXP)).toBe(
      `--vecs ${join(EXP, "vecs-768.f32")} --ids ${join(EXP, "ids.json")}`,
    );
    expect(queryRerunArgs(nomic, EXP)).toBe(
      `--qvecs ${join(EXP, "qvecs-768.f32")} --qids ${join(EXP, "query-ids.json")}`,
    );
  });
});

describe("stale export refused before any load or export rewrite", () => {
  const egress = compileEgressFilter([]);
  const MODEL = "openai:embeddinggemma-2";
  const DIMS = gemma.dims;
  /** n rows of the arm's width; row r holds r + 1 throughout, so a load is visible per row. */
  const rowsOf = (n: number, fill = (r: number) => r + 1): Uint8Array =>
    new Uint8Array(
      new Float32Array(Array.from({ length: n * DIMS }, (_, i) => fill(Math.floor(i / DIMS))))
        .buffer,
    );
  function dbOf(chunks: Array<[string, string]>): any {
    const db = openMemoryDb();
    provisionCacheDb(db);
    chunks.forEach(([id, path]) => {
      db.prepare(
        "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'v1', ?, '0', '[]', 'body', ?, 1, 0, 0)",
      ).run(id, path, `h-${id}`);
    });
    return db;
  }
  const storedFor = (db: any, model: string): string[] =>
    (
      db
        .prepare("SELECT chunk_id FROM chunk_embeddings WHERE model = ? ORDER BY chunk_id")
        .all(model) as Array<{
        chunk_id: string;
      }>
    ).map((r) => r.chunk_id);

  it("a note renamed between the GPU run and the load: same count, new order, refused, nothing written", () => {
    const db = dbOf([
      ["c1", "a.md"],
      ["c2", "b.md"],
    ]);
    const staleIds = armChunkTexts(db, ["v1"], gemma, egress).ids; // c1, c2
    db.prepare("UPDATE chunks SET path = 'z.md' WHERE id = 'c1'").run();
    const fresh = armChunkTexts(db, ["v1"], gemma, egress).ids; // c2, c1
    expect(() =>
      loadOfflineDocVecs(db, {
        arm: gemma,
        model: MODEL,
        fresh,
        givenIds: staleIds,
        vecs: rowsOf(2),
      }),
    ).toThrow(/position 0/);
    expect(storedFor(db, MODEL)).toEqual([]);
  });

  it("a chunk swapped for another, count unchanged: refused at the first differing position", () => {
    const db = dbOf([
      ["c1", "a.md"],
      ["c2", "b.md"],
    ]);
    const staleIds = armChunkTexts(db, ["v1"], gemma, egress).ids;
    db.prepare("DELETE FROM chunks WHERE id = 'c2'").run();
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('c3', 'v1', 'c.md', '0', '[]', 'body', 'h-c3', 1, 0, 0)",
    ).run();
    const fresh = armChunkTexts(db, ["v1"], gemma, egress).ids; // c1, c3
    expect(() =>
      loadOfflineDocVecs(db, {
        arm: gemma,
        model: MODEL,
        fresh,
        givenIds: staleIds,
        vecs: rowsOf(2),
      }),
    ).toThrow(/position 1/);
    expect(storedFor(db, MODEL)).toEqual([]);
  });

  it("the happy path writes each vector under its own chunk id", () => {
    const db = dbOf([
      ["c1", "a.md"],
      ["c2", "b.md"],
    ]);
    const fresh = armChunkTexts(db, ["v1"], gemma, egress).ids;
    const done = loadOfflineDocVecs(db, {
      arm: gemma,
      model: MODEL,
      fresh,
      givenIds: [...fresh],
      vecs: rowsOf(2),
    });
    expect(done).toBe(2);
    const row = db
      .prepare("SELECT embedding FROM chunk_embeddings WHERE chunk_id = ? AND model = ?")
      .get("c2", MODEL) as { embedding: Buffer };
    expect(new Float32Array(new Uint8Array(row.embedding).buffer)[0]).toBe(2);
  });

  it("the load model is the provider's id for the arm's config, which is openai:<model>", () => {
    expect(
      gpuVecsModelId(
        {
          provider: "openai",
          apiKeyEnv: "LITELLM_AGENT_KEY",
          model: gemma.model,
          dimensions: gemma.dims,
          baseUrl: "http://gateway.invalid/v1",
        },
        "/nonexistent/otc-cache",
      ),
    ).toBe(MODEL);
  });

  it("query keys out of the fresh export's order are refused, naming the position", () => {
    expect(() =>
      assembleQueryVecs({
        dims: DIMS,
        exportKeys: ["q1", "q2"],
        qids: ["q1", "q0"],
        vecs: rowsOf(2),
      }),
    ).toThrow(/position 1/);
  });
});

describe("doc vectors: finite, and no stale rows, before the load", () => {
  const MODEL = "openai:embeddinggemma-2";
  const DIMS = gemma.dims;
  const rowsOf = (n: number, fill = (r: number) => r + 1): Uint8Array =>
    new Uint8Array(
      new Float32Array(Array.from({ length: n * DIMS }, (_, i) => fill(Math.floor(i / DIMS))))
        .buffer,
    );
  function dbOf(ids: string[]): any {
    const db = openMemoryDb();
    provisionCacheDb(db);
    for (const id of ids)
      db.prepare(
        "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'v1', ?, '0', '[]', 'body', ?, 1, 0, 0)",
      ).run(id, `${id}.md`, `h-${id}`);
    return db;
  }

  it("a NaN in one row is refused naming the row, and nothing is written", () => {
    const db = dbOf(["c1", "c2"]);
    const vecs = rowsOf(2, (r) => (r === 1 ? Number.NaN : 1));
    expect(() =>
      loadOfflineDocVecs(db, {
        arm: gemma,
        model: MODEL,
        fresh: ["c1", "c2"],
        givenIds: ["c1", "c2"],
        vecs,
      }),
    ).toThrow(/row 1 has a non-finite value/);
    expect(
      db.prepare("SELECT count(*) AS c FROM chunk_embeddings WHERE model = ?").get(MODEL),
    ).toEqual({ c: 0 });
  });

  it("rows the copy holds under the model for chunks outside the export are refused as stale", () => {
    const db = dbOf(["c1", "zz"]);
    db.prepare(
      "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES ('zz', ?, ?, ?, 1, 1)",
    ).run(MODEL, DIMS, Buffer.alloc(DIMS * 4));
    expect(() =>
      loadOfflineDocVecs(db, {
        arm: gemma,
        model: MODEL,
        fresh: ["c1"],
        givenIds: ["c1"],
        vecs: rowsOf(1),
      }),
    ).toThrow(/1 stored row\(s\) under .* not in this export/);
    expect(db.prepare("SELECT chunk_id FROM chunk_embeddings WHERE model = ?").all(MODEL)).toEqual([
      { chunk_id: "zz" },
    ]);
  });
});
