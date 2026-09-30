// Read-ACL filtering for bridge-proxied results (D2). Bridge tools (tasks_filter,
// makemd_query, ...) surface data the companion plugin enumerated vault-wide, so
// they must be intersected with the caller's read whitelist. When acl.readPaths is
// DEFINED, every returned item must be attributable to an allowed vault path; an item
// that cannot be attributed FAILS CLOSED (acl_denied) rather than leaking.
import { err, grantsAll } from "@the-40-thieves/obsidian-tc-shared";
import { type FolderAcl, isDefaultDenied } from "../acl";
import { pathScopesSatisfied } from "./acl-path";
import { normalizeVaultPath } from "./paths";

/** True when read enumeration is unrestricted FOR THIS CALLER: no ACL, or readPaths undefined and
 *  strictReadDefault off (M0 back-compat), and no path can declare a rule-scope the caller lacks.
 *  `grantedScopes` is required (no default) for the reason `readableRel`'s is: a caller that forgets
 *  it must fail to compile, not silently treat a rule-scoped vault as open. Conservative by design —
 *  a caller missing ANY declared scope is "restricted" even if no path it can reach declares it. */
export function readEnumerationUnrestricted(
  acl: FolderAcl | undefined,
  grantedScopes: Iterable<string>,
): boolean {
  if (!acl) return true;
  if (acl.declaresPathScopes && !grantsAll(grantedScopes, acl.declaredScopes)) return false;
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
        // An invalid value for this key (e.g. a traversal attempt) — keep trying the
        // remaining keys before treating the item as unattributable.
      }
    }
  }
  return undefined;
}

/**
 * THE read predicate for result filtering: may this caller read this vault-relative path? It is the
 * lexical half of what read_note / read_notes enforce (`enforcePathAcl(acl, "read", ...)`): the hard
 * default-deny roots, the folder whitelist (readPaths / strictReadDefault), AND the path's
 * rule-scopes against the caller's granted scopes. Every search, enumeration and graph surface
 * filters its results with this, so a note read_notes refuses can never be named by a result.
 *
 * `grantedScopes` is REQUIRED, deliberately. This function used to take only the ACL, so every
 * caller silently enforced the folder whitelist and none enforced rule-scopes; an optional or
 * defaulted parameter would let the next caller reintroduce exactly that.
 */
export function readableRel(
  acl: FolderAcl | undefined,
  rel: string,
  grantedScopes: Iterable<string>,
): boolean {
  return readableByFolder(acl, rel) && pathScopesSatisfied(acl, rel, grantedScopes);
}

/**
 * The CALLER-INDEPENDENT half of `readableRel`: the hard default-deny roots and the folder
 * whitelist, with no rule-scopes. This is what INDEXING may use, because the index is a shared
 * store: a rule-scope is a property of who is asking, so a caller lacking a scope who triggers
 * `index_vault` must not omit or evict chunks that a caller holding it is entitled to search.
 * Result filtering must never use this; it uses `readableRel`.
 */
export function readableByFolder(acl: FolderAcl | undefined, rel: string): boolean {
  if (!acl) return true;
  if (isDefaultDenied(rel)) return false;
  // THE-618: match against the ACL's precompiled read whitelist. This runs per bridge item and per
  // note during index-time read filtering (THE-453); the previous form allocated a defensive copy
  // of readPaths per call and re-normalized `rel` once per glob in it.
  const matched = acl.matchedPathGlob("read", rel);
  if (matched === undefined) return acl.strictReadDefault !== true;
  return matched !== null;
}

/**
 * Filter bridge-returned items by the read ACL. When read enumeration is unrestricted
 * the items are returned unchanged. Otherwise every item MUST be attributable to a
 * vault path; an unattributable item throws acl_denied (fail-closed), and an
 * attributable item is kept only when it passes the read whitelist.
 */
export function filterBridgeItemsByAcl(
  acl: FolderAcl | undefined,
  grantedScopes: Iterable<string>,
  items: unknown[],
  opts: { tool: string; keys?: readonly string[] },
): unknown[] {
  if (readEnumerationUnrestricted(acl, grantedScopes)) return items;
  const out: unknown[] = [];
  for (const it of items) {
    const rel = bridgeItemPath(it, opts.keys);
    if (rel === undefined)
      throw err.aclDenied("bridge result cannot be attributed to a vault path; failing closed", {
        tool: opts.tool,
      });
    if (readableRel(acl, rel, grantedScopes)) out.push(it);
  }
  return out;
}
