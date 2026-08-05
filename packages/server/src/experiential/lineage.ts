// THE-646 item 2 — the answer-lineage chain, as a PURE function over already-fetched rows.
//
// The chain a caller wants is: this answer used chunk A from note N, retrieved at T for query Q,
// and that retrieval was (or was not) cited in episode E. Every join in it already exists;
// `audit_provenance` covers the access log and `citation.ts` stamps the citation columns. What has
// never existed is a read surface that walks the whole chain and reports it HONESTLY.
//
// "Honestly" is the entire design constraint, and it is why this module exists separately from the
// tool that calls it. Three different absences look identical in a naive join, and conflating any
// two of them produces a confident wrong answer:
//
//   1. NOT STAMPED   — `citation_state IS NULL`: the citation pass never ran over this row.
//                      Measured 2026-08-04: this is 105 of 105 live rows, because inferCitations
//                      has no scheduled caller (THE-717). A lineage that renders this as "not
//                      cited" claims the judge looked and said no. It never looked.
//   2. NOT CITED     — `cited_in_response = 0`: the judge DID look and ruled it out.
//   3. CHUNK GONE    — the retrieval references a chunk_id that no longer resolves, because the
//                      note was edited or deleted and re-chunked since. Measured: 7 of 81 distinct
//                      retrieved chunk_ids. An INNER JOIN silently drops these, which reads as
//                      "this answer used fewer sources than it did".
//
// The same rule governs how a retrieval is tied to an episode. `session_id` became non-NULL for the
// first time on 2026-08-04 (THE-726), but only for rows written since — 8 of 105. So the chain has
// an EXACT key for some rows and only timestamp proximity for the rest, and those two must not be
// reported as the same thing. `[[feedback-failure-encoded-as-a-valid-result]]`.

/** How a retrieval was tied to an episode. Never collapse `time_window` into `session`: one is an
 *  identity, the other is a guess that happens to be usually right. */
export type LineageCorrelation = "session" | "time_window" | "none";

/** Citation verdict as the reader should see it. `not_stamped` is NOT a value in the database —
 *  the column is NULL there — and that is exactly why it is named here: NULL rendered as a blank
 *  cell reads as "no", and "no" is a claim the judge never made. */
export type LineageCitation = "confirmed" | "rejected" | "candidate" | "uncertain" | "not_stamped";

/** Whether the retrieved chunk still resolves to authored content. */
export type LineageChunk = "resolved" | "deleted";

/** One retrieval, with every link in its chain labelled by how well it is known. */
export interface LineageLink {
  chunk_id: string;
  /** Vault-relative path, or null when the chunk no longer resolves. */
  path: string | null;
  chunk: LineageChunk;
  retrieved_at: number;
  surface_type: string;
  query_text: string | null;
  rank_in_results: number | null;
  citation: LineageCitation;
  /** The judge's score when there is one. NULL whenever `citation` is `not_stamped`. */
  citation_score: number | null;
  correlation: LineageCorrelation;
  /** Episode this retrieval is attributed to, when one could be attributed at all. */
  episode_id: string | null;
}

/** A retrieval row as stored, plus whether its chunk still resolves. */
export interface LineageRetrievalRow {
  chunk_id: string;
  path: string | null;
  retrieved_at: number;
  surface_type: string;
  query_text: string | null;
  rank_in_results: number | null;
  session_id: string | null;
  cited_in_response: number | null;
  citation_score: number | null;
  citation_state: string | null;
}

/** An episode row, trimmed to what correlation needs. */
export interface LineageEpisodeRow {
  id: string;
  ts: number;
  session_id: string | null;
}

export interface LineageSummary {
  retrievals: number;
  /** Chunks whose note no longer resolves. Reported, never dropped. */
  deleted_chunks: number;
  /** Rows the citation pass has never touched. Distinct from `not_cited`. */
  not_stamped: number;
  /** Rows the judge ruled out. */
  not_cited: number;
  /** Rows the judge affirmed. */
  cited: number;
  /** Retrievals tied to an episode by session identity rather than by clock proximity. */
  exact_correlations: number;
}

export interface AnswerLineage {
  links: LineageLink[];
  summary: LineageSummary;
  /** Present when nothing in the chain is judge-backed, so a caller cannot read the absence of
   *  citations as evidence about the answer. Null when at least one row is stamped. */
  caveat: string | null;
}

/** Default window for timestamp correlation. Chosen from the measured distribution: every one of
 *  the 17 distinct retrieval calls on the live store resolved to a same-tool episode within
 *  0 to 46 ms. 5s is two orders of magnitude of headroom and still far below the gap between
 *  distinct user actions. Widening it does not make the guess better, only less falsifiable. */
export const CORRELATION_WINDOW_MS = 5_000;

function citationOf(row: LineageRetrievalRow): LineageCitation {
  // citation_state is the THE-170 vocabulary and is authoritative when present. Fall back to the
  // older boolean only when the state column is NULL but the boolean is not, which is how rows
  // stamped before migration 20260731_001 look.
  const s = row.citation_state;
  if (s === "confirmed" || s === "rejected" || s === "candidate" || s === "uncertain") return s;
  if (row.cited_in_response === 1) return "candidate";
  if (row.cited_in_response === 0) return "rejected";
  return "not_stamped";
}

/**
 * Build the lineage for one set of retrievals.
 *
 * PURE: no DB, no clock, no I/O. Every input is passed in, so this is testable against a fixture
 * without a live search — the same contract `estimateCoverage` holds, and for the same reason.
 *
 * Episodes are matched by session identity first and by nearest timestamp within `windowMs`
 * second, and the result records WHICH of the two happened. A retrieval that matches neither is
 * reported with `correlation: "none"` and a null episode rather than being omitted.
 */
export function buildAnswerLineage(
  retrievals: readonly LineageRetrievalRow[],
  episodes: readonly LineageEpisodeRow[],
  windowMs: number = CORRELATION_WINDOW_MS,
): AnswerLineage {
  const bySession = new Map<string, LineageEpisodeRow[]>();
  for (const ep of episodes) {
    if (ep.session_id === null) continue;
    const list = bySession.get(ep.session_id);
    if (list) list.push(ep);
    else bySession.set(ep.session_id, [ep]);
  }

  const links: LineageLink[] = retrievals.map((r) => {
    let correlation: LineageCorrelation = "none";
    let episode_id: string | null = null;

    // 1. Exact: same session. Among several, take the nearest in time — the session is the
    //    identity, the timestamp only orders within it.
    const sessionMatches = r.session_id === null ? undefined : bySession.get(r.session_id);
    if (sessionMatches && sessionMatches.length > 0) {
      let best = sessionMatches[0] as LineageEpisodeRow;
      for (const ep of sessionMatches) {
        if (Math.abs(ep.ts - r.retrieved_at) < Math.abs(best.ts - r.retrieved_at)) best = ep;
      }
      correlation = "session";
      episode_id = best.id;
    } else {
      // 2. Heuristic: nearest episode inside the window, over ALL episodes. Labelled as a guess.
      let best: LineageEpisodeRow | null = null;
      let bestGap = Number.POSITIVE_INFINITY;
      for (const ep of episodes) {
        const gap = Math.abs(ep.ts - r.retrieved_at);
        if (gap <= windowMs && gap < bestGap) {
          best = ep;
          bestGap = gap;
        }
      }
      if (best) {
        correlation = "time_window";
        episode_id = best.id;
      }
    }

    const citation = citationOf(r);
    return {
      chunk_id: r.chunk_id,
      path: r.path,
      // A chunk with no resolvable path is reported as deleted, never dropped: an inner join here
      // would understate how many sources an answer actually drew on.
      chunk: r.path === null ? "deleted" : "resolved",
      retrieved_at: r.retrieved_at,
      surface_type: r.surface_type,
      query_text: r.query_text,
      rank_in_results: r.rank_in_results,
      citation,
      // Score is meaningless without a verdict, so it is nulled rather than shown as 0.
      citation_score: citation === "not_stamped" ? null : r.citation_score,
      correlation,
      episode_id,
    };
  });

  const summary: LineageSummary = {
    retrievals: links.length,
    deleted_chunks: links.filter((l) => l.chunk === "deleted").length,
    not_stamped: links.filter((l) => l.citation === "not_stamped").length,
    not_cited: links.filter((l) => l.citation === "rejected").length,
    cited: links.filter((l) => l.citation === "confirmed").length,
    exact_correlations: links.filter((l) => l.correlation === "session").length,
  };

  // The caveat exists because the honest reading of this surface TODAY is "we do not know".
  // Without it a caller sees a lineage with zero citations and concludes the answer used nothing,
  // which is the precise false negative this ticket was filed to prevent.
  const caveat =
    links.length > 0 && summary.not_stamped === links.length
      ? "No retrieval in this chain has been judged: the citation pass has not run over these rows " +
        "(THE-717). Absence of citations here is absence of EVIDENCE, not evidence the sources went " +
        "unused."
      : null;

  return { links, summary, caveat };
}
