// THE-175 — source-agnostic ambient-capture import format: the canonical shape every desktop
// screen-capture backend (Pensieve first; see capture/pensieve.ts) maps into before landing in
// capture_queue via `enqueueCapture`. Sibling to THE-650's highlight-import format
// (capture/highlight-import.ts) — same pattern, different domain: that one is read-later
// highlights, this one is passive screen-activity observations (OCR'd screen text, active
// app/window, optional browser URL). Deliberately independent of any one backend's field names —
// a future Screenpipe or other ambient-capture adapter is expected to produce this SAME shape.
//
// INGESTION PATH: an ambient observation is STAGED content, not a vault write — the same "no path
// from untrusted input to the vault without a human" contract every capture_queue producer gets
// (queue.ts's header, THE-855's poison scan runs on it exactly like any other enqueue). This
// module is a thin wrapper over `enqueueCapture` with `source: "ambient"` — the channel
// experiential/poison.ts's frozen CHANNEL_TRUST table reserves BY NAME for this exact ticket
// ("ambient: 0.3, // future: ambient capture worker (THE-175)"); that table is never modified
// here. Plus the two things this format needs that a generic capture producer does not:
//
//   1. REDACTION BEFORE ENQUEUE. Passively captured screen text is far more likely than a
//      deliberate highlight to contain a credential caught mid-screen (a terminal with an env var
//      dump, a password manager unlock screen someone forgot was in frame). THE-855's poison scan
//      (enqueueCapture, unconditional on every row) catches INSTRUCTION-shaped content; it says
//      nothing about a bare secret sitting in otherwise-benign OCR text. `redactSecrets`
//      (experiential/redact.ts — the ONE scanner every capture surface shares) runs over `text`
//      here, before enqueue, so a raw credential never reaches capture_queue at all — not even in
//      a poison-scanned-clean row a reviewer might approve without re-reading every character.
//   2. DEDUP. Ambient text is highly repetitive by construction (a static screen re-polled every
//      cycle re-observes the same pixels). capture_queue carries no unique constraint (THE-855 kept
//      the schema append-only and minimal), so — mirroring THE-650's `import-dedupe:<hash>`
//      mechanism exactly — the dedup key travels as a `tags` entry, `ambient-dedupe:<hash>`,
//      checked against every existing `source: "ambient"` row (pending AND committed, via
//      queue.ts's `listCaptureTags`) before enqueueing. `commit_capture`/human review is still the
//      only path to the vault; this only keeps the QUEUE itself from filling with repeats.
import type { Database } from "../db/types";
import { redactSecrets } from "../experiential/redact";
import { argsHash } from "../hash";
import { enqueueCapture, listCaptureTags } from "./queue";

/** One passively-observed screen moment, already mapped from a backend's native shape into this
 *  source-agnostic model. No field here may assume a particular backend's vocabulary. */
export interface CanonicalAmbientObservation {
  /** Backend identity, e.g. "pensieve". A free string — a new adapter needs no registry entry. */
  source: string;
  /** Which computer this observation came from — operator-supplied (the CLI's --machine), since a
   *  backend polled over the network has no reliable way to name itself. */
  machine: string;
  /** Foreground application name, when the backend captured one. */
  app?: string;
  /** Foreground window title, when the backend captured one. */
  window_title?: string;
  /** The observed text (typically OCR'd screen content). Required — an observation with nothing to
   *  say has nothing worth staging. */
  text: string;
  /** ISO 8601, when this screen state was captured. */
  captured_at: string;
  /** Browser URL, when the backend could resolve one (e.g. the foreground window was a browser). */
  url?: string;
}

// Exported so tools/m5/capture-tools.ts's `visibleTags` can filter it out of human/vault-facing
// surfaces (commitFrontmatter, list_capture_queue) alongside THE-650's IMPORT_DEDUPE_TAG_PREFIX —
// a machine dedupe hash has no business landing in a committed note's frontmatter tags or in front
// of a reviewer. `listCaptureTags` still reads the RAW tags column directly for the dedup check
// itself, so filtering it out of the tools layer never affects this module's own dedup lookup.
export const AMBIENT_DEDUPE_TAG_PREFIX = "ambient-dedupe:";

/**
 * Deterministic identity for one ambient observation. Hashes `(source, machine, app, text)` —
 * deliberately NOT `window_title`, `url` or `captured_at`: the ticket's design is that the SAME
 * screen content re-polled off the same app on the same machine must dedup regardless of which
 * exact instant it was observed at or which window sub-title changed. A genuinely new screen
 * (different text) always gets a fresh key.
 */
export function ambientDedupeKey(
  o: Pick<CanonicalAmbientObservation, "source" | "machine" | "app" | "text">,
): string {
  // Reuses hash.ts's argsHash (sha256 of canonicalJson, 16-byte hex) — see highlight-import.ts's
  // highlightDedupeKey for why this is preferred over a second hand-rolled derivation.
  return argsHash("ambient-import", {
    source: o.source,
    machine: o.machine,
    app: o.app ?? null,
    text: o.text,
  });
}

function formatCaptureContent(o: CanonicalAmbientObservation, redactedText: string): string {
  const parts = [redactedText];
  const attribution = [o.app, o.window_title].filter((s): s is string => !!s).join(" — ");
  if (attribution) parts.push(o.url ? `${attribution} (${o.url})` : attribution);
  parts.push(`captured ${o.captured_at} on ${o.machine}`);
  return parts.join("\n\n");
}

export interface IngestAmbientResult {
  enqueued: number;
  skipped_duplicate: number;
  /** Total secret-shaped substrings redacted across every observation staged (or that WOULD have
   *  been staged, in --dry-run) this run — see redact.ts's SECRET_PATTERNS for what counts. */
  redacted: number;
}

/**
 * Stage every observation in `items` into `vaultId`'s capture_queue (`source: "ambient"`), after
 * redacting secret-shaped substrings out of `text` and skipping any whose dedupe key already
 * exists on a prior "ambient" row. Nothing here writes to the vault — `commit_capture` is still
 * the human gate `enqueueCapture` always has.
 */
export function ingestAmbient(
  db: Database,
  vaultId: string,
  items: readonly CanonicalAmbientObservation[],
  now: number,
  opts: { dryRun?: boolean } = {},
): IngestAmbientResult {
  const seen = new Set<string>();
  for (const tags of listCaptureTags(db, vaultId, "ambient")) {
    for (const t of tags) {
      if (t.startsWith(AMBIENT_DEDUPE_TAG_PREFIX))
        seen.add(t.slice(AMBIENT_DEDUPE_TAG_PREFIX.length));
    }
  }

  let enqueued = 0;
  let skipped_duplicate = 0;
  let redacted = 0;
  for (const o of items) {
    const key = ambientDedupeKey(o);
    if (seen.has(key)) {
      skipped_duplicate++;
      continue;
    }
    // Redaction runs regardless of dryRun — a dry-run preview should tell an operator how many
    // secrets WOULD have been scrubbed, the same way it reports how many rows would enqueue.
    const { text: redactedText, redactions } = redactSecrets(o.text);
    redacted += redactions;
    if (!opts.dryRun) {
      enqueueCapture(db, {
        vaultId,
        content: formatCaptureContent(o, redactedText),
        title: o.window_title ?? o.app,
        tags: ["ambient", o.source, `machine:${o.machine}`, `${AMBIENT_DEDUPE_TAG_PREFIX}${key}`],
        source: "ambient",
        now,
      });
    }
    // Marked seen even in dry-run so two observations sharing an identity WITHIN this one batch
    // are counted as one enqueue + one duplicate, matching what a real run would do — the same
    // rationale ingestHighlights documents for its own `seen.add` placement.
    seen.add(key);
    enqueued++;
  }
  return { enqueued, skipped_duplicate, redacted };
}
