// THE-175 — Pensieve adapter for the source-agnostic ambient-capture format
// (ambient-import.ts). Pensieve (github.com/arkohut/pensieve, Apache-2.0, formerly "Memos") is a
// privacy-focused passive screen recorder: it screenshots the desktop on an interval, runs local
// OCR over each screenshot, and serves everything through a local (or tailscale-reachable) HTTP
// API and web UI on :8839. It is the OSS-clean slice's only adapter — Screenpipe is explicitly
// out of scope (THE-175 ticket: licensing).
//
// ENDPOINT, VERIFIED against the live source (github.com/arkohut/pensieve @ 3e55c66, 2026-07-19,
// tag v0.37.0 — memos/server.py, memos/schemas.py, memos/record.py, memos/crud.py,
// memos/plugins/ocr/main.py):
//
//   GET {baseUrl}/api/search?q=&limit=<n>&start=<epochSeconds>
//     (memos/server.py `search_entities_v2`, mounted under `/api` — memos/server.py's
//     `app.mount("/api", api_router)`.) `q=""` (empty) takes the LIST branch — no full-text
//     search, entities returned newest-first by `file_created_at` — rather than the hybrid-search
//     branch a non-empty `q` triggers (memos/crud.py `list_entities`: `.order_by(file_created_at
//     .desc())`). `start`/`end` are Unix epoch SECONDS filtered against `file_created_at` via
//     `EXTRACT(EPOCH FROM file_created_at)` (memos/crud.py `list_entities`) — this is the
//     "since timestamp" incremental query THE-175 asked to verify; there is no cursor/pagination
//     parameter on this endpoint (unlike THE-650's Readwise adapter), so incremental sync is
//     purely `start=<lastSyncEpoch>` plus this adapter's own batch cap. `limit` is server-bounded
//     to `[1, 200]` (memos/server.py: `Annotated[int, Query(ge=1, le=200)]`).
//
//   Response shape (memos/schemas.py `SearchResult`/`SearchHit`/`EntitySearchResult`):
//     `{ hits: [{ document: { id, filepath, file_created_at, tags, metadata_entries: [{key,
//     value, source}], ... } }], found, out_of, ... }`. `file_created_at` serializes as an ISO
//     8601 string (Python `datetime` -> JSON).
//
//   `metadata_entries` keys actually written by Pensieve (memos/record.py `take_screenshot_macos`/
//   `_windows`, embedded as image EXIF/PNG metadata at capture time, then copied onto the entity
//   as JSON-typed `metadata_entries` by the watch client on upload — memos/schemas.py
//   `NewEntityParam.metadata_entries`):
//     - "active_app"    -> foreground application name
//     - "active_window" -> foreground window title
//     - "url"           -> browser URL, macOS-only (memos/record.py `get_active_window_info_darwin`;
//                          Windows has "No URL support" per that file's own comment)
//     - "ocr_result"    -> the OCR plugin's output (memos/plugins/ocr/main.py, `METADATA_FIELD_NAME
//                          = "ocr_result"`), a JSON array of `{ dt_boxes, rec_txt, score }`; the
//                          plugin's own line-filtering threshold is `score > 0.5`
//                          (`main.py`: `filtered_results = [r for r in ocr_result if r['score'] >
//                          0.5]`) — mirrored here rather than trusting every low-confidence guess.
//
// AUTH: none. Pensieve's API has no auth layer (grep of memos/server.py turns up no
// Authorization/Bearer/api_key handling) — it assumes network-level access control, which is
// exactly what running it behind tailscale (this ticket's deployment model) provides.
//
// BATCH CAP: this adapter caps every fetch at `PENSIEVE_DEFAULT_LIMIT` (overridable up to the
// API's own `le=200` ceiling) so a first sync against a machine with months of unprocessed
// screenshots can't flood capture_queue in one run — the ticket's explicit non-negotiable. Because
// the list branch orders newest-first with no pagination, a capped first sync sees the most
// RECENT activity, not full history; repeated invocation with an advancing `--since` is the
// intended usage, the same incremental-polling shape `--machine`/`--since` on the CLI implies.
import type { CanonicalAmbientObservation } from "./ambient-import";

const OCR_METADATA_KEY = "ocr_result";
const OCR_SCORE_THRESHOLD = 0.5;

/** Server-enforced ceiling (`Query(ge=1, le=200)` in memos/server.py) — requesting more just gets
 *  a 422 from Pensieve, so this adapter clamps to it rather than passing a caller's value through. */
const PENSIEVE_MAX_LIMIT = 200;
/** Conservative default batch cap — see this file's header for why a cap exists at all. */
export const PENSIEVE_DEFAULT_LIMIT = 100;

interface PensieveMetadataEntry {
  key: string;
  value: unknown;
  source: string;
}

interface PensieveOcrLine {
  rec_txt: string;
  score: number;
}

interface PensieveEntitySearchResult {
  id: string;
  file_created_at: string;
  metadata_entries: PensieveMetadataEntry[];
}

interface PensieveSearchHit {
  document: PensieveEntitySearchResult;
}

interface PensieveSearchResult {
  hits: PensieveSearchHit[];
}

export interface FetchPensieveObservationsOptions {
  /** Which computer this Pensieve instance runs on — stamped onto every returned observation
   *  (CanonicalAmbientObservation.machine). Pensieve's own API has no notion of "which machine
   *  am I", so the caller (the CLI's --machine) supplies it. */
  machine: string;
  /** ISO 8601. Only entities captured after this instant are returned (maps to the API's `start`,
   *  converted to epoch seconds). */
  since?: string;
  /** Max entities to fetch this run, clamped to `[1, PENSIEVE_MAX_LIMIT]`. Defaults to
   *  `PENSIEVE_DEFAULT_LIMIT`. */
  limit?: number;
  /** Injectable transport; defaults to the global fetch. Tests pass a fixture-backed fake. */
  fetchFn?: typeof fetch;
}

export class PensieveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function metadataValue(entries: PensieveMetadataEntry[], key: string): unknown {
  return entries.find((e) => e.key === key)?.value;
}

/** `ocr_result`'s value arrives already JSON-decoded when the API round-trips a JSON-typed
 *  metadata entry (memos/server.py: `json.loads(metadata.value) if data_type == JSON_DATA else
 *  metadata.value`) — but this adapter parses defensively rather than assuming that always holds,
 *  since a legacy or hand-edited row could still carry it as a raw string. */
function ocrText(entries: PensieveMetadataEntry[]): string {
  const raw = metadataValue(entries, OCR_METADATA_KEY);
  const lines: unknown = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!Array.isArray(lines)) return "";
  return (lines as PensieveOcrLine[])
    .filter((l) => l && typeof l.rec_txt === "string" && l.score > OCR_SCORE_THRESHOLD)
    .map((l) => l.rec_txt)
    .join("\n");
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function stringMetadata(entries: PensieveMetadataEntry[], key: string): string | undefined {
  const v = metadataValue(entries, key);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function mapEntity(
  doc: PensieveEntitySearchResult,
  machine: string,
): CanonicalAmbientObservation | undefined {
  const text = ocrText(doc.metadata_entries);
  // An entity with no usable OCR text (not yet processed, or a screen with nothing legible) has
  // nothing worth staging — mirrors highlight-import's readwise.ts dropping books with zero live
  // highlights.
  if (!text) return undefined;
  return {
    source: "pensieve",
    machine,
    app: stringMetadata(doc.metadata_entries, "active_app"),
    window_title: stringMetadata(doc.metadata_entries, "active_window"),
    text,
    captured_at: doc.file_created_at,
    url: stringMetadata(doc.metadata_entries, "url"),
  };
}

/**
 * Fetch recent screen observations from a Pensieve instance and map them onto the canonical
 * ambient-capture shape. One-shot (no pagination loop, matching the endpoint's own lack of a
 * cursor) and capped at `opts.limit` (default `PENSIEVE_DEFAULT_LIMIT`, hard-clamped to the API's
 * own `le=200`) — see this file's header for why that cap exists.
 */
export async function fetchPensieveObservations(
  baseUrl: string,
  opts: FetchPensieveObservationsOptions,
): Promise<CanonicalAmbientObservation[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const limit = Math.max(1, Math.min(opts.limit ?? PENSIEVE_DEFAULT_LIMIT, PENSIEVE_MAX_LIMIT));

  const url = new URL("/api/search", baseUrl);
  url.searchParams.set("q", "");
  url.searchParams.set("limit", String(limit));
  if (opts.since) {
    const sinceEpochSeconds = Math.floor(Date.parse(opts.since) / 1000);
    if (Number.isFinite(sinceEpochSeconds)) {
      url.searchParams.set("start", String(sinceEpochSeconds));
    }
  }

  const res = await fetchFn(url.toString(), { method: "GET" });
  if (!res.ok) {
    throw new PensieveApiError(
      `Pensieve search request failed: ${res.status} ${res.statusText}`,
      res.status,
    );
  }
  const body = (await res.json()) as PensieveSearchResult;
  const items: CanonicalAmbientObservation[] = [];
  for (const hit of body.hits) {
    const item = mapEntity(hit.document, opts.machine);
    if (item) items.push(item);
  }
  return items;
}
