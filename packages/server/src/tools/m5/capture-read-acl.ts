// The read-ACL gate for the capture queue. A capture's content becomes the body of the note it is
// committed to, and its target_path_hint / committed_path name that note, so whether a caller may
// see a capture is whether read_note could read the note it names, decided by the SAME predicate
// read_note's path check is (callerCanReadVaultPath: hard-denied roots, readPaths, rule-scopes,
// symlink and hard-link resolution on the bound vault root). Every capture tool reads the queue
// through here and never through capture/queue.ts directly (m5-capture-lookup-guard.test.ts pins
// that): a raw row carries content and paths no matter who is asking.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  type CaptureRow,
  captureCursor,
  getCapture,
  type ListCapturesOptions,
  listCaptures,
} from "../../capture/queue";
import type { CallerContext } from "../../mcp/registry";
import { callerCanReadVaultPath } from "../../vault/acl-path";
import { readEnumerationUnrestricted } from "../../vault/acl-read-filter";

type ReadCtx = Pick<CallerContext, "acl" | "db" | "grantedScopes">;

// Rows pulled per round trip while a page fills; a hidden run costs rounds, never a short page.
const SCAN_BATCH = 200;

/** Most rows one request examines. A hidden row costs a filesystem resolution, so an attacker who
 *  can grow the queue with captures aimed at hidden notes must not be able to amplify the work of
 *  every list call: past this the page so far is returned with a cursor that resumes the scan.
 *  RESIDUAL (documented in security/acls.md): the number of rounds a caller needs to walk a queue
 *  still depends on how many captures it cannot see, so hidden volume is observable as latency and
 *  as the count of empty continuation pages. It never reveals a hidden row's content, path or id. */
export const MAX_ROWS_EXAMINED = 1000;

// A continuation that stops on a hidden row must not name it (its id and timestamp are what the
// caller cannot see), so that cursor is sealed under a per-process key: opaque to the caller,
// meaningless after a restart (a stale one reads as an exhausted queue).
const SEALED = "s1.";
const cursorKey = randomBytes(32);

function sealCursor(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cursorKey, iv, { authTagLength: 16 });
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return SEALED + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

function unsealCursor(token: string): string | undefined {
  try {
    const raw = Buffer.from(token.slice(SEALED.length), "base64url");
    const d = createDecipheriv("aes-256-gcm", cursorKey, raw.subarray(0, 12), {
      authTagLength: 16,
    });
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** May this caller see this capture? Every path it names (the note it was committed to, and the
 *  note it was aimed at) must be readable by callerCanReadVaultPath on the vault's bound `root`:
 *  the content is that note's body, so either one being hidden hides the capture. A capture naming
 *  no path (an unrouted inbox item) is visible, and a stored path that cannot be resolved (invalid,
 *  `..`, hard-denied root, through a symlink out of bounds, hard-linked) FAILS CLOSED. There is no
 *  fast path for an "unrestricted" ACL: that is exactly how a hard-denied root leaked. `ctx.acl` is
 *  the requested vault's ACL: dispatch's applyVaultAcl swaps it in for every tool whose input names
 *  a `vault`. */
export function captureReadable(ctx: ReadCtx, root: string, row: CaptureRow): boolean {
  for (const path of [row.committed_path, row.target_path_hint])
    if (path !== null && !callerCanReadVaultPath(ctx.acl, ctx.grantedScopes, root, path))
      return false;
  return true;
}

/** The capture with this id in this vault, or undefined when it does not exist, belongs to another
 *  vault, or is one the caller cannot read: the three are indistinguishable by construction. */
export function getReadableCapture(
  ctx: ReadCtx,
  vault: { id: string; root: string },
  id: string,
): CaptureRow | undefined {
  const row = getCapture(ctx.db, id);
  return row && row.vault_id === vault.id && captureReadable(ctx, vault.root, row)
    ? row
    : undefined;
}

/** One page of the caller's readable captures, newest first. Filtering happens BEFORE the page is
 *  cut, so a page is as full as the readable captures allow and `more` says whether the queue
 *  continues past it. `nextCursor` is the cursor of the last readable item returned (never of a
 *  hidden row), unless the per-request scan bound was hit first: then the page is whatever was
 *  found, possibly empty, and the cursor is sealed (see above). Below the bound the page, cursor
 *  and totals equal those of a queue that never held the hidden captures. */
export function listReadableCaptures(
  ctx: ReadCtx,
  vault: { id: string; root: string },
  opts: Omit<ListCapturesOptions, "limit">,
  limit: number,
  maxExamined = MAX_ROWS_EXAMINED,
): { page: CaptureRow[]; more: boolean; nextCursor: string | null } {
  let afterCursor = opts.afterCursor;
  if (afterCursor?.startsWith(SEALED)) {
    afterCursor = unsealCursor(afterCursor);
    if (afterCursor === undefined) return { page: [], more: false, nextCursor: null };
  }
  const unrestricted = readEnumerationUnrestricted(ctx.acl, ctx.grantedScopes);
  const batch = unrestricted ? limit + 1 : Math.max(limit + 1, SCAN_BATCH);
  const found: CaptureRow[] = [];
  let examined = 0;
  let lastExamined: CaptureRow | undefined;
  while (found.length <= limit) {
    const take = Math.min(batch, maxExamined - examined);
    if (take <= 0) break;
    const rows = listCaptures(ctx.db, vault.id, { ...opts, afterCursor, limit: take });
    for (const r of rows) if (captureReadable(ctx, vault.root, r)) found.push(r);
    examined += rows.length;
    lastExamined = rows[rows.length - 1];
    if (rows.length < take || !lastExamined) return finish(found, limit, found.length > limit);
    afterCursor = captureCursor(lastExamined);
  }
  if (found.length > limit) return finish(found, limit, true);
  // Bound hit with the queue unfinished: resume after the last row EXAMINED.
  const page = found.slice(0, limit);
  const last = page[page.length - 1];
  const resume = lastExamined ? captureCursor(lastExamined) : undefined;
  return {
    page,
    more: true,
    nextCursor: resume === undefined ? null : last === lastExamined ? resume : sealCursor(resume),
  };
}

function finish(
  found: CaptureRow[],
  limit: number,
  more: boolean,
): { page: CaptureRow[]; more: boolean; nextCursor: string | null } {
  const page = found.slice(0, limit);
  const last = page[page.length - 1];
  return { page, more, nextCursor: more && last ? captureCursor(last) : null };
}
