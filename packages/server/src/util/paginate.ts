// THE-516: the one offset-cursor pagination helper. It existed twice, byte-identical, in
// tools/m2/search-tools.ts and tools/m4/tasks-tools.ts — two copies of the same cursor encoding,
// the same default page size, and the same next_cursor contract, free to drift apart. Consolidating
// makes the response shape a single fact; paginate-single-implementation.test.ts keeps it that way.
//
// The cursor is a decimal OFFSET into `items`, which carries a real caveat worth stating rather
// than discovering: it is only stable while the underlying list is. If items are inserted or
// removed between pages, an offset cursor shifts and a caller can skip or repeat entries. That is
// acceptable for the read-mostly listings here and matches the behaviour both copies already had;
// a keyset cursor (last-seen sort key, as list_notes uses with relPath) is the fix where stability
// matters. Do not migrate one of these to keyset without changing the cursor's documented meaning.

/** A bounded page of results plus the total the page was drawn from. */
export interface Page<T> {
  items: T[];
  total: number;
  /** Offset to resume from. Absent when this page is the last one. */
  next_cursor?: string;
}

/** Default page size when a caller supplies no limit. Deliberately small: an unbounded default is
 *  a token and latency cost paid by every caller who did not ask for it. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Slice `items` into a page. `cursor` is the offset returned by a previous call; a malformed or
 * negative cursor is clamped to 0 rather than throwing, so a client that mangles an opaque token
 * degrades to "start from the beginning" instead of failing the whole call.
 */
export function paginate<T>(items: T[], limit?: number, cursor?: string): Page<T> {
  const size = limit ?? DEFAULT_PAGE_SIZE;
  const start = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
  const slice = items.slice(start, start + size);
  const nextStart = start + slice.length;
  const next = nextStart < items.length ? String(nextStart) : undefined;
  return { items: slice, total: items.length, ...(next ? { next_cursor: next } : {}) };
}
