// Read-gated compare-and-swap detail, shared by every tool that refuses a stale prev_hash or acks a
// write. A write-only caller (it may write a file but not read it) must not learn that file's hash:
// the hash of low-entropy content is a guessing oracle. So the current hash is echoed in a refusal,
// and the prior hash / quality warning in an ack, only to a caller that may read the file. Every
// `concurrentModification(` in the server goes through casConflict; the source-scan gate in
// test/cas-source-gate.test.ts keeps it that way.
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

/** The CAS refusal. `current` is the file's hash now; it is echoed as `actual` only when the caller
 *  may read the file. Omit `current` when the refusal never had a hash to report. */
export function casConflict(
  message: string,
  details: Record<string, unknown>,
  current?: { hash: string; mayRead: boolean },
) {
  return err.concurrentModification(message, {
    ...details,
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
