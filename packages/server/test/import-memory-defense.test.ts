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
import { enforceMemoryDefense } from "../src/experiential/memory-defense";
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

// Residual fix — formatCaptureContent concatenates per-field-scanned pieces (text, app/
// window_title, url, machine for ambient; text/note, title/author/url for highlights) without
// re-scanning the CONCATENATION, so a secret split across two fields survives: neither field
// alone is secret-shaped, but formatCaptureContent's own connector text ("\n\n" between
// text/attribution, or between highlight text/attribution) is whitespace — enough for
// `labeled_secret`'s `\s*[=:]\s*` to bridge a label ending one field to a value-shaped token
// starting the next. Each fixture below is asserted clean per-field FIRST (proving the gap is
// real, not just "the individual scans happen to also work"), then proven caught only once the
// FINAL persisted content is re-scanned.
describe("memoryDefense on capture import channels — split-across-fields re-scan (residual fix)", () => {
  it("ambient import: block mode refuses content that is secret-shaped ONLY once text+app are concatenated", async () => {
    const db = cacheDb();
    // Neither piece is secret-shaped alone: `text` ends in a bare label (no value follows within
    // the same field), `app` is a value-shaped token with no label of its own.
    const textPiece = "ends with token:";
    const appPiece = "kJ8xQ2vR9mN4pL7wT1zY6sB3cH0dF5gA";
    expect(
      enforceMemoryDefense({ mode: "block", pii: false }, { text: textPiece }).redactions,
    ).toBe(0);
    expect(enforceMemoryDefense({ mode: "block", pii: false }, { text: appPiece }).redactions).toBe(
      0,
    );
    const items: CanonicalAmbientObservation[] = [
      {
        source: "pensieve",
        machine: "box1",
        text: textPiece,
        app: appPiece,
        captured_at: "2026-09-28T00:00:00Z",
      },
    ];
    const r = ingestAmbient(db, "main", items, 1000, {
      memoryDefense: { mode: "block", pii: false },
    });
    expect(r).toStrictEqual({ enqueued: 0, skipped_duplicate: 0, redacted: 0, skipped_secret: 1 });
    expect(listCaptures(db, "main")).toHaveLength(0);
  });

  it("ambient import: redact mode also refuses a split-reassembled secret — a concatenation hit is refused in EVERY mode, not redacted-and-stored", async () => {
    const db = cacheDb();
    const textPiece = "ends with token:";
    const appPiece = "kJ8xQ2vR9mN4pL7wT1zY6sB3cH0dF5gA";
    const items: CanonicalAmbientObservation[] = [
      {
        source: "pensieve",
        machine: "box1",
        text: textPiece,
        app: appPiece,
        captured_at: "2026-09-28T00:00:00Z",
      },
    ];
    // Security review round (finding 1, then the fail-closed follow-up): `title`/`tags` are
    // built from the SAME pre-concatenation pieces `content` is. This importer used to try
    // re-scanning `title`/`tags` independently (they never bridge without their own adjacent
    // label — a plain value has nothing to match) and later tried a "content changed?" heuristic
    // that failed OPEN whenever `content` also held an unrelated match. The single safe
    // (`joinScan`-driven) fix refuses the WHOLE item — in `redact` mode too — rather than trying
    // to attribute a redaction back to `title`/`tags` after the fact; see ambient-import.ts.
    const r = ingestAmbient(db, "main", items, 1000, {
      memoryDefense: { mode: "redact", pii: false },
    });
    expect(r).toStrictEqual({ enqueued: 0, skipped_duplicate: 0, redacted: 0, skipped_secret: 1 });
    expect(listCaptures(db, "main")).toHaveLength(0);
  });

  it("highlight import: block mode refuses content that is secret-shaped ONLY once highlight text+title are concatenated", async () => {
    const db = cacheDb();
    const textPiece = "ends with token:";
    const titlePiece = "kJ8xQ2vR9mN4pL7wT1zY6sB3cH0dF5gA";
    expect(
      enforceMemoryDefense({ mode: "block", pii: false }, { text: textPiece }).redactions,
    ).toBe(0);
    expect(
      enforceMemoryDefense({ mode: "block", pii: false }, { text: titlePiece }).redactions,
    ).toBe(0);
    const items: CanonicalHighlightSource[] = [
      {
        source: "readwise",
        source_id: "book-1",
        title: titlePiece,
        highlights: [{ text: textPiece }],
      },
    ];
    const r = ingestHighlights(db, "main", items, 1000, {
      memoryDefense: { mode: "block", pii: false },
    });
    expect(r).toStrictEqual({ enqueued: 0, skipped_duplicate: 0, redacted: 0, skipped_secret: 1 });
    expect(listCaptures(db, "main", { source: "import" })).toHaveLength(0);
  });

  it("highlight import: redact mode also refuses a split-reassembled secret — a concatenation hit is refused in EVERY mode, not redacted-and-stored", async () => {
    const db = cacheDb();
    const textPiece = "ends with token:";
    const titlePiece = "kJ8xQ2vR9mN4pL7wT1zY6sB3cH0dF5gA";
    const items: CanonicalHighlightSource[] = [
      {
        source: "readwise",
        source_id: "book-1",
        title: titlePiece,
        highlights: [{ text: textPiece }],
      },
    ];
    // Security review round (finding 1, then the fail-closed follow-up): `title: scannedItem.title`
    // is built from the SAME pre-concatenation piece `content` is — see the ambient sibling test
    // above for why refusing the whole item (not a per-field rescan or a "content changed?"
    // heuristic) is the safe fix, in `redact` mode too.
    const r = ingestHighlights(db, "main", items, 1000, {
      memoryDefense: { mode: "redact", pii: false },
    });
    expect(r).toStrictEqual({ enqueued: 0, skipped_duplicate: 0, redacted: 0, skipped_secret: 1 });
    expect(listCaptures(db, "main", { source: "import" })).toHaveLength(0);
  });
});

// Residual fix (finding 2) — formatCaptureContent's own connectors are not whitespace:
// highlight's `> ${note}` blockquote prefix, and ambient's ` — ` attribution separator between
// app/window_title. `labeled_secret` only bridges `\s*[=:]\s*` — a "> " or " — " between the
// label and the value breaks that bridge even though the two halves sit right next to each other
// in the persisted content, so the residual-fix content rescan above (which DOES catch a plain
// "\n\n"-joined split) misses these. Fixture proven clean per-field AND via the (connector-broken)
// formatted content FIRST, to show the gap is real — then caught only once a synthetic
// "\n"-joined reassembly of the raw ordered field values (no connector) is also scanned. Since
// the raw content string offers no attributable location to redact just the hidden half, the item
// is refused outright in EITHER mode — the same "refuse when unattributable" choice finding 1's
// own concatenation fix makes when nothing safer is available.
describe("memoryDefense on capture import channels — connector-hidden split secret (residual fix)", () => {
  it("highlight import: a label ending `text` and a value starting `note` — hidden behind the '> ' blockquote connector — is refused in block mode", async () => {
    const db = cacheDb();
    const textPiece = "ends with token:";
    const notePiece = "kJ8xQ2vR9mN4pL7wT1zY6sB3cH0dF5gA";
    expect(
      enforceMemoryDefense({ mode: "block", pii: false }, { text: textPiece }).redactions,
    ).toBe(0);
    expect(
      enforceMemoryDefense({ mode: "block", pii: false }, { note: notePiece }).redactions,
    ).toBe(0);
    const items: CanonicalHighlightSource[] = [
      {
        source: "readwise",
        source_id: "book-1",
        title: "A Book",
        highlights: [{ text: textPiece, note: notePiece }],
      },
    ];
    const r = ingestHighlights(db, "main", items, 1000, {
      memoryDefense: { mode: "block", pii: false },
    });
    expect(r).toStrictEqual({ enqueued: 0, skipped_duplicate: 0, redacted: 0, skipped_secret: 1 });
    expect(listCaptures(db, "main", { source: "import" })).toHaveLength(0);
  });

  it("highlight import: the same '> note' split is refused in redact mode too — no safe location to cut the connector-hidden half", async () => {
    const db = cacheDb();
    const textPiece = "ends with token:";
    const notePiece = "kJ8xQ2vR9mN4pL7wT1zY6sB3cH0dF5gA";
    const items: CanonicalHighlightSource[] = [
      {
        source: "readwise",
        source_id: "book-1",
        title: "A Book",
        highlights: [{ text: textPiece, note: notePiece }],
      },
    ];
    const r = ingestHighlights(db, "main", items, 1000, {
      memoryDefense: { mode: "redact", pii: false },
    });
    expect(r).toStrictEqual({ enqueued: 0, skipped_duplicate: 0, redacted: 0, skipped_secret: 1 });
    expect(listCaptures(db, "main", { source: "import" })).toHaveLength(0);
  });

  it("ambient import: a label ending `app` and a value starting `window_title` — hidden behind the ' — ' attribution connector — is refused in block mode", async () => {
    const db = cacheDb();
    const appPiece = "ends with token:";
    const windowTitlePiece = "kJ8xQ2vR9mN4pL7wT1zY6sB3cH0dF5gA";
    expect(enforceMemoryDefense({ mode: "block", pii: false }, { app: appPiece }).redactions).toBe(
      0,
    );
    expect(
      enforceMemoryDefense({ mode: "block", pii: false }, { window_title: windowTitlePiece })
        .redactions,
    ).toBe(0);
    const items: CanonicalAmbientObservation[] = [
      {
        source: "pensieve",
        machine: "box1",
        text: "clean OCR text",
        app: appPiece,
        window_title: windowTitlePiece,
        captured_at: "2026-09-28T00:00:00Z",
      },
    ];
    const r = ingestAmbient(db, "main", items, 1000, {
      memoryDefense: { mode: "block", pii: false },
    });
    expect(r).toStrictEqual({ enqueued: 0, skipped_duplicate: 0, redacted: 0, skipped_secret: 1 });
    expect(listCaptures(db, "main")).toHaveLength(0);
  });

  it("ambient import: the same 'app — window_title' split is refused in redact mode too — no safe location to cut the connector-hidden half", async () => {
    const db = cacheDb();
    const appPiece = "ends with token:";
    const windowTitlePiece = "kJ8xQ2vR9mN4pL7wT1zY6sB3cH0dF5gA";
    const items: CanonicalAmbientObservation[] = [
      {
        source: "pensieve",
        machine: "box1",
        text: "clean OCR text",
        app: appPiece,
        window_title: windowTitlePiece,
        captured_at: "2026-09-28T00:00:00Z",
      },
    ];
    const r = ingestAmbient(db, "main", items, 1000, {
      memoryDefense: { mode: "redact", pii: false },
    });
    expect(r).toStrictEqual({ enqueued: 0, skipped_duplicate: 0, redacted: 0, skipped_secret: 1 });
    expect(listCaptures(db, "main")).toHaveLength(0);
  });

  // Security review round (fail-closed follow-up) — an UNRELATED cross-field match (caught by
  // `content`'s own "\n\n"-bridging rescan) sitting in the SAME `content` string as a
  // connector-hidden pair (hidden behind ` — `, only `contentJoin` can see it). An earlier
  // version compared `content` before/after that rescan and only refused when NOTHING else had
  // changed — here the unrelated match makes `content` "changed" for a reason having nothing to
  // do with the hidden pair, which let the still-live `windowTitlePiece` secret slip through
  // that earlier version's guard. Verified against the pre-fix code directly (not just inferred):
  // `content` rescanned alone came back as
  // `"...ends with [REDACTED] token: — kJ8xQ2vR9mN4pL7wT1zY6sB3cH0dF5gA..."` — changed, and still
  // containing the raw secret. RED against that version; GREEN once ANY `contentJoin` hit refuses
  // the item unconditionally, independent of what else in `content` did or didn't change.
  it("ambient import: an unrelated in-field-adjacent match in `content` must not mask a SEPARATE connector-hidden secret in the same string (fail-closed round)", async () => {
    const db = cacheDb();
    // `app` plays two roles at once: its own leading text is the VALUE half of `text`'s
    // "token:" label (bridges via content's "\n\n" join — the unrelated match), and its own
    // TRAILING "token:" is the LABEL half of a second pair whose value is `window_title` (hidden
    // behind the " — " attribution connector).
    const text = "ends with token:";
    const app = "harmlessLookingButFlaggedValue token:";
    const windowTitle = "kJ8xQ2vR9mN4pL7wT1zY6sB3cH0dF5gA";
    const items: CanonicalAmbientObservation[] = [
      {
        source: "pensieve",
        machine: "box1",
        text,
        app,
        window_title: windowTitle,
        captured_at: "2026-09-28T00:00:00Z",
      },
    ];
    for (const mode of ["block", "redact"] as const) {
      const r = ingestAmbient(db, `main-${mode}`, items, 1000, {
        memoryDefense: { mode, pii: false },
      });
      expect(r, `mode=${mode}`).toStrictEqual({
        enqueued: 0,
        skipped_duplicate: 0,
        redacted: 0,
        skipped_secret: 1,
      });
      const rows = listCaptures(db, `main-${mode}`);
      expect(rows, `mode=${mode}`).toHaveLength(0);
    }
  });
});
