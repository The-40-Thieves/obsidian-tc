// THE-717 step 3 — the transcript seam. What matters here is not that valid input parses, but that
// every ambiguous or empty case is REFUSED and reported rather than guessed at, because a wrong
// citation is indistinguishable from a real one once it is written.
import { describe, expect, it } from "vitest";
import {
  PASS_WINDOW_TOLERANCE_MS,
  parseTranscriptIndex,
  planCitationPasses,
  type TranscriptIndexEntry,
} from "../src/experiential/transcript-source";

const T = 1_700_000_000_000;

const entry = (over: Partial<TranscriptIndexEntry> = {}): TranscriptIndexEntry => ({
  vault: "main",
  surface_type: "vault_graph_search",
  query: "hub degree cap",
  retrieved_at: T,
  transcript: "the answer text that followed",
  ...over,
});

describe("THE-717: parsing a transcript index", () => {
  it("collects malformed lines rather than throwing or silently dropping them", () => {
    // A producer emitting half-valid output must be visible as exactly that. Silently skipping
    // would understate coverage forever and look like "the client just never answered".
    const text = [
      JSON.stringify(entry()),
      "{not json",
      JSON.stringify({ vault: "main" }), // valid JSON, invalid entry
      "",
      JSON.stringify(entry({ retrieved_at: T + 10_000 })),
    ].join("\n");
    const r = parseTranscriptIndex(text);
    expect(r.entries).toHaveLength(2);
    expect(r.malformed).toEqual([2, 3]);
  });

  it("accepts an empty transcript as a value — it means 'answered nothing', not 'no data'", () => {
    const r = parseTranscriptIndex(JSON.stringify(entry({ transcript: "" })));
    expect(r.entries).toHaveLength(1);
    expect(r.malformed).toEqual([]);
  });

  it("rejects a negative or non-integer timestamp", () => {
    const bad = [
      JSON.stringify(entry({ retrieved_at: -1 })),
      JSON.stringify(entry({ retrieved_at: 1.5 })),
    ].join("\n");
    expect(parseTranscriptIndex(bad).entries).toHaveLength(0);
    expect(parseTranscriptIndex(bad).malformed).toEqual([1, 2]);
  });
});

describe("THE-717: planning passes refuses to guess", () => {
  it("scopes each pass TIGHTLY around its own retrieval", () => {
    // Every chunk from one retrieval shares one retrieved_at, so a near-exact window selects that
    // retrieval and nothing else. A wide window would swallow a neighbour and score its chunks
    // against the wrong answer.
    const p = planCitationPasses([entry()]);
    expect(p.passes).toHaveLength(1);
    expect(p.passes[0]?.window).toEqual([
      T - PASS_WINDOW_TOLERANCE_MS,
      T + PASS_WINDOW_TOLERANCE_MS,
    ]);
  });

  it("SKIPS both entries when two different retrievals share a window", () => {
    // There is no way to tell from the index which answer a shared row belongs to. Running either
    // pass would stamp the other's rows. Both are dropped and reported.
    const p = planCitationPasses([
      entry(),
      entry({ query: "a different query", retrieved_at: T + 1 }),
    ]);
    expect(p.passes).toHaveLength(0);
    expect(p.skipped).toHaveLength(2);
    expect(p.skipped.every((s) => s.reason === "ambiguous")).toBe(true);
    expect(p.skipped[0]?.collidesWith).toBe(1);
  });

  it("does NOT treat the same retrieval indexed twice as an ambiguity", () => {
    // A duplicate line is a producer being sloppy, not two competing answers. Both plan, and the
    // second pass is a no-op because inferCitations only stamps rows still NULL.
    const p = planCitationPasses([entry(), entry()]);
    expect(p.skipped).toHaveLength(0);
    expect(p.passes).toHaveLength(2);
  });

  it("two retrievals ONE SECOND apart are separate passes — pins the tolerance's consequence", () => {
    // Deliberately a LITERAL, not PASS_WINDOW_TOLERANCE_MS. The window test above compares against
    // the constant, so it moves with it and cannot catch a widening — the same self-referential
    // trap as a "was it clean?" flag that reads its own output. This one fails if the tolerance
    // grows past ~500ms, which is the point at which one pass starts swallowing its neighbour.
    const p = planCitationPasses([entry(), entry({ query: "other", retrieved_at: T + 1000 })]);
    expect(p.passes).toHaveLength(2);
    expect(p.skipped).toHaveLength(0);
  });

  it("the shipped tolerance is small in ABSOLUTE terms", () => {
    // It exists only to absorb a producer rounding a millisecond. Widening it is not a free knob:
    // the wider it is, the more likely a pass scores a neighbouring retrieval's chunks against the
    // wrong answer, and that error is unrecoverable once stamped.
    expect(PASS_WINDOW_TOLERANCE_MS).toBeLessThanOrEqual(10);
  });

  it("separates retrievals that are far enough apart", () => {
    const p = planCitationPasses([entry(), entry({ query: "other", retrieved_at: T + 60_000 })]);
    expect(p.passes).toHaveLength(2);
    expect(p.skipped).toHaveLength(0);
  });

  it("SKIPS an empty transcript instead of stamping every chunk rejected", () => {
    // Scoring against "" makes every chunk fail stage 1 and stamp `rejected` — a verdict, from no
    // evidence. That is the exact failure the citation vocabulary exists to prevent.
    const p = planCitationPasses([entry({ transcript: "   " })]);
    expect(p.passes).toHaveLength(0);
    expect(p.skipped[0]?.reason).toBe("empty_transcript");
  });

  it("is pure: an empty index plans nothing and reports nothing", () => {
    const p = planCitationPasses([]);
    expect(p).toEqual({ passes: [], skipped: [], malformed: [] });
  });
});
