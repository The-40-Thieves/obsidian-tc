// The read-ACL gate for the capture queue. A capture's content becomes the body of the note it is
// committed to, and its target_path_hint / committed_path name that note, so whether a caller may
// see a capture is whether read_note could read the note it names. Every capture tool reads the
// queue through here and never through capture/queue.ts directly (m5-capture-lookup-guard.test.ts
// pins that): a raw row carries content and paths no matter who is asking.
import {
  type CaptureRow,
  captureCursor,
  getCapture,
  type ListCapturesOptions,
  listCaptures,
} from "../../capture/queue";
import type { CallerContext } from "../../mcp/registry";
import { readableRel, readEnumerationUnrestricted } from "../../vault/acl-read-filter";
import { normalizeVaultPath } from "../../vault/paths";

type ReadCtx = Pick<CallerContext, "acl" | "db" | "grantedScopes">;

// Rows pulled per round trip while a restricted caller's page fills; a hidden run costs rounds,
// never a short page.
const RESTRICTED_BATCH = 200;

/** May this caller see this capture? Every path it names (the note it was committed to, and the
 *  note it was aimed at) must be readable: the content is that note's body, so either one being
 *  hidden hides the capture. A capture naming no path (an unrouted inbox item) is visible, and a
 *  stored path that cannot be normalized FAILS CLOSED. Unrestricted callers (no readPaths, no
 *  strictReadDefault, no rule-scope they lack) short-circuit. `ctx.acl` is the requested vault's
 *  ACL: dispatch's applyVaultAcl swaps it in for every tool whose input names a `vault`. */
export function captureReadable(ctx: ReadCtx, row: CaptureRow): boolean {
  if (readEnumerationUnrestricted(ctx.acl, ctx.grantedScopes)) return true;
  for (const path of [row.committed_path, row.target_path_hint]) {
    if (path === null) continue;
    try {
      if (!readableRel(ctx.acl, normalizeVaultPath(path), ctx.grantedScopes)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The capture with this id in this vault, or undefined when it does not exist, belongs to another
 *  vault, or is one the caller cannot read: the three are indistinguishable by construction. */
export function getReadableCapture(
  ctx: ReadCtx,
  vaultId: string,
  id: string,
): CaptureRow | undefined {
  const row = getCapture(ctx.db, id);
  return row && row.vault_id === vaultId && captureReadable(ctx, row) ? row : undefined;
}

/** One page of the caller's readable captures, newest first. Filtering happens BEFORE the page is
 *  cut, so a page is as full as the readable captures allow, `more` says whether a readable capture
 *  remains past it, and the caller's next_cursor is the cursor of the last readable item returned
 *  (never of a hidden row): the page, the cursor and the totals equal those of a queue that never
 *  held the hidden captures. */
export function listReadableCaptures(
  ctx: ReadCtx,
  vaultId: string,
  opts: Omit<ListCapturesOptions, "limit">,
  limit: number,
): { page: CaptureRow[]; more: boolean } {
  const unrestricted = readEnumerationUnrestricted(ctx.acl, ctx.grantedScopes);
  const batch = unrestricted ? limit + 1 : Math.max(limit + 1, RESTRICTED_BATCH);
  const found: CaptureRow[] = [];
  let afterCursor = opts.afterCursor;
  while (found.length <= limit) {
    const rows = listCaptures(ctx.db, vaultId, { ...opts, afterCursor, limit: batch });
    for (const r of rows) if (captureReadable(ctx, r)) found.push(r);
    const last = rows[rows.length - 1];
    if (rows.length < batch || !last) break;
    afterCursor = captureCursor(last);
  }
  return { page: found.slice(0, limit), more: found.length > limit };
}
