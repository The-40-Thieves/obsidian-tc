// Write provenance: the record shape and the one request `_meta` key a client may use to describe
// itself. Every attribution field lives in exactly one of three groups, so a reader never has to
// guess how far to trust it:
//
//   verified          the SERVER established it: the host, its own version, the transport, and —
//                     only when a bearer token was cryptographically verified — the principal and
//                     persona that token carried. A client cannot influence these.
//   unauthenticated   a caller label the server saw but nobody proved (stdio's local operator, or
//                     `auth.mode: none`). Kept apart from `verified` so it cannot pass for it.
//   self_reported     whatever the client said about itself (MCP clientInfo, the
//                     `io.obsidian-tc/provenance` _meta block). A client can lie; nothing here is
//                     checked.
//
// Hashes only, ever: the record carries sha256 digests of note bytes, never content or prompts.
import { cleanMetaString } from "../mcp/client-info";

/** Request `_meta` key a client may set to say which model/project/agent/machine is calling. */
export const PROVENANCE_META_KEY = "io.obsidian-tc/provenance";

export const RECORD_VERSION = 1;
export const GENESIS_HASH = "0".repeat(64);
/** `event_log.event_type` of a recording fault (an omitted record, or a head that failed validation). */
export const PROVENANCE_FAULT_EVENT = "provenance_fault";

/** A sha256 hex digest, or `absent` (no file there) or `unhashable` (directory, symlink, too big
 *  or unreadable). Never a guess: a digest is either the file's bytes or one of these two words. */
export type Digest = string;
export const DIGEST_ABSENT = "absent";
export const DIGEST_UNHASHABLE = "unhashable";

export interface PathEntry {
  path: string;
  before: Digest;
  after: Digest;
}

export interface ClaimedProvenance {
  model?: string;
  project?: string;
  agent?: string;
  machine?: string;
}

export interface ProvenanceBody {
  v: typeof RECORD_VERSION;
  vault: string;
  seq: number;
  ts: number;
  prev: string;
  tool: string;
  /** `ok`: the call succeeded. `error`: the call failed but a named path changed anyway.
   *  `pending`: written by a multi-note commit BEFORE its first rename, with the digests it is about
   *  to write as `after`. A `pending` record with no `ok` / `error` record after it for the same
   *  call means the process died mid-commit: compare each path's `after` with the disk. */
  outcome: "ok" | "error" | "pending";
  paths: PathEntry[];
  /** Paths the call named beyond the per-record cap; counted, not listed. */
  paths_omitted: number;
  verified: {
    host: string;
    server_version: string;
    transport?: "stdio" | "http";
    principal?: string;
    persona?: string;
    session_id?: string;
  };
  unauthenticated: { principal?: string };
  self_reported: ClaimedProvenance & { client?: { name: string; version?: string } };
  /** Present only on a record written while the chain head FAILED validation (store.ts
   *  `checkHead`): the server kept appending, but refused to sign the head over it. `verify`
   *  reports every such record, and `--allow-unsigned` does not hide it. */
  integrity?: { head_fault: string };
}

const CLAIMED_KEYS = ["model", "project", "agent", "machine"] as const;

/**
 * Lift the claimed model/project/agent/machine out of a request `_meta` bag. Untrusted input, same
 * discipline as client-info.ts: strings only, bounded, dropped rather than truncated, absent is
 * normal. Takes several bags (first one carrying a usable block wins). Returns undefined when
 * nothing usable is present.
 */
export function extractClaimedProvenance(...bags: unknown[]): ClaimedProvenance | undefined {
  for (const meta of bags) {
    if (meta === null || typeof meta !== "object") continue;
    const raw = (meta as Record<string, unknown>)[PROVENANCE_META_KEY];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const out: ClaimedProvenance = {};
    for (const key of CLAIMED_KEYS) {
      const v = cleanMetaString((raw as Record<string, unknown>)[key]);
      if (v !== undefined) out[key] = v;
    }
    if (Object.keys(out).length > 0) return out;
  }
  return undefined;
}
