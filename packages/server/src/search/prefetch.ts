// THE-136 — the prewarm cache for vault_context's session-bootstrap mode. The anticipatory
// prefetch (CLI `obsidian-tc prefetch`) composes the bootstrap bundle per vault and writes it
// here; the bootstrap reader takes a cache hit instead of cold-querying. FlowState-QMD lifts,
// hardened: the entry carries a timestamp AND the reader enforces it (FlowState's actual bug
// was a reader that never inspected the timestamp it stored), plus a signal-content hash so an
// edited _next-session.md invalidates immediately. Writes are atomic (tmp + rename, direct-write
// fallback) so no reader ever catches a half-written file — which is also what makes concurrent
// one-shot prefetch runs safe without a single-flight guard (last full write wins).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PrewarmEntry {
  generated_at: number;
  expires_at: number;
  /** Vault-relative path of the signal note the bundle was composed from. */
  signal: string;
  /** Hash of the effective query text — mismatch means the note changed; refuse the entry. */
  signal_hash: string;
  /** THE-136 floor: a prefetch that packs nothing writes an empty marker, not a wrong bundle. */
  empty: boolean;
  bundle?: Record<string, unknown>;
}

/** Write-through TTL when the serve-path bootstrap composes live (the CLI takes --ttl-hours). */
export const DEFAULT_PREFETCH_TTL_MS = 6 * 60 * 60 * 1000;

export function prewarmPathFor(cacheDir: string, vaultId: string): string {
  return join(cacheDir, `prewarm-${vaultId}.json`);
}

/** Atomic write: tmp + rename, direct-write fallback. */
export function writePrewarm(file: string, entry: PrewarmEntry): void {
  mkdirSync(dirname(file), { recursive: true });
  const data = JSON.stringify(entry);
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    writeFileSync(file, data);
  }
}

/** TTL- and signal-hash-enforcing reader. Expired, mismatched, or malformed -> null (miss). */
export function readPrewarm(
  file: string,
  opts: { nowMs: number; signalHash: string },
): PrewarmEntry | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const e = JSON.parse(raw) as PrewarmEntry;
    if (typeof e.expires_at !== "number" || e.expires_at <= opts.nowMs) return null;
    if (e.signal_hash !== opts.signalHash) return null;
    if (typeof e.empty !== "boolean") return null;
    return e;
  } catch {
    return null;
  }
}
