// THE-650 — source-agnostic highlight-import format + Readwise adapter, staged via capture_queue.
//
// Integration-shaped: a fixture Readwise `/export/` response (the real nested book -> highlights
// shape, verified against readwise.io/api_deets) goes through fetchReadwiseHighlights, then
// ingestHighlights, and lands as capture_queue rows with source: "import" — the same reviewable
// staging path THE-855's poison scan already covers for every enqueue. A second sync over the
// same fixture must dedup: zero new rows, every highlight reported skipped_duplicate.
import { describe, expect, it } from "vitest";
import { IMPORT_DEDUPE_TAG_PREFIX, ingestHighlights } from "../src/capture/highlight-import";
import { listCaptures } from "../src/capture/queue";
import { fetchReadwiseHighlights, ReadwiseApiError } from "../src/capture/readwise";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";
import { makeM5Vault } from "./m5-helpers";

function cacheDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

// A trimmed real /export/ response shape: two books, three live highlights, one deleted
// highlight (must be dropped) and one wholly deleted book (must be dropped entirely).
const PAGE_1 = {
  count: 2,
  nextPageCursor: "cursor-2",
  results: [
    {
      user_book_id: 111,
      is_deleted: false,
      title: "Thinking in Systems",
      author: "Donella Meadows",
      source: "reader",
      unique_url: "https://readwise.io/bookreview/111",
      highlights: [
        {
          id: 9001,
          is_deleted: false,
          text: "A system is more than the sum of its parts.",
          location: 42,
          location_type: "order",
          note: "core idea",
          highlighted_at: "2026-08-01T10:00:00Z",
        },
        {
          id: 9002,
          is_deleted: false,
          text: "Boundaries are made, not found.",
          location: 88,
          location_type: "order",
          note: null,
          highlighted_at: "2026-08-01T10:05:00Z",
        },
        {
          id: 9003,
          is_deleted: true,
          text: "This highlight was deleted upstream.",
          location: 90,
          location_type: "order",
          note: null,
          highlighted_at: "2026-08-01T10:06:00Z",
        },
      ],
    },
    {
      user_book_id: 222,
      is_deleted: true,
      title: "A wholly deleted book",
      author: null,
      source: "reader",
      unique_url: null,
      highlights: [
        {
          id: 9004,
          is_deleted: false,
          text: "Should never appear — the book itself is deleted.",
          location: 1,
          location_type: "order",
          note: null,
          highlighted_at: "2026-08-01T09:00:00Z",
        },
      ],
    },
  ],
};

const PAGE_2 = {
  count: 1,
  nextPageCursor: null,
  results: [
    {
      user_book_id: 333,
      is_deleted: false,
      title: "Antifragile",
      author: "Nassim Nicholas Taleb",
      source: "raindrop",
      unique_url: null,
      highlights: [
        {
          id: 9005,
          is_deleted: false,
          text: "The antifragile gains from disorder.",
          location: 12,
          location_type: "order",
          note: null,
          highlighted_at: "2026-08-02T08:00:00Z",
        },
      ],
    },
  ],
};

function fakeReadwiseFetch(): typeof fetch {
  const calls: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(url.toString());
    calls.push(u.toString());
    expect((init?.headers as Record<string, string>)?.Authorization).toBe("Token test-token");
    const cursor = u.searchParams.get("pageCursor");
    const body = cursor === "cursor-2" ? PAGE_2 : PAGE_1;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  (impl as unknown as { calls: string[] }).calls = calls;
  return impl;
}

describe("THE-650 Readwise adapter -> canonical model", () => {
  it("maps the export shape, paginates via pageCursor, and drops deleted books/highlights", async () => {
    const fetchFn = fakeReadwiseFetch();
    const items = await fetchReadwiseHighlights("test-token", { fetchFn });

    // Book 222 (is_deleted) is gone entirely; the deleted highlight inside book 111 is dropped.
    expect(items.map((i) => i.source_id).sort()).toStrictEqual(["111", "333"]);
    const systems = items.find((i) => i.source_id === "111");
    expect(systems).toMatchObject({
      source: "readwise",
      title: "Thinking in Systems",
      author: "Donella Meadows",
      url: "https://readwise.io/bookreview/111",
      tags: ["readwise-source:reader"],
    });
    expect(systems?.highlights).toHaveLength(2);
    expect(systems?.highlights[0]).toStrictEqual({
      text: "A system is more than the sum of its parts.",
      note: "core idea",
      location: 42,
      highlighted_at: "2026-08-01T10:00:00Z",
    });

    const calls = (fetchFn as unknown as { calls: string[] }).calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("pageCursor");
    expect(calls[1]).toContain("pageCursor=cursor-2");
  });

  it("surfaces a non-2xx as ReadwiseApiError with the status attached", async () => {
    const fetchFn = (async () =>
      new Response("unauthorized", {
        status: 401,
        statusText: "Unauthorized",
      })) as unknown as typeof fetch;
    await expect(fetchReadwiseHighlights("bad-token", { fetchFn })).rejects.toBeInstanceOf(
      ReadwiseApiError,
    );
    try {
      await fetchReadwiseHighlights("bad-token", { fetchFn });
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(ReadwiseApiError);
      expect((e as ReadwiseApiError).status).toBe(401);
    }
  });
});

describe("THE-650 ingestHighlights -> capture_queue", () => {
  it("enqueues one capture per live highlight, source: import, and dedups on re-sync", async () => {
    const db = cacheDb();
    const fetchFn = fakeReadwiseFetch();
    const items = await fetchReadwiseHighlights("test-token", { fetchFn });
    const totalHighlights = items.reduce((n, i) => n + i.highlights.length, 0);
    expect(totalHighlights).toBe(3); // 2 from book 111 + 1 from book 333

    const first = ingestHighlights(db, "main", items, 1000);
    expect(first).toStrictEqual({ enqueued: 3, skipped_duplicate: 0 });

    const rows = listCaptures(db, "main", { source: "import" });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.source).toBe("import");
      expect(r.committed_at).toBeNull();
    }
    const systemsRow = rows.find((r) => r.content.includes("more than the sum of its parts"));
    expect(systemsRow?.title).toBe("Thinking in Systems");
    expect(systemsRow?.tags).toContain("import");
    expect(systemsRow?.tags).toContain("readwise");
    expect(systemsRow?.tags).toMatch(/import-dedupe:[0-9a-f]{32}/);
    // The note travels into the staged content — it is reviewable, not silently dropped.
    expect(systemsRow?.content).toContain("core idea");

    // Re-run over the SAME fetched items (simulating a second sync pass): nothing new enqueued.
    const second = ingestHighlights(db, "main", items, 2000);
    expect(second).toStrictEqual({ enqueued: 0, skipped_duplicate: 3 });
    expect(listCaptures(db, "main", { source: "import" })).toHaveLength(3);
  });

  it("a duplicate is still skipped after the original capture is committed", async () => {
    const db = cacheDb();
    const fetchFn = fakeReadwiseFetch();
    const items = await fetchReadwiseHighlights("test-token", { fetchFn });
    ingestHighlights(db, "main", items, 1000);
    const [row] = listCaptures(db, "main", { source: "import" });
    if (!row) throw new Error("expected a staged row");
    db.prepare("UPDATE capture_queue SET committed_at = ?, committed_path = ? WHERE id = ?").run(
      1500,
      "/inbox/committed.md",
      row.id,
    );

    // Committed rows drop out of the default (pending) listCaptures view, but ingestHighlights'
    // dedup must still see them — a highlight a human already reviewed and filed away must not
    // resurface just because it left the pending queue.
    const rerun = ingestHighlights(db, "main", items, 2000);
    expect(rerun.skipped_duplicate).toBe(3);
    expect(rerun.enqueued).toBe(0);
  });

  it("--dry-run reports counts and enqueues nothing", async () => {
    const db = cacheDb();
    const fetchFn = fakeReadwiseFetch();
    const items = await fetchReadwiseHighlights("test-token", { fetchFn });
    const result = ingestHighlights(db, "main", items, 1000, { dryRun: true });
    expect(result).toStrictEqual({ enqueued: 3, skipped_duplicate: 0 });
    expect(listCaptures(db, "main", { source: "import" })).toHaveLength(0);
  });
});

// THE-650 — the `import-dedupe:<hash>` tag ingestHighlights stamps for its own re-sync lookup
// (capture/queue.ts's listCaptureTags reads it straight from SQL) must never reach a human
// reviewer or a committed note's frontmatter. tools/m5/capture-tools.ts's `visibleTags` is the
// filter; this exercises it end-to-end through the real MCP tools, not just the filter function.
describe("THE-650 the dedupe tag stays internal (never surfaces via the MCP tools)", () => {
  it("list_capture_queue hides it, and commit_capture never writes it into frontmatter", async () => {
    const v = makeM5Vault();
    try {
      const dedupeTag = `${IMPORT_DEDUPE_TAG_PREFIX}deadbeefdeadbeefdeadbeefdeadbeef`;
      const enq = await v.call("enqueue_capture", {
        vault: "test",
        content: "A system is more than the sum of its parts.",
        title: "Thinking in Systems",
        tags: ["import", "readwise", dedupeTag],
        source: "import",
      });
      if (!enq.ok) throw new Error("enqueue failed");
      const captureId = (enq.data as { capture_id: string }).capture_id;

      const listed = await v.call("list_capture_queue", { vault: "test", source: "import" });
      if (!listed.ok) throw new Error("list failed");
      const item = (listed.data as { items: Array<{ tags: string[] }> }).items[0];
      expect(item?.tags).toStrictEqual(["import", "readwise"]);
      expect(item?.tags).not.toContain(dedupeTag);

      const committed = await v.call("commit_capture", {
        vault: "test",
        capture_id: captureId,
        target_path: "inbox/systems.md",
      });
      expect(committed.ok).toBe(true);
      const note = v.read("inbox/systems.md");
      expect(note).toContain("import");
      expect(note).toContain("readwise");
      expect(note).not.toContain(IMPORT_DEDUPE_TAG_PREFIX);
    } finally {
      v.cleanup();
    }
  });
});
