// THE-650 — source-agnostic highlight-import format: the canonical shape every read-later
// adapter (Readwise first; see capture/readwise.ts) maps into before landing in capture_queue via
// `enqueueCapture`. Deliberately independent of any one source's field names — a future
// Instapaper/Matter adapter (Readwise already aggregates both under its own `source` field) is
// expected to produce this SAME shape, not a new one.
//
// INGESTION PATH: an imported highlight is STAGED content, not a vault write — the same "no path
// from untrusted input to the vault without a human" contract every capture_queue producer gets
// (queue.ts's header, THE-855's poison scan runs on it exactly like any other enqueue). This
// module is a thin wrapper over `enqueueCapture` with `source: "import"`, plus the one thing this
// format needs that a generic capture producer does not: a re-sync must not re-enqueue a
// highlight it already staged. capture_queue carries no unique constraint to lean on (THE-855 kept
// the schema append-only and minimal), so the dedup key travels as a `tags` entry —
// `import-dedupe:<hash>` — checked against every existing `source: "import"` row (pending AND
// committed, via queue.ts's `listCaptureTags`) before enqueueing. `commit_capture`/human review is
// still the only path to the vault; this only keeps the QUEUE itself from filling with repeats.
import type { Database } from "../db/types";
import { argsHash } from "../hash";
import { enqueueCapture, listCaptureTags } from "./queue";

/** One highlight within a `CanonicalHighlightSource` item. Source-agnostic: no field here may
 *  assume a particular provider's vocabulary — every adapter normalizes into this one shape. */
export interface CanonicalHighlight {
  text: string;
  note?: string;
  /** Position within the source document (page/offset/order); provider-specific meaning, opaque
   *  here. */
  location?: number;
  /** ISO 8601. Absent when the source does not record one. */
  highlighted_at?: string;
}

/** One book/article/document and its highlights, already mapped from a source's native shape. */
export interface CanonicalHighlightSource {
  /** Adapter identity, e.g. "readwise". A free string — a new adapter needs no registry entry. */
  source: string;
  /** Stable id WITHIN `source` for this document (Readwise: `user_book_id`). Never reused across
   *  documents for the same source. */
  source_id: string;
  title: string;
  author?: string;
  url?: string;
  highlights: CanonicalHighlight[];
  tags?: string[];
}

// Exported so tools/m5/capture-tools.ts can filter it out of human/vault-facing surfaces
// (commitFrontmatter, list_capture_queue) — a machine dedupe hash has no business landing in a
// committed note's frontmatter tags or in front of a reviewer. `listCaptureTags` above still reads
// the RAW tags column directly from SQL for the dedup check itself, so filtering it out of the
// tools layer's rendering never affects this module's own dedup lookup.
export const IMPORT_DEDUPE_TAG_PREFIX = "import-dedupe:";

/**
 * Deterministic per-highlight identity. Combines (source, source_id, highlighted_at) — the tuple
 * THE-650 names — with the highlight's own text and location, so two genuinely distinct
 * highlights landing in the same document at the same instant (no `highlighted_at` granularity
 * below a second) do not collide. Independent of array order.
 */
export function highlightDedupeKey(
  item: Pick<CanonicalHighlightSource, "source" | "source_id">,
  h: CanonicalHighlight,
): string {
  // Reuses hash.ts's argsHash (sha256 of canonicalJson, 16-byte hex) rather than hand-rolling the
  // same derivation a second time. Its `toolName` parameter is just a namespace prefix baked into
  // the hash input — "highlight-import" here, not a claim this is a dispatched tool call.
  return argsHash("highlight-import", {
    source: item.source,
    source_id: item.source_id,
    text: h.text,
    location: h.location ?? null,
    highlighted_at: h.highlighted_at ?? null,
  });
}

function formatCaptureContent(item: CanonicalHighlightSource, h: CanonicalHighlight): string {
  const parts = [h.text];
  if (h.note) parts.push(`> ${h.note}`);
  const attribution = item.author ? `${item.author} — ${item.title}` : item.title;
  parts.push(item.url ? `${attribution} (${item.url})` : attribution);
  return parts.join("\n\n");
}

export interface IngestHighlightsResult {
  enqueued: number;
  skipped_duplicate: number;
}

/**
 * Stage every highlight in `items` into `vaultId`'s capture_queue (`source: "import"`), skipping
 * any whose dedupe key already exists on a prior "import" row. Nothing here writes to the vault —
 * `commit_capture` is still the human gate `enqueueCapture` always has.
 */
export function ingestHighlights(
  db: Database,
  vaultId: string,
  items: readonly CanonicalHighlightSource[],
  now: number,
  opts: { dryRun?: boolean } = {},
): IngestHighlightsResult {
  const seen = new Set<string>();
  for (const tags of listCaptureTags(db, vaultId, "import")) {
    for (const t of tags) {
      if (t.startsWith(IMPORT_DEDUPE_TAG_PREFIX))
        seen.add(t.slice(IMPORT_DEDUPE_TAG_PREFIX.length));
    }
  }

  let enqueued = 0;
  let skipped_duplicate = 0;
  for (const item of items) {
    for (const h of item.highlights) {
      const key = highlightDedupeKey(item, h);
      if (seen.has(key)) {
        skipped_duplicate++;
        continue;
      }
      if (!opts.dryRun) {
        enqueueCapture(db, {
          vaultId,
          content: formatCaptureContent(item, h),
          title: item.title,
          tags: ["import", item.source, ...(item.tags ?? []), `${IMPORT_DEDUPE_TAG_PREFIX}${key}`],
          source: "import",
          now,
        });
      }
      // Marked seen even in dry-run so two highlights sharing an identity WITHIN this one batch
      // (a malformed export re-listing the same highlight) are counted as one enqueue + one
      // duplicate, matching what a real run would do — not double-counted as two enqueues.
      seen.add(key);
      enqueued++;
    }
  }
  return { enqueued, skipped_duplicate };
}
