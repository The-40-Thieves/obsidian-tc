// THE-891 item 2 — one-time boot notice for `experiential.captureContent`.
//
// Every accepted local-persistence precedent (VS Code's Local History, JetBrains' Local History,
// Go's telemetry-in-local-mode) ships the SAME three-part mitigation set for a capture feature
// that defaults on: bounded retention (captureRetentionDays, THE-891 item 1), a visible notice
// naming what is captured / where it lives / how to turn it off (this file), and a guard against
// the content silently leaving the machine through a channel the operator did not choose
// (doctor's `experiential.capture-location` check, THE-891 item 3). This file is the second leg —
// see retrieval.schema.ts's `captureContent` comment for the full precedent argument.
//
// PER-INSTALL, not per-boot. Contrast with plane-opt-in-notice.ts (THE-825), which deliberately
// nags on EVERY boot with no marker — there, the absence of `plane.enabled` is itself the fact
// worth restating each time (a config that says nothing keeps meaning something different from
// what the operator may expect). Capture is not that shape: once an operator has seen this
// notice, repeating it on every restart trains "skip the boot banner", which is the opposite of
// what a security-relevant notice is for. So this fires once per cacheDir, tracked with a marker
// file — not a DB row, since a small regenerable marker beside cache.db/experiential.db is the
// same idiom search/prefetch.ts already uses for cacheDir-resident state, and adding one avoids a
// schema migration for a single boolean fact.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Marker file recording that the notice has already fired for this cacheDir (i.e. this
 *  install — cacheDir is the one place that is per-machine rather than per-vault or per-repo). */
export function captureNoticeMarkerPath(cacheDir: string): string {
  return join(cacheDir, "capture-notice-shown");
}

/** Has the notice already fired for this install? Read-only; never creates cacheDir. */
export function captureNoticeAlreadyShown(cacheDir: string): boolean {
  return existsSync(captureNoticeMarkerPath(cacheDir));
}

/** Record that the notice fired, so the NEXT boot skips it. Best-effort: cacheDir is mkdir'd by
 *  runtime/stores.ts before this ever runs, but a write can still fail (read-only filesystem, a
 *  permissions race) — that must not crash boot over a cosmetic marker. The safe failure
 *  direction is "the notice repeats next boot", not "boot dies because a marker could not be
 *  written". */
export function markCaptureNoticeShown(cacheDir: string): void {
  try {
    writeFileSync(captureNoticeMarkerPath(cacheDir), `${new Date().toISOString()}\n`);
  } catch {
    /* best-effort marker; a failed write just means the notice repeats next boot */
  }
}

/**
 * Format the one-time boot line. Pure function, same shape as formatPlaneOptInNotice (THE-825),
 * so the gating logic is assertable without touching the filesystem or booting a real runtime.
 *
 * Fires only when captureContent is actually on (nothing to disclose otherwise) AND the marker
 * has not already been written for this cacheDir.
 */
export function formatCaptureFirstRunNotice(deps: {
  captureContent: boolean;
  alreadyShown: boolean;
  cacheDir: string;
  retentionDays: number;
}): string | null {
  if (!deps.captureContent || deps.alreadyShown) return null;
  const retention =
    deps.retentionDays === 0 ? "unlimited (captureRetentionDays: 0)" : `${deps.retentionDays} days`;
  return (
    "[experiential] capture is ON: tool-call content is stored locally at " +
    `${deps.cacheDir}, never transmitted; retention ${retention}; disable with ` +
    'experiential.captureContent=false or securityProfile="hardened".\n'
  );
}

/** The side-effecting wrapper server-runtime.ts's `start()` actually calls: reads the marker,
 *  formats the line, writes it to stderr, and records the marker — all in one call so the boot
 *  path stays a single line (server-runtime.ts sits against biome's 700-line ceiling; the
 *  testable pieces above stay pure and unit-tested on their own). */
export function emitCaptureFirstRunNotice(deps: {
  captureContent: boolean;
  cacheDir: string;
  retentionDays: number;
}): void {
  const notice = formatCaptureFirstRunNotice({
    ...deps,
    alreadyShown: captureNoticeAlreadyShown(deps.cacheDir),
  });
  if (!notice) return;
  process.stderr.write(notice);
  markCaptureNoticeShown(deps.cacheDir);
}
