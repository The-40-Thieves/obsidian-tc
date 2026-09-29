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
import { ObsidianTcError, type VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../db/types";
import { enforceMemoryDefense, MEMORY_DEFENSE_OFF } from "../experiential/memory-defense";
import { redactSecrets } from "../experiential/redact";
import { argsHash } from "../hash";
import type { MetricsRecorder } from "../metrics/registry";
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

// Security review round (GH #994 follow-up): every one of these fields lands in the persisted
// capture row's content/title/tags exactly like `text` does, so all of them must go through the
// SAME scan `text` gets — previously only `text` was scanned and app/window_title/url/machine
// were spliced in raw, which meant a credential sitting in a window title or a SAS-token-bearing
// URL (both routine OCR/browser-capture shapes) bypassed memoryDefense entirely.
interface ScannedAmbientFields {
  text: string;
  app?: string;
  window_title?: string;
  url?: string;
  machine: string;
}

// `captured_at` is a server/backend-generated ISO timestamp, never OCR'd or otherwise
// caller-free-text — not a plausible secret carrier, so it is not part of the scanned field set
// above and is spliced in as-is, same as before this round.
function formatCaptureContent(o: ScannedAmbientFields, capturedAt: string): string {
  const parts = [o.text];
  const attribution = [o.app, o.window_title].filter((s): s is string => !!s).join(" — ");
  if (attribution) parts.push(o.url ? `${attribution} (${o.url})` : attribution);
  parts.push(`captured ${capturedAt} on ${o.machine}`);
  return parts.join("\n\n");
}

export interface IngestAmbientResult {
  enqueued: number;
  skipped_duplicate: number;
  /** Total secret-shaped substrings redacted across every observation staged (or that WOULD have
   *  been staged, in --dry-run) this run — see redact.ts's SECRET_PATTERNS for what counts. This
   *  is the BASELINE redactSecrets pass below, unconditional and independent of memoryDefense. */
  redacted: number;
  /** GH #994 follow-up: observations skipped outright because the vault's memoryDefense policy is
   *  `block` and a block-worthy match survived the baseline redaction above (e.g. a PII hit, or a
   *  high-confidence labeled secret redactSecrets' own patterns do not cover). Counted, never
   *  described — no pattern id or field name, since even that is one bit more than "off" mode. */
  skipped_secret: number;
}

/**
 * Stage every observation in `items` into `vaultId`'s capture_queue (`source: "ambient"`), after
 * redacting secret-shaped substrings out of `text` and skipping any whose dedupe key already
 * exists on a prior "ambient" row. Nothing here writes to the vault — `commit_capture` is still
 * the human gate `enqueueCapture` always has.
 *
 * GH #994 follow-up: layered on top of the baseline `redactSecrets` pass (always on, independent
 * of `memoryDefense`), the vault's full `memoryDefense` policy also runs here when configured —
 * `mode: "redact"` additionally applies the PII scan (`pii: true`) `redactSecrets` alone does not
 * cover; `mode: "block"` SKIPS the observation entirely rather than staging a redacted stand-in,
 * matching what `commit_capture`/`enqueue_capture` already do for a block-worthy hit.
 */
export function ingestAmbient(
  db: Database,
  vaultId: string,
  items: readonly CanonicalAmbientObservation[],
  now: number,
  opts: {
    dryRun?: boolean;
    memoryDefense?: VaultMemoryDefenseConfig;
    metrics?: MetricsRecorder;
  } = {},
): IngestAmbientResult {
  const mdConfig = opts.memoryDefense ?? MEMORY_DEFENSE_OFF;
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
  let skipped_secret = 0;
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
    // Security review round: scan every field that lands in the persisted content/title/tags, not
    // just `text` — app/window_title/url/machine are all just as attacker/OCR-controlled.
    let scannedFields: ScannedAmbientFields = {
      text: redactedText,
      app: o.app,
      window_title: o.window_title,
      url: o.url,
      machine: o.machine,
    };
    if (mdConfig.mode !== "off") {
      try {
        const scan = enforceMemoryDefense(
          mdConfig,
          { ...scannedFields },
          { metrics: opts.metrics },
        );
        scannedFields = scan.fields as unknown as ScannedAmbientFields;
        // item 4 audit: `text` here runs over `redactedText` (already baseline-redacted), so a hit
        // the baseline `redactSecrets` pass above already caught cannot be counted twice for that
        // field — its bytes are already "[REDACTED]" and no SECRET_PATTERNS/PII regex matches that
        // literal string. What this DOES catch that the baseline never scans for is a PII hit
        // (`pii: true`), a low-confidence `labeled_secret` redaction, or ANY hit on
        // app/window_title/url/machine — additive, not a double-count.
        redacted += scan.redactions;
      } catch (e) {
        if (e instanceof ObsidianTcError && e.code === "secret_detected") {
          skipped_secret++;
          seen.add(key);
          continue;
        }
        throw e;
      }
    }
    let content = formatCaptureContent(scannedFields, o.captured_at);
    const title = scannedFields.window_title ?? scannedFields.app;
    const tags: string[] = ["ambient", o.source, `machine:${scannedFields.machine}`];
    // Residual fix (findings 1+2, plus a fail-closed follow-up — full rationale in
    // highlight-import.ts's sibling block): the per-field scan above misses a secret split
    // across two fields, which only reassembles once formatCaptureContent concatenates them —
    // sometimes via whitespace `content`'s own rescan bridges, sometimes hidden behind a
    // non-whitespace connector (" — " between app/window_title, parens around a url) that only
    // `contentJoin`'s bare-"\n" reconstruction can see. `title`/`tags` are built from the SAME
    // pre-concatenation pieces `content` is, so they cannot be independently laundered — ANY hit
    // on `contentJoin` therefore refuses the WHOLE item, unconditionally, in every non-off mode,
    // regardless of whether `content`'s own rescan also changed `content` for an unrelated
    // reason (an earlier, narrower version gated the refusal on that and failed open).
    if (mdConfig.mode !== "off") {
      const contentJoin = [
        scannedFields.text,
        scannedFields.app,
        scannedFields.window_title,
        scannedFields.url,
        scannedFields.machine,
      ]
        .filter((s): s is string => !!s)
        .join("\n");
      try {
        const joinScan = enforceMemoryDefense(mdConfig, { content_join: contentJoin });
        if (joinScan.redactions > 0) {
          skipped_secret++;
          seen.add(key);
          continue;
        }
        const rescan = enforceMemoryDefense(mdConfig, { content }, { metrics: opts.metrics });
        content = rescan.fields.content as string;
        redacted += rescan.redactions;
      } catch (e) {
        if (e instanceof ObsidianTcError && e.code === "secret_detected") {
          skipped_secret++;
          seen.add(key);
          continue;
        }
        throw e;
      }
    }
    if (!opts.dryRun) {
      enqueueCapture(db, {
        vaultId,
        content,
        title,
        tags: [...tags, `${AMBIENT_DEDUPE_TAG_PREFIX}${key}`],
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
  return { enqueued, skipped_duplicate, redacted, skipped_secret };
}
