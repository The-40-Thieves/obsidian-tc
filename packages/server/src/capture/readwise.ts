// THE-650 — Readwise adapter for the source-agnostic highlight-import format
// (highlight-import.ts). Readwise Reader is the live canonical read-later source as of this
// ticket (Omnivore's API and data shut down Nov 2024; Readwise Reader also aggregates
// Instapaper/Matter/others), so it is the first — and so far only — producer of
// `CanonicalHighlightSource`.
//
// ENDPOINT, VERIFIED against readwise.io/api_deets (2026-08): highlights come from the classic
// v2 EXPORT endpoint, `GET https://readwise.io/api/v2/export/` — NOT a `/api/v3/highlights/`
// endpoint, which does not exist. Auth is `Authorization: Token <token>` (not Bearer). The
// response nests book -> highlights: `{ count, nextPageCursor, results: [{ user_book_id, title,
// author, source, highlights: [{ id, text, note, location, highlighted_at, ... }] }] }`.
// Pagination is a `pageCursor` returned in the response, re-sent as a query param; `updatedAfter`
// (ISO 8601) scopes to highlights updated since a prior sync. Both documented usage:
// "first sync all of a user's historical data by passing no parameters ... then use pageCursor
// until there are no pages left. Later ... pass updatedAfter as the time you last pulled data."
import type { CanonicalHighlight, CanonicalHighlightSource } from "./highlight-import";

const EXPORT_URL = "https://readwise.io/api/v2/export/";

interface ReadwiseExportHighlight {
  id: number;
  is_deleted: boolean;
  text: string;
  location: number | null;
  location_type: string | null;
  note: string | null;
  highlighted_at: string | null;
}

interface ReadwiseExportBook {
  user_book_id: number;
  is_deleted: boolean;
  title: string;
  author: string | null;
  source: string | null;
  unique_url: string | null;
  highlights: ReadwiseExportHighlight[];
}

interface ReadwiseExportResponse {
  count: number;
  nextPageCursor: string | null;
  results: ReadwiseExportBook[];
}

export interface FetchReadwiseHighlightsOptions {
  /** ISO 8601. Only highlights updated after this instant are returned. */
  updatedAfter?: string;
  /** Injectable transport; defaults to the global fetch. Tests pass a fixture-backed fake. */
  fetchFn?: typeof fetch;
}

export class ReadwiseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function mapBook(book: ReadwiseExportBook): CanonicalHighlightSource {
  const highlights: CanonicalHighlight[] = book.highlights
    .filter((h) => !h.is_deleted)
    .map((h) => ({
      text: h.text,
      ...(h.note ? { note: h.note } : {}),
      ...(h.location !== null ? { location: h.location } : {}),
      ...(h.highlighted_at ? { highlighted_at: h.highlighted_at } : {}),
    }));
  return {
    source: "readwise",
    source_id: String(book.user_book_id),
    title: book.title,
    ...(book.author ? { author: book.author } : {}),
    ...(book.unique_url ? { url: book.unique_url } : {}),
    highlights,
    ...(book.source ? { tags: [`readwise-source:${book.source}`] } : {}),
  };
}

/**
 * Page through Readwise's v2 export endpoint and return every non-deleted book/highlight as the
 * canonical shape. Deleted books/highlights (`is_deleted`) are dropped entirely — this is a
 * one-way import into a staging queue, not a sync that needs to propagate a remote delete.
 */
export async function fetchReadwiseHighlights(
  token: string,
  opts: FetchReadwiseHighlightsOptions = {},
): Promise<CanonicalHighlightSource[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const items: CanonicalHighlightSource[] = [];
  let pageCursor: string | undefined;
  for (;;) {
    const url = new URL(EXPORT_URL);
    if (opts.updatedAfter) url.searchParams.set("updatedAfter", opts.updatedAfter);
    if (pageCursor) url.searchParams.set("pageCursor", pageCursor);

    const res = await fetchFn(url.toString(), {
      method: "GET",
      headers: { Authorization: `Token ${token}` },
    });
    if (!res.ok) {
      throw new ReadwiseApiError(
        `Readwise export request failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    const body = (await res.json()) as ReadwiseExportResponse;
    for (const book of body.results) {
      if (book.is_deleted) continue;
      const item = mapBook(book);
      if (item.highlights.length > 0) items.push(item);
    }
    if (!body.nextPageCursor) break;
    pageCursor = body.nextPageCursor;
  }
  return items;
}
