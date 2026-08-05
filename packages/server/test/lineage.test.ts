// THE-646 item 2 — the answer-lineage chain. Pins the three absences that a naive join collapses
// into one, because collapsing any of them produces a confident wrong answer rather than a gap.
import { describe, expect, it } from "vitest";
import {
  buildAnswerLineage,
  CORRELATION_WINDOW_MS,
  type LineageEpisodeRow,
  type LineageRetrievalRow,
} from "../src/experiential/lineage";
import { ExplainAnswerOutput } from "../src/tools/m7/knowledge/schemas";

const T = 1_700_000_000_000;

const retrieval = (over: Partial<LineageRetrievalRow> = {}): LineageRetrievalRow => ({
  chunk_id: "c1",
  path: "notes/a.md",
  retrieved_at: T,
  surface_type: "vault_graph_search",
  query_text: "q",
  rank_in_results: 1,
  session_id: null,
  cited_in_response: null,
  citation_score: null,
  citation_state: null,
  ...over,
});

const episode = (over: Partial<LineageEpisodeRow> = {}): LineageEpisodeRow => ({
  id: "e1",
  ts: T,
  session_id: null,
  ...over,
});

describe("THE-646: answer lineage renders absences honestly", () => {
  it("NOT STAMPED is distinct from NOT CITED — the whole point of the ticket", () => {
    // NULL citation_state means the pass never looked. cited_in_response = 0 means it looked and
    // said no. Rendering the first as the second claims a verdict that was never reached.
    const l = buildAnswerLineage(
      [
        retrieval({ chunk_id: "never" }),
        retrieval({ chunk_id: "judged-no", citation_state: "rejected", citation_score: 0.1 }),
      ],
      [],
    );
    expect(l.links[0]?.citation).toBe("not_stamped");
    expect(l.links[1]?.citation).toBe("rejected");
    expect(l.summary.not_stamped).toBe(1);
    expect(l.summary.not_cited).toBe(1);
  });

  it("a not_stamped row carries NO score — an invented number reads as a verdict", () => {
    const l = buildAnswerLineage([retrieval({ citation_score: 0.9 })], []);
    expect(l.links[0]?.citation).toBe("not_stamped");
    expect(l.links[0]?.citation_score).toBeNull();
  });

  it("a DELETED chunk is reported, never dropped", () => {
    // An inner join would omit it, which reads as "this answer used fewer sources than it did".
    // Measured on the live store: 7 of 81 distinct retrieved chunk_ids no longer resolve.
    const l = buildAnswerLineage(
      [retrieval({ chunk_id: "gone", path: null }), retrieval({ chunk_id: "here" })],
      [],
    );
    expect(l.links).toHaveLength(2);
    expect(l.links.find((x) => x.chunk_id === "gone")?.chunk).toBe("deleted");
    expect(l.summary.deleted_chunks).toBe(1);
  });

  it("SESSION correlation is not the same claim as TIME_WINDOW correlation", () => {
    const l = buildAnswerLineage(
      [
        retrieval({ chunk_id: "exact", session_id: "s1" }),
        retrieval({ chunk_id: "guess", retrieved_at: T + 10 }),
      ],
      [episode({ id: "eS", session_id: "s1", ts: T + 4_000 }), episode({ id: "eT", ts: T + 20 })],
    );
    const exact = l.links.find((x) => x.chunk_id === "exact");
    const guess = l.links.find((x) => x.chunk_id === "guess");
    expect(exact?.correlation).toBe("session");
    expect(exact?.episode_id).toBe("eS"); // session wins even though eT is nearer in time
    expect(guess?.correlation).toBe("time_window");
    expect(guess?.episode_id).toBe("eT");
    expect(l.summary.exact_correlations).toBe(1);
  });

  it("a retrieval outside the window correlates to NOTHING rather than to the nearest episode", () => {
    const l = buildAnswerLineage(
      [retrieval({ retrieved_at: T })],
      [episode({ ts: T + CORRELATION_WINDOW_MS + 1 })],
    );
    expect(l.links[0]?.correlation).toBe("none");
    expect(l.links[0]?.episode_id).toBeNull();
  });

  it("emits a CAVEAT when nothing in the chain is judge-backed", () => {
    // This is the live state today: citations are 0/105 because inferCitations has no scheduled
    // caller. Without the caveat a caller reads zero citations as "the sources went unused".
    const l = buildAnswerLineage([retrieval(), retrieval({ chunk_id: "c2" })], []);
    expect(l.caveat).toContain("absence of EVIDENCE");
    expect(l.summary.not_stamped).toBe(2);
  });

  it("suppresses the caveat as soon as ONE row is judged", () => {
    const l = buildAnswerLineage(
      [
        retrieval(),
        retrieval({ chunk_id: "c2", citation_state: "confirmed", citation_score: 0.8 }),
      ],
      [],
    );
    expect(l.caveat).toBeNull();
    expect(l.summary.cited).toBe(1);
  });

  it("falls back to the pre-20260731_001 boolean when citation_state is absent", () => {
    // Rows stamped before the citation_state migration carry only the boolean. Reading them as
    // not_stamped would erase real verdicts.
    const l = buildAnswerLineage(
      [
        retrieval({ chunk_id: "old-yes", cited_in_response: 1 }),
        retrieval({ chunk_id: "old-no", cited_in_response: 0 }),
      ],
      [],
    );
    expect(l.links.find((x) => x.chunk_id === "old-yes")?.citation).toBe("candidate");
    expect(l.links.find((x) => x.chunk_id === "old-no")?.citation).toBe("rejected");
    expect(l.caveat).toBeNull();
  });

  it("is pure: an empty chain produces an empty lineage and no caveat", () => {
    const l = buildAnswerLineage([], []);
    expect(l.links).toHaveLength(0);
    expect(l.caveat).toBeNull();
    expect(l.summary.retrievals).toBe(0);
  });

  it("what buildAnswerLineage returns actually satisfies the tool's declared outputSchema", () => {
    // `ExplainAnswerOutput` is a z.union (the available:false envelope), and a union is opaque to
    // `topLevelShape` — so m7-tool-metadata-parity.test.ts records this tool's outputKeys as `[]`
    // and cannot guard the payload shape the way it does for every flat-object tool there. This
    // is that guard.
    //
    // A bare safeParse would only catch drift in ONE direction. Zod objects are non-strict, so a
    // field added to LineageLink with no matching schema entry is silently STRIPPED and the parse
    // still succeeds — the field would just never reach a caller. So the key sets are compared
    // after parsing, which catches that direction too.
    const lineage = buildAnswerLineage(
      [
        retrieval({ chunk_id: "gone", path: null, session_id: "s1" }),
        retrieval({ chunk_id: "kept", citation_state: "confirmed", citation_score: 0.8 }),
      ],
      [episode({ session_id: "s1" })],
    );
    const parsed = ExplainAnswerOutput.safeParse({
      available: true,
      vault: "main",
      scope: "session",
      ...lineage,
    });
    expect(parsed.success).toBe(true);
    // Narrowed on the `available` discriminant rather than cast: the union is a discriminated one,
    // so this is the shape the caller genuinely sees.
    if (!parsed.success || parsed.data.available !== true)
      throw new Error("expected the open branch");
    const ok = parsed.data;
    expect(Object.keys(ok.links[0] as object).sort()).toEqual(
      Object.keys(lineage.links[0] as object).sort(),
    );
    expect(Object.keys(ok.summary).sort()).toEqual(Object.keys(lineage.summary).sort());
    // And the closed branch, which is what a caller sees when the store is not open.
    expect(ExplainAnswerOutput.safeParse({ available: false, message: "closed" }).success).toBe(
      true,
    );
  });
});
