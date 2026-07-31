// The shared evidence builder: retrieval hits in, a numbered, deduplicated, budgeted evidence set
// out. One place decides WHAT the model is shown and HOW it is labelled.
//
// Before this module, two surfaces each rendered evidence their own way and neither deduplicated,
// quota'd or budgeted anything:
//
//   * tools/m7/knowledge/reflect.ts (synthesis) — `results.slice(0, 20)` and
//     `content.slice(0, 800)`, numbered inline as `[${i + 1}]`.
//   * plane/challenge.ts (`renderEvidence`) — no item cap at all, `EVIDENCE_TRUNCATE = 1800`,
//     numbered as `[${idx}]`.
//
// Same job, same `[n]` citation convention, and a 2.25x difference in how much of a chunk the model
// actually sees. Neither could dedupe a chunk that retrieval returned twice, and neither could stop
// one large note from consuming the whole context — so "here is the evidence" quietly meant
// something different depending on which tool the caller reached.
//
// SCOPE — mechanics, deliberately not policy. This module owns dedup, per-note quotas, budget,
// boundary-aware trimming, stable numbering and the coverage flags. It does NOT reorder candidates,
// prefer one edge kind over another, or balance supporting against conflicting evidence: those
// change WHICH evidence is selected, which is retrieval policy, and this repo gates retrieval policy
// on the golden set rather than on a refactor (see retrieval.schema.ts, where 13 of 15 flags are
// dark). Rank order in equals rank order out.
//
// NOT in scope either: tools/m7/knowledge/vault-context.ts. It already packs to a real token budget
// via packBudget and groups by note; it is the one surface that was doing this properly, and
// rewriting a correct packer is how a refactor introduces a regression.

/** One retrieval hit offered as evidence. Structurally a superset of plane/challenge.ts's
 *  `EvidenceChunk`, so a built item can be handed straight to `challengeProposal`. */
export interface EvidenceSource {
  path: string;
  content: string;
  /** Retrieval provenance. Used for dedup when present — two hits with the same chunk id are the
   *  same chunk no matter what else differs. */
  chunkId?: string | undefined;
  headings?: string[] | null | undefined;
  tags?: string[] | null | undefined;
}

export interface EvidenceItem {
  /** 1-based citation number, assigned AFTER dedup and budgeting so it always matches the item's
   *  position in the rendered set. Numbering before dropping is how `[7]` ends up referring to
   *  nothing. */
  citation: number;
  path: string;
  content: string;
  chunkId?: string | undefined;
  headings?: string[] | null | undefined;
  tags?: string[] | null | undefined;
  /** True when `content` was trimmed — so a caller can say "excerpt" rather than implying the
   *  model saw the whole note. */
  truncated: boolean;
}

/** Why candidates did not make it in. Every drop is counted rather than silently discarded: a
 *  builder that returns 3 items from 40 candidates and says nothing looks identical to one that
 *  was handed 3 candidates. */
export interface EvidenceStats {
  candidates: number;
  droppedDuplicate: number;
  droppedPerNoteQuota: number;
  droppedItemCap: number;
  droppedCharBudget: number;
  totalChars: number;
}

export interface EvidenceSet {
  items: EvidenceItem[];
  stats: EvidenceStats;
  /** Nothing survived. Distinct from low coverage: this is "answer from nothing", which a caller
   *  should usually refuse to do rather than let a model improvise. */
  missingEvidence: boolean;
  /** Something was dropped for budget/quota reasons, or fewer than `lowCoverageBelow` items
   *  survived. The answer may be based on a partial view. */
  lowCoverage: boolean;
}

export interface EvidenceBudget {
  /** Hard cap on items. */
  maxItems: number;
  /** Per-item character cap before trimming. */
  maxCharsPerItem: number;
  /** Optional cap across the whole set. Omitted -> only the per-item cap applies. */
  maxTotalChars?: number | undefined;
  /** At most this many items from any single note path. Omitted -> unlimited. One note that
   *  chunked into 30 pieces should not become the entire context. */
  maxPerNote?: number | undefined;
  /** Fewer than this many surviving items flags lowCoverage. Omitted -> only drops flag it. */
  lowCoverageBelow?: number | undefined;
}

/**
 * Trim to at most `limit` characters, preferring a section boundary.
 *
 * A hard `slice(0, n)` cuts mid-sentence and often mid-word, which reads to a model as though the
 * source itself is malformed. Prefer the last blank line (a section/paragraph break) in the tail of
 * the allowance, then the last single newline, and only cut hard when neither exists — a minified
 * or single-line note has no boundary to find and must still be trimmed.
 *
 * The search is confined to the last 25% of the allowance so a boundary near the very start can
 * never collapse a long chunk to a few characters. Returns the input untouched when it fits.
 */
export function trimToBoundary(content: string, limit: number): string {
  if (limit <= 0) return "";
  if (content.length <= limit) return content;
  const head = content.slice(0, limit);
  const floor = Math.floor(limit * 0.75);
  const para = head.lastIndexOf("\n\n");
  if (para >= floor) return head.slice(0, para).trimEnd();
  const line = head.lastIndexOf("\n");
  if (line >= floor) return head.slice(0, line).trimEnd();
  return head.trimEnd();
}

/** Dedup key. Chunk id when retrieval supplied one; otherwise path + content, so the same body
 *  reachable under two paths (a copy, or an alias) counts once. Length-prefixed so
 *  `{path:"a", content:"bc"}` and `{path:"ab", content:"c"}` cannot collide — the same rule
 *  hash.ts applies to cache keys, for the same reason. */
function dedupKey(s: EvidenceSource): string {
  if (s.chunkId !== undefined && s.chunkId !== "") return `c:${s.chunkId.length}:${s.chunkId}`;
  return `p:${s.path.length}:${s.path}:${s.content.length}:${s.content}`;
}

/**
 * Build the evidence set. Input order is treated as rank order and preserved.
 *
 * Numbering happens LAST, after every drop. That ordering is load-bearing: numbering candidates
 * first leaves `[7]` referring to an item the model was never shown.
 *
 * The three filters (quota, item cap, budget-stop) are each a `continue`, so an item is kept iff it
 * passes all of them and the KEPT SET is independent of the order they run in — a reordering does
 * not change the output. What the order does change is which counter is credited when a candidate
 * fails more than one at once; quota is checked first so an over-quota chunk reads as
 * `droppedPerNoteQuota` (a note-shape fact the caller can act on) rather than as
 * `droppedItemCap` (a budget fact it cannot). `attributes an over-quota drop to the quota` in the
 * tests pins exactly that, and is the only assertion here a reordering breaks.
 */
export function buildEvidence(
  sources: readonly EvidenceSource[],
  budget: EvidenceBudget,
): EvidenceSet {
  const stats: EvidenceStats = {
    candidates: sources.length,
    droppedDuplicate: 0,
    droppedPerNoteQuota: 0,
    droppedItemCap: 0,
    droppedCharBudget: 0,
    totalChars: 0,
  };

  const seen = new Set<string>();
  const perNote = new Map<string, number>();
  const items: EvidenceItem[] = [];

  for (let i = 0; i < sources.length; i++) {
    // Index-based rather than for-of: the budget stop below needs "how many candidates remain",
    // and `sources.indexOf(s)` would answer with the FIRST occurrence of a repeated object
    // reference, inflating the shortfall it reports.
    const s = sources[i] as EvidenceSource;
    const key = dedupKey(s);
    if (seen.has(key)) {
      stats.droppedDuplicate++;
      continue;
    }

    if (budget.maxPerNote !== undefined) {
      const used = perNote.get(s.path) ?? 0;
      if (used >= budget.maxPerNote) {
        stats.droppedPerNoteQuota++;
        continue;
      }
    }

    if (items.length >= budget.maxItems) {
      stats.droppedItemCap++;
      continue;
    }

    const trimmed = trimToBoundary(s.content, budget.maxCharsPerItem);
    if (
      budget.maxTotalChars !== undefined &&
      stats.totalChars + trimmed.length > budget.maxTotalChars
    ) {
      // Budget is a stop, not a skip: once it is reached, a later shorter chunk squeezing in would
      // make the set depend on chunk sizes rather than on rank. Every remaining candidate —
      // including this one — is counted as budget-dropped so the caller sees the true shortfall.
      stats.droppedCharBudget += sources.length - i;
      break;
    }

    // Mark seen/quota only once the item is actually kept, so a candidate rejected by a cap does
    // not suppress an identical later one that would have fit.
    seen.add(key);
    perNote.set(s.path, (perNote.get(s.path) ?? 0) + 1);
    stats.totalChars += trimmed.length;
    items.push({
      citation: items.length + 1,
      path: s.path,
      content: trimmed,
      ...(s.chunkId !== undefined ? { chunkId: s.chunkId } : {}),
      ...(s.headings !== undefined ? { headings: s.headings } : {}),
      ...(s.tags !== undefined ? { tags: s.tags } : {}),
      truncated: trimmed.length < s.content.length,
    });
  }

  const dropped =
    stats.droppedDuplicate +
    stats.droppedPerNoteQuota +
    stats.droppedItemCap +
    stats.droppedCharBudget;

  return {
    items,
    stats,
    missingEvidence: items.length === 0,
    lowCoverage:
      items.length === 0 ||
      stats.droppedPerNoteQuota + stats.droppedItemCap + stats.droppedCharBudget > 0 ||
      (budget.lowCoverageBelow !== undefined && items.length < budget.lowCoverageBelow) ||
      // A set built entirely from duplicates saw less distinct material than its candidate count
      // suggests; that is a coverage fact, not a bookkeeping one.
      (dropped > 0 && items.length < budget.maxItems && stats.droppedDuplicate > items.length),
  };
}

/** Render one item in the `[n] path / headings / tags / content` shape both former call sites
 *  used, so the text handed to a model is identical in structure regardless of which tool built
 *  it. Kept separate from `buildEvidence` because the challenge path renders into its own prompt
 *  envelope and the synthesis path into another. */
export function renderEvidenceItem(item: EvidenceItem): string {
  const headings = (item.headings ?? []).join(" > ");
  const tags = (item.tags ?? []).join(", ");
  return (
    `[${item.citation}] path: ${item.path}` +
    (headings ? `\nheadings: ${headings}` : "") +
    (tags ? `\ntags: ${tags}` : "") +
    `\ncontent: ${item.content}${item.truncated ? "\n...[truncated]" : ""}`
  );
}
