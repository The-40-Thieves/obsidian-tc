// Embedder-arms eval: the rules every arm is measured through (eval/embedder-arms-lib.ts). A wrong
// request shape, a missed normalization, or a free-tier key reaching a private corpus would each move
// or leak something silently, so each rule is pinned here. No network: nothing in this file fetches.
import { describe, expect, it } from "vitest";
import {
  armByName,
  BGE_M3_NEURONS_PER_M_TOKENS,
  backoffMs,
  CONTROL_ARM,
  cosine,
  documentText,
  EMBEDDER_ARMS,
  embedCostUsd,
  geminiBatchBody,
  geminiRequest,
  isDailyQuota,
  l2norm,
  neuronsToUsd,
  pairedAgainstControl,
  parseGeminiEmbeddings,
  privatePhaseDecision,
  queryText,
  recallAtK,
  resolveGeminiKey,
} from "../eval/embedder-arms-lib";
import { GoldenQuerySchema } from "../eval/metrics";

const g2 = armByName("gemini-embedding-2-1024");
const g1 = armByName("gemini-embedding-001-1024");
const bge = armByName(CONTROL_ARM);

describe("arms", () => {
  it("names are unique, the control is bge-m3 at 1024, and exactly the two 1024-wide Gemini arms bear the decision", () => {
    expect(new Set(EMBEDDER_ARMS.map((a) => a.name)).size).toBe(EMBEDDER_ARMS.length);
    expect(bge).toMatchObject({ model: "BAAI/bge-m3", dims: 1024, decisionBearing: false });
    expect(EMBEDDER_ARMS.filter((a) => a.decisionBearing).map((a) => a.name)).toEqual([
      "gemini-embedding-2-1024",
      "gemini-embedding-001-1024",
    ]);
    expect(() => armByName("nope")).toThrow(/unknown arm/);
  });
});

describe("Gemini wire shape", () => {
  it("gemini-embedding-001 sends taskType RETRIEVAL_DOCUMENT for chunks and RETRIEVAL_QUERY for queries", () => {
    expect(geminiRequest(g1, "x", "document")).toMatchObject({
      model: "models/gemini-embedding-001",
      outputDimensionality: 1024,
      taskType: "RETRIEVAL_DOCUMENT",
    });
    expect(geminiRequest(g1, "x", "query")).toMatchObject({ taskType: "RETRIEVAL_QUERY" });
  });

  it("gemini-embedding-2 sends no taskType (its documentation prescribes a text prefix instead)", () => {
    const r = geminiRequest(g2, "x", "document");
    expect(r).not.toHaveProperty("taskType");
    expect(r).toMatchObject({ model: "models/gemini-embedding-2", outputDimensionality: 1024 });
  });

  it("a batch is one request per text, so gemini-embedding-2 cannot aggregate it into one vector", () => {
    const b = geminiBatchBody(g2, ["a", "b", "c"], "document");
    expect(b.requests).toHaveLength(3);
    expect(
      (b.requests as Array<{ content: { parts: Array<{ text: string }> } }>).map(
        (r) => r.content.parts[0]?.text,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("the 3072 ceiling arm requests the native width", () => {
    expect(geminiRequest(armByName("gemini-embedding-2-3072"), "x", "query")).toMatchObject({
      outputDimensionality: 3072,
    });
  });
});

describe("text each arm embeds", () => {
  const chunk = { path: "notes/Evergreen notes.md", headings: ["A", "B"], content: "body" };

  it("bge-m3 and gemini-embedding-001 get the production embed text", () => {
    const expected = "Evergreen notes — A — B\n\nbody";
    expect(documentText(bge, chunk)).toBe(expected);
    expect(documentText(g1, chunk)).toBe(expected);
  });

  it("gemini-embedding-2 gets `title: ... | text: ...` carrying the same title and breadcrumb", () => {
    expect(documentText(g2, chunk)).toBe("title: Evergreen notes | text: A — B\n\nbody");
    expect(documentText(g2, { ...chunk, headings: [] })).toBe(
      "title: Evergreen notes | text: body",
    );
  });

  it("only gemini-embedding-2 rewrites the query", () => {
    expect(queryText(g2, "q")).toBe("task: search result | query: q");
    expect(queryText(g1, "q")).toBe("q");
    expect(queryText(bge, "q")).toBe("q");
  });
});

describe("response validation", () => {
  it("L2-normalizes a truncated gemini-embedding-001 vector (its 1024-wide output is not unit length)", () => {
    const out = parseGeminiEmbeddings({ embeddings: [{ values: [3, 4] }] }, 1, 2);
    expect(l2norm(out[0] as number[])).toBeCloseTo(1, 12);
    expect(out[0]).toEqual([0.6, 0.8]);
  });

  it("rejects a wrong count, a wrong width and a non-finite value", () => {
    expect(() => parseGeminiEmbeddings({ embeddings: [] }, 1, 2)).toThrow(/expected 1/);
    expect(() => parseGeminiEmbeddings({ embeddings: [{ values: [1] }] }, 1, 2)).toThrow(
      /expected 2/,
    );
    expect(() =>
      parseGeminiEmbeddings({ embeddings: [{ values: [1, Number.NaN] }] }, 1, 2),
    ).toThrow(/finite/);
    expect(() => parseGeminiEmbeddings({}, 1, 2)).toThrow(/none/);
  });

  it("cosine of a vector with itself is 1 and of orthogonal vectors 0", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 12);
  });
});

describe("free-tier key must never reach the private corpus", () => {
  const free = "free-tier-key";
  it("public uses GEMINI_API_KEY", () => {
    expect(resolveGeminiKey("public", { GEMINI_API_KEY: free })).toBe(free);
  });

  it("an empty GEMINI_API_KEY (the shell shadows --env-file with one) is an error naming the variable, not a value", () => {
    expect(() => resolveGeminiKey("public", { GEMINI_API_KEY: "" })).toThrow(
      /GEMINI_API_KEY is not set/,
    );
  });

  it("private refuses when no paid key is set, even though the free key is", () => {
    const run = () => resolveGeminiKey("private", { GEMINI_API_KEY: free });
    expect(run).toThrow(/GEMINI_API_KEY_PAID is not set/);
    expect(run).not.toThrow(new RegExp(free));
  });

  it("private refuses a paid-key variable that holds the free key", () => {
    expect(() =>
      resolveGeminiKey("private", { GEMINI_API_KEY: free, GEMINI_API_KEY_PAID: free }),
    ).toThrow(/free-tier key/);
  });

  it("private accepts a distinct paid key", () => {
    expect(resolveGeminiKey("private", { GEMINI_API_KEY: free, GEMINI_API_KEY_PAID: "paid" })).toBe(
      "paid",
    );
  });
});

describe("retry schedule", () => {
  it("honours Retry-After, else doubles from 2 s and caps at 60 s", () => {
    expect(backoffMs(0)).toBe(2_000);
    expect(backoffMs(2)).toBe(8_000);
    expect(backoffMs(9)).toBe(60_000);
    expect(backoffMs(0, 7_000)).toBe(7_000);
    expect(backoffMs(0, 9_999_999)).toBe(120_000);
  });

  it("tells a per-day quota (stop, resume tomorrow) from a per-minute one (wait)", () => {
    expect(
      isDailyQuota("Quota exceeded for metric ... EmbedContentRequestsPerDayPerProjectPerModel"),
    ).toBe(true);
    expect(isDailyQuota("Quota exceeded ... PerMinute")).toBe(false);
  });
});

describe("recall@K", () => {
  const q = GoldenQuerySchema.parse({
    id: "q1",
    query_text: "x",
    seed_domain: "d",
    target_domain: "d",
    seed_paths: [],
    target_paths: ["a\\b.md", "c.md"],
    bridge_paths: [],
    description: "",
  });
  const filler = Array.from({ length: 20 }, (_, i) => `f${i}.md`);

  it("recall@10 misses a note at rank 12 that recall@50 finds", () => {
    const results = [...filler.slice(0, 11), "c.md"];
    expect(recallAtK(q, results, 10)).toBe(0);
    expect(recallAtK(q, results, 50)).toBe(0.5);
  });

  it("counts unique paths, so repeated chunks of one note do not push others past the cutoff", () => {
    const results = ["x.md", "x.md", "x.md", "a/b.md", "c.md"];
    expect(recallAtK(q, results, 3)).toBe(1);
  });

  it("is 0 for a query that declares no expected paths", () => {
    expect(recallAtK({ ...q, target_paths: [] }, ["a.md"], 10)).toBe(0);
  });
});

describe("cost arithmetic", () => {
  it("2.9M tokens at $0.20 and $0.10 per million (gemini-embedding-2 standard and batch)", () => {
    expect(embedCostUsd(2.9e6, { perMTokens: 0.2, source: "" })).toBeCloseTo(0.58, 10);
    expect(embedCostUsd(2.9e6, { perMTokens: 0.1, source: "" })).toBeCloseTo(0.29, 10);
  });

  it("bge-m3 on Workers AI: 1,075 neurons per million tokens at $0.011 per 1,000 neurons", () => {
    expect(neuronsToUsd(BGE_M3_NEURONS_PER_M_TOKENS)).toBeCloseTo(0.011825, 9);
  });
});

describe("private-phase decision (pre-registered)", () => {
  const row = (
    verdict: "WIN" | "TIE" | "LOSS" | "CATASTROPHIC" | "UNDERPOWERED",
    labels: string,
  ) => ({
    labels,
    verdict,
    delta: 0,
    lower95: 0,
  });

  it("YES: a WIN on one label set and a TIE on the other", () => {
    const d = privatePhaseDecision({ a: [row("WIN", "strict"), row("TIE", "lenient")] });
    expect(d.run).toBe(true);
  });

  it("NO: a WIN on one label set is cancelled by a LOSS on the other", () => {
    expect(privatePhaseDecision({ a: [row("WIN", "strict"), row("LOSS", "lenient")] }).run).toBe(
      false,
    );
    expect(
      privatePhaseDecision({ a: [row("WIN", "strict"), row("CATASTROPHIC", "lenient")] }).run,
    ).toBe(false);
  });

  it("NO: ties and underpowered results never justify the spend", () => {
    expect(privatePhaseDecision({ a: [row("TIE", "strict"), row("TIE", "lenient")] }).run).toBe(
      false,
    );
    expect(
      privatePhaseDecision({ a: [row("UNDERPOWERED", "strict"), row("TIE", "lenient")] }).run,
    ).toBe(false);
  });

  it("YES when only one of two arms qualifies", () => {
    const d = privatePhaseDecision({
      a: [row("LOSS", "strict"), row("TIE", "lenient")],
      b: [row("WIN", "strict"), row("WIN", "lenient")],
    });
    expect(d.run).toBe(true);
    expect(d.reason).toContain("b");
  });
});

describe("paired comparison", () => {
  it("refuses arms that cover different query counts", () => {
    expect(() => pairedAgainstControl([1, 2], [1])).toThrow(/different query counts/);
  });

  it("reports the mean delta of arm minus control", () => {
    const s = pairedAgainstControl([0.5, 0.5, 0.5, 0.5], [0.6, 0.6, 0.6, 0.6]);
    expect(s.delta).toBeCloseTo(0.1, 10);
    expect(s.wins).toBe(4);
  });
});
