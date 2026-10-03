// A HITL confirmation approves what the human was shown, and args_hash only pins the arguments —
// not what those arguments pointed at. Without a state binding, a token or requestState minted for
// "overwrite this note as it is now" stays good for its whole TTL against a note somebody has since
// rewritten. This module fingerprints the state a call targets so redemption can refuse a
// confirmation whose target moved (`replay_drift`), and it does so ONCE, on the shared paths every
// HITL-gated tool already funnels through: dispatch's `checkHitl`, vault/hitl.ts's
// `requireConfirmation`, and `verifyAndConsumeElicit`/`hitlSatisfiedByState` beneath them.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { argsHash } from "./hash";
import { normalizeVaultPath, resolveVaultPath } from "./vault/paths";

/** Computes the CURRENT fingerprint of a call's targets, or null when there is nothing to bind
 *  (the tool declares no target paths, or no vault root is wired). It THROWS when the targets cannot
 *  be fingerprinted (a path the folder ACL denies, an unreadable repo): callers must let that
 *  refuse the call, never read it as "nothing to bind". */
export type StateProbe = () => string | null;

/** Above this a file is fingerprinted by size + mtime + inode rather than read: a confirmation on a
 *  large attachment must not cost a synchronous multi-hundred-megabyte read on the dispatch path. */
const MAX_HASHED_BYTES = 16 * 1024 * 1024;

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** A target whose state cannot be read cannot be bound: any stable stand-in (a sentinel hash, a
 *  partial stat) would let the file change under a confirmation and still compare equal. Refuse
 *  instead — `confirmationStateProbe` lets this surface, so no unbound request is ever recorded. */
function unfingerprintable(why: string, e: unknown): Error {
  const code = (e as NodeJS.ErrnoException).code ?? "unknown";
  return err.internalError(
    `cannot fingerprint a confirmation target (${why}: ${code}); refusing to issue an unbound approval`,
  );
}

/** One target's state. Mixes size/mtime/inode into the content hash on purpose: the fingerprint
 *  travels to the client (in `elicit_required`'s details and the signed requestState), and a bare
 *  content hash would let a caller confirm a guess at a note it may write but not read. THROWS when
 *  the target exists but cannot be read (see `unfingerprintable`). */
function entryState(abs: string): string {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    throw unfingerprintable("stat failed", e);
  }
  const meta = `${st.size}:${st.mtimeMs}:${st.ino}`;
  try {
    if (st.isDirectory()) {
      const listing = readdirSync(abs, { withFileTypes: true })
        .map((d) => d.name)
        .sort();
      return `dir:${sha256(listing.join("\n"))}:${meta}`;
    }
    if (!st.isFile()) return `other:${meta}`;
    if (st.size > MAX_HASHED_BYTES) return `big:${meta}`;
    return `file:${sha256(readFileSync(abs))}:${meta}`;
  } catch (e) {
    throw unfingerprintable("read failed", e);
  }
}

/** Fingerprint the given vault-relative paths: a missing path is a state ("absent"), so a note
 *  created between request and redemption is drift too. Null for an empty target set. Throws when a
 *  target is unreadable or unresolvable — never a stable stand-in hash. */
export function fingerprintTargets(root: string, relPaths: readonly string[]): string | null {
  if (relPaths.length === 0) return null;
  const states: Record<string, string> = {};
  for (const rel of relPaths) {
    let key: string;
    let abs: string;
    try {
      key = normalizeVaultPath(rel);
      abs = resolveVaultPath(root, key);
    } catch (e) {
      throw unfingerprintable("path not resolvable", e);
    }
    states[key] = entryState(abs);
  }
  return argsHash("state", states);
}

// The handler-side gates (vault/hitl.ts's requireConfirmation) run inside the tool handler, which
// has no handle on its own definition. Dispatch scopes the probe for the call it is running to the
// handler's async context — a CallerContext field would be shared mutable state between concurrent
// dispatches, and a wrong probe here would mean a wrong verdict on somebody else's confirmation.
const frame = new AsyncLocalStorage<StateProbe>();

export function withStateProbe<T>(probe: StateProbe, fn: () => T): T {
  return frame.run(probe, fn);
}

/** The probe of the dispatch this code is running under, or undefined outside one. */
export function activeStateProbe(): StateProbe | undefined {
  return frame.getStore();
}

/**
 * The single drift verdict. `issued` is the fingerprint bound to the confirmation (token column or
 * signed state); undefined/null means it was never bound and there is nothing to compare. A bound
 * confirmation with no way to recompute the current state fails closed as drift — verifying nothing
 * must never read as "unchanged".
 */
export function assertNoReplayDrift(
  issued: string | null | undefined,
  current: StateProbe | undefined,
  details: { tool?: string; args_hash?: string },
): void {
  if (issued === null || issued === undefined) return;
  if (current?.() === issued) return;
  throw err.replayDrift(undefined, details);
}
