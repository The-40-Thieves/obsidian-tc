// Read-ACL filtering for bridge-proxied results (D2). Bridge tools (tasks_filter,
// makemd_query, ...) surface data the companion plugin enumerated vault-wide, so
// they must be intersected with the caller's read whitelist. When acl.readPaths is
// DEFINED, every returned item must be attributable to an allowed vault path; an item
// that cannot be attributed FAILS CLOSED (acl_denied) rather than leaking.
import { err, grantsAll } from "@the-40-thieves/obsidian-tc-shared";
import { type FolderAcl, isDefaultDenied } from "../acl";
import { pathScopesSatisfied } from "./acl-path";
import { normalizeVaultPath, resolveVaultPathChecked, type WalkEntry } from "./paths";

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

/** A readability predicate a walk-driven scan is handed. The second argument is the entry's ACL
 *  identity (`WalkEntry.aclRel`); a predicate that decides on the path judges THAT, and falls back to
 *  `rel` when it is called with one argument (a stored row's path, where the two are the same). */
export type WalkReadable = (rel: string, aclRel?: string) => boolean;

/**
 * The read predicate for an entry a vault WALK produced. It is judged on `aclRel`, the entry's
 * symlink-resolved identity, never on `relPath` (the display name): `wiki -> private` lists
 * `wiki/x.md`, a name no whitelist entry for `private/` covers and one `read_note` refuses, so a
 * filter on the name would show a file the caller cannot read. For an entry of a walk that did not
 * start through a symlink the two are equal. Every filter over `walkVault` / `walkVaultStream`
 * output uses this (or hands `aclRel` to `readableRel` / `readableByFolder`).
 */
export function readableEntry(
  acl: FolderAcl | undefined,
  entry: Pick<WalkEntry, "aclRel">,
  grantedScopes: Iterable<string>,
): boolean {
  return readableRel(acl, entry.aclRel, grantedScopes);
}

/**
 * `readableRel` for a vault-relative path that was NOT produced by a walk (a path the caller named,
 * or one a stored row or a config derives): resolved to its ACL identity first, exactly as
 * `enforcePathAcl` does, so an alias is judged by its target. A path that cannot be resolved FAILS
 * CLOSED (not readable).
 */
export function readableResolved(
  acl: FolderAcl | undefined,
  root: string,
  rel: string,
  grantedScopes: Iterable<string>,
): boolean {
  let aclRel: string;
  try {
    aclRel = resolveVaultPathChecked(root, rel).aclRel;
  } catch {
    return false;
  }
  return readableRel(acl, aclRel, grantedScopes);
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
 * attributable item is kept only when its CANONICAL target passes the read whitelist
 * (`readableResolved`): the plugin names the display path, so `wiki/x.md` under
 * `wiki -> private` is judged as `private/x.md`, as read_note judges it. A path that cannot
 * be resolved (dangling link, outside the vault) is dropped.
 */
export function filterBridgeItemsByAcl(
  acl: FolderAcl | undefined,
  root: string,
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
    if (readableResolved(acl, root, rel, grantedScopes)) out.push(it);
  }
  return out;
}

/**
 * Filter a bridge result shaped `{ items: [...], total, ... }` (Datacore, Omnisearch). Unrestricted
 * callers get the result untouched. Otherwise the rows are filtered by note path (fail closed on an
 * unattributable row), `total` is recounted, and every sibling field is DROPPED: they are computed
 * over the unfiltered set by the plugin and can carry a hidden note's path or text (THE-270).
 */
export function filterBridgeResultItems(
  acl: FolderAcl | undefined,
  root: string,
  grantedScopes: Iterable<string>,
  result: Record<string, unknown>,
  opts: { tool: string; keys?: readonly string[] },
): Record<string, unknown> {
  if (readEnumerationUnrestricted(acl, grantedScopes)) return result;
  const rows = Array.isArray(result.items) ? (result.items as unknown[]) : [];
  const items = filterBridgeItemsByAcl(acl, root, grantedScopes, rows, opts);
  return { items, total: items.length };
}

/**
 * Gate a bridge result that names exactly one vault path (resolve_daily_note): the caller must be
 * able to read it, exactly as read_note would require (the canonical target, `readableResolved`).
 * An unattributable or unresolvable path fails closed for a restricted caller.
 */
export function assertBridgePathReadable(
  acl: FolderAcl | undefined,
  root: string,
  grantedScopes: Iterable<string>,
  result: unknown,
  opts: { tool: string },
): void {
  const rel = bridgeItemPath(result);
  const readable =
    rel === undefined
      ? readEnumerationUnrestricted(acl, grantedScopes)
      : readableResolved(acl, root, rel, grantedScopes);
  if (!readable) throw err.aclDenied("path is not readable by this caller", { tool: opts.tool });
}

/**
 * Unrestricted read for this caller on its own ACL AND on every vault it can see (all of `vaultIds`,
 * or just its own for a vault-bound caller). Gates state counted or worded over the SHARED index,
 * which holds notes a read rule hides. `aclFor` absent -> the caller's `ctx.acl` stands in.
 */
export function readUnrestrictedOnEveryVault(
  ctx: { acl?: FolderAcl; grantedScopes: Iterable<string>; vaultBound?: boolean; vaultId: string },
  vaultIds: readonly string[],
  aclFor: ((vaultId: string) => FolderAcl | undefined) | undefined,
): boolean {
  const visible = ctx.vaultBound === true ? [ctx.vaultId] : vaultIds;
  return (
    readEnumerationUnrestricted(ctx.acl, ctx.grantedScopes) &&
    visible.every((id) => readEnumerationUnrestricted(aclFor?.(id) ?? ctx.acl, ctx.grantedScopes))
  );
}
