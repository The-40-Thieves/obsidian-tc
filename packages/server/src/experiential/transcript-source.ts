// THE-717 step 3 — the TRANSCRIPT SEAM: where the assistant-side text a citation pass needs comes
// from, when it does not come from a file the operator typed out by hand.
//
// `inferCitations` has always taken a `transcript` string and never had a producer. That is the
// whole of what blocked this ticket — "a durable job handler has nothing to pass as transcript".
// This module is the input format that unblocks it, and the deliberate boundary around it.
//
// ── WHY AN INDEX FILE AND NOT AN INTEGRATION ──────────────────────────────────────────────────
//
// On the deployment this was built for, the text is already captured: the MCP CLIENT emits its own
// assistant messages as OpenTelemetry log events, correlated by a prompt id, and they land in a log
// store. Joining that to `chunk_retrievals` was measured working end to end before any of this was
// written (11/11 query groups, 66/66 in-window rows, with negative controls).
//
// None of that belongs in this package. The join is CLIENT-SPECIFIC — it knows one agent's event
// names and attribute keys — and obsidian-tc is a general MCP server that must not learn them, nor
// take a dependency on any particular log store. So the split is:
//
//   here          a plain JSONL contract, parsed and matched by PURE functions
//   out of tree   whatever produces that JSONL for a given client + log store
//
// This is the same shape the gateway already uses: a configurable seam, absent by default, with the
// vendor-specific half living outside. It also means the format is auditable — an operator can read
// the file that is about to be turned into citation verdicts, which is not true of a live query.
//
// ── WHY PASSES, NOT ONE TRANSCRIPT ────────────────────────────────────────────────────────────
//
// `inferCitations` scores every chunk in its scope against ONE transcript. That is correct only if
// the scope is one retrieval. A window spanning several queries has several answers, and feeding
// their concatenation to stage 1 would let any chunk match any answer — attributing a citation
// across queries that never saw each other.
//
// So the seam yields a PLAN: one pass per indexed retrieval, each scoped tightly enough to select
// only that retrieval's rows. The run log added in THE-717 item 2 then records each pass
// separately, which is what makes the result auditable afterwards.
import { z } from "zod";

/**
 * One indexed retrieval: the assistant text that followed it.
 *
 * `transcript` MUST already be filtered to text produced AFTER `retrieved_at`. This module cannot
 * check that and does not try. It matters: measured on real sessions, 3-25% of a prompt's assistant
 * text PRECEDES the retrieval, and scoring a chunk against words written before it entered the
 * context manufactures causation rather than detecting it. The producer owns that filter, and the
 * format documents the obligation.
 */
export const TranscriptIndexEntry = z.object({
  vault: z.string().min(1),
  /** Must equal `chunk_retrievals.surface_type` — it is half the join key. */
  surface_type: z.string().min(1),
  /** Must equal `chunk_retrievals.query_text`. */
  query: z.string(),
  /** Must equal `chunk_retrievals.retrieved_at` (ms epoch). */
  retrieved_at: z.number().int().nonnegative(),
  /** Assistant text produced after the retrieval. Empty is legal and means "answered nothing". */
  transcript: z.string(),
});
export type TranscriptIndexEntry = z.infer<typeof TranscriptIndexEntry>;

/** One citation pass to run: a tight scope plus the transcript that belongs to it. */
export interface CitationPassPlan {
  entry: TranscriptIndexEntry;
  /** Window to scope `inferCitations` to. Narrow by construction — see `planCitationPasses`. */
  window: [number, number];
}

/** A pass NOT planned, and why. Reported rather than silently dropped. */
export interface SkippedEntry {
  entry: TranscriptIndexEntry;
  reason: "ambiguous" | "empty_transcript";
  /** For `ambiguous`: the other entries whose scope would overlap this one. */
  collidesWith: number;
}

export interface CitationPassPlanResult {
  passes: CitationPassPlan[];
  skipped: SkippedEntry[];
  /** Lines that did not parse as an entry, by line number. A malformed index is a producer bug
   *  and must be visible; silently ignoring it would understate coverage forever. */
  malformed: number[];
}

/**
 * How far a pass's window may reach either side of `retrieved_at`.
 *
 * Zero would be exact, and exactness is what we want — every chunk from one retrieval shares one
 * `retrieved_at`, so `[t, t]` selects precisely that retrieval's rows. A small tolerance exists
 * only because an index producer may round. Widening this is not a free knob: the wider it is, the
 * more likely one pass's window swallows a neighbouring retrieval and scores its chunks against
 * the wrong answer.
 */
export const PASS_WINDOW_TOLERANCE_MS = 2;

/** Parse a JSONL transcript index. Malformed lines are COLLECTED, never thrown on or skipped
 *  silently — a producer emitting half-valid output should be visible as exactly that. */
export function parseTranscriptIndex(text: string): {
  entries: TranscriptIndexEntry[];
  malformed: number[];
} {
  const entries: TranscriptIndexEntry[] = [];
  const malformed: number[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      malformed.push(i + 1);
      continue;
    }
    const parsed = TranscriptIndexEntry.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
    else malformed.push(i + 1);
  }
  return { entries, malformed };
}

/**
 * Turn indexed entries into the passes a caller should run.
 *
 * AMBIGUITY IS SKIPPED, NEVER GUESSED. Two entries whose windows overlap cannot both be scoped
 * without one pass stamping the other's rows, and there is no way to tell from the index which
 * answer a shared row belongs to. Both are dropped and reported.
 *
 * That is the same rule the lineage tool applies to episode correlation, and for the same reason:
 * a wrong citation is worse than a missing one, because it is indistinguishable from a real one
 * once written. `[[feedback-failure-encoded-as-a-valid-result]]`.
 *
 * PURE — no DB, no clock, no I/O.
 */
export function planCitationPasses(
  entries: readonly TranscriptIndexEntry[],
  toleranceMs: number = PASS_WINDOW_TOLERANCE_MS,
): CitationPassPlanResult {
  const passes: CitationPassPlan[] = [];
  const skipped: SkippedEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as TranscriptIndexEntry;
    if (e.transcript.trim() === "") {
      // Nothing to score against. Running this would stamp every chunk `rejected` on the strength
      // of an empty string — a verdict, from no evidence.
      skipped.push({ entry: e, reason: "empty_transcript", collidesWith: 0 });
      continue;
    }
    // Collide against every OTHER entry that is not this same retrieval. Same vault + surface +
    // query + timestamp is the same retrieval indexed twice, which is a duplicate rather than a
    // conflict; anything else sharing the window is a genuine ambiguity.
    let collides = 0;
    for (let j = 0; j < entries.length; j++) {
      if (i === j) continue;
      const o = entries[j] as TranscriptIndexEntry;
      const sameRetrieval =
        o.vault === e.vault &&
        o.surface_type === e.surface_type &&
        o.query === e.query &&
        o.retrieved_at === e.retrieved_at;
      if (sameRetrieval) continue;
      if (Math.abs(o.retrieved_at - e.retrieved_at) <= toleranceMs * 2) collides += 1;
    }
    if (collides > 0) {
      skipped.push({ entry: e, reason: "ambiguous", collidesWith: collides });
      continue;
    }
    passes.push({
      entry: e,
      window: [e.retrieved_at - toleranceMs, e.retrieved_at + toleranceMs],
    });
  }
  return { passes, skipped, malformed: [] };
}
