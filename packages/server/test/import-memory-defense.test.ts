// GH #994 follow-up — memoryDefense on the import channels: capture/ambient-import.ts,
// capture/highlight-import.ts, and cli/commands/memory-import.ts's own M5 tool wiring. Before
// this file's fix: (1) ambient/highlight import ran no PII scan and never SKIPPED a block-worthy
// item (ambient ran only the unconditional baseline redactSecrets; highlight ran no scan at all);
// (2) `obsidian-tc memory import` dispatched create_entity/add_observation/link_entities through
// a ToolRegistry wired with NO memoryDefense accessor at all, so every batch-imported entity
// bypassed the vault's memoryDefense policy even though it went through the "sanctioned" tool
// path.
//
// Secrets assembled at runtime — same no-literal-secret convention as memory-defense.test.ts.
import { describe, expect, it } from "vitest";
import { type CanonicalAmbientObservation, ingestAmbient } from "../src/capture/ambient-import";
import { type CanonicalHighlightSource, ingestHighlights } from "../src/capture/highlight-import";
import { listCaptures } from "../src/capture/queue";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";

function cacheDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

// A Luhn-valid Visa PAN — matched only by the PII scanner (scanPii), never redactSecrets'
// SECRET_PATTERNS, so these tests specifically exercise the memoryDefense PII layer neither
// import channel ran before this fix.
function fakeVisaPan(): string {
  // issuer prefix 4 (Visa), Luhn-valid (verified via codecalc, not by eye).
  return ["4234", "5678", "9012", "3449"].join(" ");
}

function fakeOpenAiKey(): string {
  return ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
}

describe("memoryDefense on capture import channels (GH #994 follow-up)", () => {
  it("ambient import: block mode skips a PII-shaped observation, counted not described", async () => {
    const db = cacheDb();
    const pan = fakeVisaPan();
    const items: CanonicalAmbientObservation[] = [
      {
        source: "pensieve",
        machine: "box1",
        text: `card on screen: ${pan}`,
        captured_at: "2026-09-28T00:00:00Z",
      },
    ];
    const r = ingestAmbient(db, "main", items, 1000, {
      memoryDefense: { mode: "block", pii: true },
    });
    expect(r).toStrictEqual({ enqueued: 0, skipped_duplicate: 0, redacted: 0, skipped_secret: 1 });
    expect(listCaptures(db, "main")).toHaveLength(0);
  });

  it("ambient import: redact mode stores [REDACTED] for a PII hit the baseline scan misses", async () => {
    const db = cacheDb();
    const pan = fakeVisaPan();
    const items: CanonicalAmbientObservation[] = [
      {
        source: "pensieve",
        machine: "box1",
        text: `card on screen: ${pan}`,
        captured_at: "2026-09-28T00:00:00Z",
      },
    ];
    const r = ingestAmbient(db, "main", items, 1000, {
      memoryDefense: { mode: "redact", pii: true },
    });
    expect(r.enqueued).toBe(1);
    expect(r.skipped_secret).toBe(0);
    const rows = listCaptures(db, "main");
    expect(rows[0]?.content).not.toContain(pan.replace(/ /g, ""));
    expect(rows[0]?.content).toContain("[REDACTED]");
  });

  it("highlight import: block mode skips a secret-shaped highlight note, nothing enqueued", async () => {
    const db = cacheDb();
    const pan = fakeVisaPan();
    const items: CanonicalHighlightSource[] = [
      {
        source: "readwise",
        source_id: "book-1",
        title: "A Book",
        highlights: [{ text: "a clean highlight", note: `card: ${pan}` }],
      },
    ];
    const r = ingestHighlights(db, "main", items, 1000, {
      memoryDefense: { mode: "block", pii: true },
    });
    expect(r).toStrictEqual({ enqueued: 0, skipped_duplicate: 0, redacted: 0, skipped_secret: 1 });
    expect(listCaptures(db, "main", { source: "import" })).toHaveLength(0);
  });

  it("highlight import: redact mode stores [REDACTED] and reports redactions", async () => {
    const db = cacheDb();
    const pan = fakeVisaPan();
    const items: CanonicalHighlightSource[] = [
      {
        source: "readwise",
        source_id: "book-1",
        title: "A Book",
        highlights: [{ text: "a clean highlight", note: `card: ${pan}` }],
      },
    ];
    const r = ingestHighlights(db, "main", items, 1000, {
      memoryDefense: { mode: "redact", pii: true },
    });
    expect(r.enqueued).toBe(1);
    expect(r.redacted).toBe(1);
    const rows = listCaptures(db, "main", { source: "import" });
    expect(rows[0]?.content).not.toContain(pan.replace(/ /g, ""));
    expect(rows[0]?.content).toContain("[REDACTED]");
  });

  // Security review round (HIGH #3): previously only `text` (ambient) / `text`+`note` (highlight)
  // were scanned — app/window_title/url/machine and title/author/url/tags were spliced into the
  // persisted content/title/tags RAW. A credential sitting in a window title or a SAS-token-
  // bearing URL (routine OCR/browser-capture shapes) bypassed memoryDefense entirely. These are
  // the RED cases that gap would have missed: the secret lives OUTSIDE `text`/`note`.
  it("ambient import: block mode refuses a secret-shaped `url` even though `text` itself is clean", async () => {
    const db = cacheDb();
    const secret = fakeOpenAiKey();
    const items: CanonicalAmbientObservation[] = [
      {
        source: "pensieve",
        machine: "box1",
        text: "clean OCR text, nothing secret here",
        url: `https://example.com/callback?token=${secret}`,
        captured_at: "2026-09-28T00:00:00Z",
      },
    ];
    const r = ingestAmbient(db, "main", items, 1000, {
      memoryDefense: { mode: "block", pii: false },
    });
    expect(r).toStrictEqual({ enqueued: 0, skipped_duplicate: 0, redacted: 0, skipped_secret: 1 });
    expect(listCaptures(db, "main")).toHaveLength(0);
  });

  it("ambient import: redact mode redacts a secret-shaped `window_title`, stored content never contains it raw", async () => {
    const db = cacheDb();
    const secret = fakeOpenAiKey();
    const items: CanonicalAmbientObservation[] = [
      {
        source: "pensieve",
        machine: "box1",
        text: "clean OCR text",
        window_title: `Terminal — ${secret}`,
        captured_at: "2026-09-28T00:00:00Z",
      },
    ];
    const r = ingestAmbient(db, "main", items, 1000, {
      memoryDefense: { mode: "redact", pii: false },
    });
    expect(r.enqueued).toBe(1);
    const rows = listCaptures(db, "main");
    expect(rows[0]?.content).not.toContain(secret);
    expect(rows[0]?.title).not.toContain(secret);
  });

  it("highlight import: block mode refuses a secret-shaped `title`, nothing enqueued for that item", async () => {
    const db = cacheDb();
    const secret = fakeOpenAiKey();
    const items: CanonicalHighlightSource[] = [
      {
        source: "readwise",
        source_id: "book-1",
        title: `Notes — ${secret}`,
        highlights: [{ text: "a clean highlight" }],
      },
    ];
    const r = ingestHighlights(db, "main", items, 1000, {
      memoryDefense: { mode: "block", pii: false },
    });
    expect(r).toStrictEqual({ enqueued: 0, skipped_duplicate: 0, redacted: 0, skipped_secret: 1 });
    expect(listCaptures(db, "main", { source: "import" })).toHaveLength(0);
  });

  it("highlight import: redact mode redacts a secret-shaped `author`/`url`/`tags`, stored row never contains it raw", async () => {
    const db = cacheDb();
    const secret = fakeOpenAiKey();
    const items: CanonicalHighlightSource[] = [
      {
        source: "readwise",
        source_id: "book-1",
        title: "A Book",
        author: `Ghostwriter ${secret}`,
        url: `https://example.com/book?key=${secret}`,
        tags: [`leaked-${secret}`],
        highlights: [{ text: "a clean highlight" }],
      },
    ];
    const r = ingestHighlights(db, "main", items, 1000, {
      memoryDefense: { mode: "redact", pii: false },
    });
    expect(r.enqueued).toBe(1);
    const rows = listCaptures(db, "main", { source: "import" });
    expect(rows[0]?.content).not.toContain(secret);
    expect(rows[0]?.tags ?? "").not.toContain(secret);
  });

  it("off (default): both channels persist a PII-shaped value verbatim — unchanged baseline", async () => {
    const db = cacheDb();
    const pan = fakeVisaPan();
    const ambientItems: CanonicalAmbientObservation[] = [
      {
        source: "pensieve",
        machine: "box1",
        text: `card on screen: ${pan}`,
        captured_at: "2026-09-28T00:00:00Z",
      },
    ];
    const r = ingestAmbient(db, "main", ambientItems, 1000);
    expect(r.enqueued).toBe(1);
    expect(listCaptures(db, "main")[0]?.content).toContain(pan);
  });
});
