// Read-ACL filtering for bridge-proxied results (D2). Bridge tools (tasks_filter,
// makemd_query, ...) surface data the companion plugin enumerated vault-wide, so
// they must be intersected with the caller's read whitelist. When acl.readPaths is
// DEFINED, every returned item must be attributable to an allowed vault path; an item
// that cannot be attributed FAILS CLOSED (acl_denied) rather than leaking.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { type FolderAcl, globMatch } from "../acl";
import { normalizeVaultPath } from "./paths";

/** True when read enumeration is unrestricted: no ACL, or readPaths undefined and
 *  strictReadDefault off (M0 back-compat). */
export function readEnumerationUnrestricted(acl: FolderAcl | undefined): boolean {
  if (!acl) return true;
  if (acl.readPaths === undefined) return acl.strictReadDefault !== true;
  return false;
}

/** Extract a vault-relative path from a bridge item, or undefined if unattributable. */
export function bridgeItemPath(
  item: unknown,
  keys: readonly string[] = ["path", "note_path", "file", "filePath"],
): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const o = item as Record<string, unknown>;
  for (const k of keys) {
    const val = o[k];
    if (typeof val === "string" && val.length > 0) {
      try {
        return normalizeVaultPath(val);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Does a vault-relative path pass the read whitelist (allow-all when undefined)? */
export function readableRel(acl: FolderAcl | undefined, rel: string): boolean {
  if (!acl || acl.readPaths === undefined) return true;
  return acl.readPaths.some((g) => globMatch(g, rel));
}

/**
 * Filter bridge-returned items by the read ACL. When read enumeration is unrestricted
 * the items are returned unchanged. Otherwise every item MUST be attributable to a
 * vault path; an unattributable item throws acl_denied (fail-closed), and an
 * attributable item is kept only when it passes the read whitelist.
 */
export function filterBridgeItemsByAcl(
  acl: FolderAcl | undefined,
  items: unknown[],
  opts: { tool: string; keys?: readonly string[] },
): unknown[] {
  if (readEnumerationUnrestricted(acl)) return items;
  const out: unknown[] = [];
  for (const it of items) {
    const rel = bridgeItemPath(it, opts.keys);
    if (rel === undefined)
      throw err.aclDenied("bridge result cannot be attributed to a vault path; failing closed", {
        tool: opts.tool,
      });
    if (readableRel(acl, rel)) out.push(it);
  }
  return out;
}
