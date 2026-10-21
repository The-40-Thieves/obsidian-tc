// Read-gated compare-and-swap detail, shared by every tool that refuses a stale prev_hash or acks a
// write. A write-only caller (it may write a file but not read it) must not learn that file's bytes:
// a hash of low-entropy content is a guessing oracle, and so is a refusal that depends on the bytes.
// So a caller that may not read a file gets only content-blind writes: any operation whose outcome
// depends on the file's content, and any prev_hash it supplies, is refused up front with one fixed
// error (requireContentRead / checkCas). The current hash is echoed in a refusal, and the prior hash
// / quality warning in an ack, only to a caller that may read the file. Every `concurrentModification(`
// in the server goes through casConflict; the source-scan gate in test/cas-source-gate.test.ts keeps
// it that way.
import { err, grantsAll } from "@the-40-thieves/obsidian-tc-shared";
import type { FolderAcl } from "../acl";
import { callerCanReadVaultPath } from "./acl-path";

/** The caller fields a read decision needs; structural so a vault-layer module takes no mcp import. */
interface ReadCaller {
  acl?: FolderAcl;
  grantedScopes: Iterable<string>;
}

/** May the caller read this file's bytes? Needs the kind's read scope AND the path ACL. */
export function callerMayReadFile(
  ctx: ReadCaller,
  root: string,
  rel: string,
  readScope: string,
): boolean {
  return (
    grantsAll(ctx.grantedScopes, [readScope]) &&
    callerCanReadVaultPath(ctx.acl, ctx.grantedScopes, root, rel)
  );
}

/** A note, including a kanban board or a table: read:notes. */
export function callerMayReadNote(ctx: ReadCaller, root: string, rel: string): boolean {
  return callerMayReadFile(ctx, root, rel, "read:notes");
}

/** The refusal for a caller who may not read the file, whatever the file holds: fixed text, and the
 *  details carry only the path. */
const CONTENT_READ_REQUIRED = "this operation needs read access to the target";

/** Refuses a caller who may not read `rel` before any work that depends on its bytes. */
export function requireContentRead(
  ctx: ReadCaller,
  root: string,
  rel: string,
  readScope = "read:notes",
): void {
  if (!callerMayReadFile(ctx, root, rel, readScope))
    throw err.invalidInput(CONTENT_READ_REQUIRED, { path: rel });
}

/** One prev_hash check: the read decision first (a non-reader is refused before anything is
 *  compared, so the outcome cannot tell a match from a miss), then the compare. */
export interface CasCheck {
  ctx: ReadCaller;
  root: string;
  rel: string;
  /** The read scope the file's kind needs; read:notes for a note. */
  readScope?: string;
  prevHash: string | undefined;
  /** null when the file does not exist yet (bookmarks.json and workspaces.json may not). */
  currentHash: string | null;
  message: string;
  /** false: the conflict names the path only (bookmarks.json and workspaces.json never echoed a hash). */
  echoCurrent?: boolean;
}

export function checkCas(check: CasCheck): void {
  if (check.prevHash === undefined) return;
  const mayRead = callerMayReadFile(
    check.ctx,
    check.root,
    check.rel,
    check.readScope ?? "read:notes",
  );
  if (!mayRead) throw err.invalidInput(CONTENT_READ_REQUIRED, { path: check.rel });
  if (check.prevHash === check.currentHash) return;
  throw casConflict(
    check.message,
    { path: check.rel, expected: check.prevHash },
    check.echoCurrent === false || check.currentHash === null
      ? undefined
      : { hash: check.currentHash, mayRead },
  );
}

/** The CAS refusal. `current` is the file's hash now; it is echoed as `actual` only when the caller
 *  may read the file. Omit `current` when the refusal never had a hash to report. The details a
 *  caller built are withheld too (`actual`, `expected`) unless the caller may read the file. */
export function casConflict(
  message: string,
  details: Record<string, unknown>,
  current?: { hash: string; mayRead: boolean },
) {
  const mayRead = current?.mayRead === true;
  const { actual: _actual, expected: _expected, ...withheld } = details;
  return err.concurrentModification(message, {
    ...(mayRead ? details : withheld),
    ...(current?.mayRead ? { actual: current.hash } : {}),
  });
}

/** A write ack's prev_hash and quality_warning describe the file's prior bytes: a caller that may not
 *  read the file gets neither key (not a null that would pass for "no prior state"). */
export function readGatedAck<T extends object>(ack: T, mayRead: boolean): T {
  if (mayRead) return ack;
  const {
    prev_hash: _prev,
    quality_warning: _quality,
    ...rest
  } = ack as T & {
    prev_hash?: unknown;
    quality_warning?: unknown;
  };
  return rest as T;
}
