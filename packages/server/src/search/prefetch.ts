// THE-136 — the prewarm cache for vault_context's session-bootstrap mode. The anticipatory
// prefetch (CLI `obsidian-tc prefetch`) composes the bootstrap bundle per vault and writes it
// here; the bootstrap reader takes a cache hit instead of cold-querying. FlowState-QMD lifts,
// hardened: the entry carries a timestamp AND the reader enforces it (FlowState's actual bug
// was a reader that never inspected the timestamp it stored), plus a signal-content hash so an
// edited _next-session.md invalidates immediately. Writes are atomic (tmp + rename, direct-write
// fallback) so no reader ever catches a half-written file — which is also what makes concurrent
// one-shot prefetch runs safe without a single-flight guard (last full write wins).
//
// THE-543: the cache key MUST carry the caller's identity. A bundle is composed under ONE
// caller's ACL (readableRel filtered every result before it was packed); serving it back to a
// DIFFERENT caller without re-checking is a confidentiality leak. Two defences, both required:
//   1. IDENTITY: the ACL fingerprint (acl.ts, THE-496) is part of the filename, so entries for
//      different effective ACLs never share a file and cannot collide. It is ALSO stored as a
//      field and re-validated on read — belt-and-suspenders against a path-construction bug or a
//      copied/renamed cache file, at negligible cost (a string compare).
//   2. STALENESS: the vault generation (generation.ts, THE-496) is stored at write time and
//      re-validated on read, exactly like signal_hash — closes the gap where a source note other
//      than _next-session.md changed or was deleted (the signal hash only covers the session
//      note's text, not the packed sources) and would otherwise be served until the TTL.
// A caller-side re-filter of every path in the bundle (the third, independent defence) lives at
// the call site (knowledge-tools.ts) because only the caller knows the bundle's shape.
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
  /** THE-543: fingerprint of the ACL (+ granted scopes) that produced this bundle. An entry
   *  missing this field predates THE-543 and MUST be treated as a miss, never a match. */
  acl_fingerprint: string;
  /** THE-543: the vault's content generation (readGeneration) at write time. A reader whose
   *  current generation differs refuses the entry — content moved since this bundle was composed. */
  vault_generation: number;
}

/** Write-through TTL when the serve-path bootstrap composes live (the CLI takes --ttl-hours). */
export const DEFAULT_PREFETCH_TTL_MS = 6 * 60 * 60 * 1000;

/** THE-543: stable identity for a caller with no ACL bound (e.g. an unbound trusted context).
 *  Deliberately NOT a valid sha256 hex digest, so it can never collide with a real fingerprint. */
const NO_ACL_FINGERPRINT = "no-acl";

/** THE-543: the caller-identity half of the prewarm cache key. Structural (not `FolderAcl`
 *  itself) so this module does not need to import the ACL types — any object exposing the same
 *  `.fingerprint()` (FolderAcl, acl.ts THE-496) works. */
export function callerAclFingerprint(
  acl: { fingerprint(grantedScopes: Iterable<string>): string } | undefined,
  grantedScopes: Iterable<string>,
): string {
  return acl ? acl.fingerprint(grantedScopes) : NO_ACL_FINGERPRINT;
}

/** THE-543: the ACL fingerprint is embedded in the filename so entries for different callers
 *  cannot collide at all — a mismatched principal reads a different, nonexistent file (an
 *  ordinary miss), never another principal's file. */
export function prewarmPathFor(cacheDir: string, vaultId: string, aclFingerprint: string): string {
  return join(cacheDir, `prewarm-${vaultId}-${aclFingerprint}.json`);
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

/** TTL-, signal-hash-, ACL-fingerprint-, and generation-enforcing reader. Expired, mismatched,
 *  stale, or malformed -> null (miss). THE-543: acl_fingerprint and vault_generation are checked
 *  with the same fail-closed `!==` shape as signal_hash — an entry missing either field (every
 *  pre-THE-543 entry) has `typeof !== "string"/"number"` and is refused, never trusted as a match. */
export function readPrewarm(
  file: string,
  opts: { nowMs: number; signalHash: string; aclFingerprint: string; vaultGeneration: number },
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
    if (typeof e.acl_fingerprint !== "string" || e.acl_fingerprint !== opts.aclFingerprint)
      return null;
    if (typeof e.vault_generation !== "number" || e.vault_generation !== opts.vaultGeneration)
      return null;
    return e;
  } catch {
    return null;
  }
}
