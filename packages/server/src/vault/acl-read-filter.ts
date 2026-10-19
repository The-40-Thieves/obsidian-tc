// Read-ACL filtering for bridge-proxied results (D2). Bridge tools (tasks_filter,
// makemd_query, ...) surface data the companion plugin enumerated vault-wide, so
// they must be intersected with the caller's read whitelist. When acl.readPaths is
// DEFINED, every returned item must be attributable to an allowed vault path; an item
// that cannot be attributed FAILS CLOSED (acl_denied) rather than leaking.
import { err, grantsAll } from "@the-40-thieves/obsidian-tc-shared";
import { type FolderAcl, isDefaultDenied } from "../acl";
import type { AclPath } from "./acl-identity";
import { callerCanReadVaultPath, pathScopesSatisfied } from "./acl-path";
import { normalizeVaultPath, type WalkEntry } from "./paths";

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

const DEFAULT_BRIDGE_PATH_KEYS = ["path", "note_path", "file", "filePath", "from", "to"] as const;

interface BridgePathScan {
  found: boolean;
  invalid: boolean;
  paths: string[];
}

type BridgePathDecision = "keep" | "drop" | "deny";

function decideBridgePaths(
  scan: BridgePathScan,
  unrestricted: boolean,
  readable: (rel: string) => boolean,
): BridgePathDecision {
  if (scan.invalid) return "drop";
  if (!scan.found) return unrestricted ? "keep" : "deny";
  return scan.paths.every(readable) ? "keep" : "drop";
}

function scanPathValues(values: unknown[]): BridgePathScan {
  const paths: string[] = [];
  let found = false;
  let invalid = false;
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    try {
      const normalized = normalizeVaultPath(value);
      if (normalized.length === 0) continue;
      found = true;
      paths.push(normalized);
    } catch {
      found = true;
      invalid = true;
    }
  }
  return { found, invalid, paths };
}

function scanBridgeItemPaths(
  item: unknown,
  keys: readonly string[] = DEFAULT_BRIDGE_PATH_KEYS,
  barePath = false,
): BridgePathScan {
  if (barePath && typeof item === "string") return scanPathValues([item]);
  if (typeof item !== "object" || item === null) return { found: false, invalid: false, paths: [] };
  const o = item as Record<string, unknown>;
  return scanPathValues(keys.map((key) => o[key]));
}

/** Extract the first vault-relative path from a bridge item, or undefined if unattributable or
 *  any path-shaped value is invalid. Filtering uses every path returned by scanBridgeItemPaths. */
export function bridgeItemPath(
  item: unknown,
  keys: readonly string[] = DEFAULT_BRIDGE_PATH_KEYS,
  barePath = false,
): string | undefined {
  const scan = scanBridgeItemPaths(item, keys, barePath);
  return scan.invalid ? undefined : scan.paths[0];
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
export type WalkReadable = (rel: string, aclRel?: AclPath) => boolean;

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
 * The read predicate for a vault-relative path that was NOT produced by a walk (a path the caller
 * named, or one a stored row or a config derives). It IS read_note's decision (`callerCanReadVaultPath`:
 * `enforcePathAcl("read")` on the bound root), not a mirror of it: an alias is judged by its
 * symlink-resolved target (so a link into the hard-denied `.obsidian` / `.git` / `.trash` is
 * refused even under an otherwise unrestricted ACL), a hard-linked file is refused (realpath cannot
 * dereference a hard link), and a path that cannot be resolved FAILS CLOSED (not readable).
 */
export function readableResolved(
  acl: FolderAcl | undefined,
  root: string,
  rel: string,
  grantedScopes: Iterable<string>,
): boolean {
  return callerCanReadVaultPath(acl, grantedScopes, root, rel);
}

function memoizedReadableResolved(
  acl: FolderAcl | undefined,
  root: string,
  grantedScopes: Iterable<string>,
): (rel: string) => boolean {
  const cache = new Map<string, boolean>();
  return (rel) => {
    const normalized = normalizeVaultPath(rel);
    const cached = cache.get(normalized);
    if (cached !== undefined) return cached;
    const readable = readableResolved(acl, root, normalized, grantedScopes);
    cache.set(normalized, readable);
    return readable;
  };
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
 * Filter bridge-returned items by the read ACL. Every attributable item is kept only when
 * read_note could read it (`readableResolved`): the plugin names the display path, so `wiki/x.md`
 * under `wiki -> private` is judged as `private/x.md`, and a hard link or an alias into a
 * hard-denied folder is refused, even for a caller whose read enumeration is "unrestricted"
 * (there is no fast path: that flag says nothing about the canonical target). When enumeration is
 * restricted, every item MUST be attributable to a vault path and an unattributable item throws
 * acl_denied (fail-closed); an unrestricted caller keeps a row that names no path (there is nothing
 * to judge). A path that cannot be resolved (dangling link, outside the vault) is dropped.
 */
export function filterBridgeItemsByAcl(
  acl: FolderAcl | undefined,
  root: string,
  grantedScopes: Iterable<string>,
  items: unknown[],
  opts: { tool: string; keys?: readonly string[]; barePath?: boolean },
): unknown[] {
  const unrestricted = readEnumerationUnrestricted(acl, grantedScopes);
  const readable = memoizedReadableResolved(acl, root, grantedScopes);
  const out: unknown[] = [];
  for (const it of items) {
    const scan =
      opts.barePath && typeof it === "string"
        ? scanBridgeItemPaths(it, opts.keys, true)
        : scanPathValues([
            ...directPathValues(it, opts.keys ?? DEFAULT_BRIDGE_PATH_KEYS),
            ...nestedPathValues(it),
          ]);
    switch (decideBridgePaths(scan, unrestricted, readable)) {
      case "keep":
        out.push(it);
        break;
      case "drop":
        break;
      case "deny":
        throw err.aclDenied("bridge result cannot be attributed to a vault path; failing closed", {
          tool: opts.tool,
        });
    }
  }
  return out;
}

function directPathValues(row: unknown, keys: readonly string[]): unknown[] {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return [];
  const record = row as Record<string, unknown>;
  return keys.map((key) => record[key]);
}

/** Dataview `Link.type` values. A `{ path, type }` object is a Link only with one of these; a plain
 *  frontmatter map that merely has a `path` key (`{ path: "C:\\Users\\x" }`) is user text. */
const DATAVIEW_LINK_TYPES: ReadonlySet<unknown> = new Set(["file", "header", "block"]);

function nestedPathValues(row: unknown, keys: readonly string[] = ["path"]): unknown[] {
  const paths: unknown[] = [];
  const seen = new Set<object>();
  const visitFields = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    // `fields` is usually a frontmatter map, whose values are visited below. But a note whose own
    // frontmatter key is `fields` evaluates to the Link itself (`fields: [[secret]]`), and the
    // loop below would read its `path` as a plain value and never judge it.
    if (!Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (DATAVIEW_LINK_TYPES.has(record.type)) for (const key of keys) paths.push(record[key]);
    }
    // The whole `fields` subtree is user frontmatter, so only typed Links are judged at any depth.
    const cells = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const cell of cells) visitFields(cell);
  };
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const cell of value) visit(cell);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of keys) paths.push(record[key]);
    for (const [key, cell] of Object.entries(record)) {
      if (key === "fields") visitFields(cell);
      else visit(cell);
    }
  };
  visit(row);
  return paths;
}

/** Refuse an opaque companion value when any nested path is invalid or unreadable. Values with no
 *  path remain valid: field/evaluation payloads can legitimately be scalars or plain objects. Only
 *  Link-shaped `path` keys count here: Dataview and Metadata Menu links carry `path`, while
 *  frontmatter values legitimately use `from`/`to`/`file` as plain text. */
export function assertBridgeNestedPathsReadable(
  acl: FolderAcl | undefined,
  root: string,
  grantedScopes: Iterable<string>,
  value: unknown,
  tool: string,
): void {
  const scan = scanPathValues(nestedPathValues(value));
  const readable = memoizedReadableResolved(acl, root, grantedScopes);
  if (decideBridgePaths(scan, true, readable) !== "keep")
    throw err.aclDenied("bridge result contains a path this caller cannot read", { tool });
}

/** Filter Dataview rows by every nested Link/TASK `path`. Rows such as TABLE WITHOUT ID that have
 *  no attributable path remain visible to an unrestricted caller. */
export function filterBridgeDqlRowsByAcl(
  acl: FolderAcl | undefined,
  root: string,
  grantedScopes: Iterable<string>,
  rows: unknown[][],
  tool: string,
): unknown[][] {
  const unrestricted = readEnumerationUnrestricted(acl, grantedScopes);
  const readable = memoizedReadableResolved(acl, root, grantedScopes);
  return rows.filter((row) => {
    const scan = scanPathValues(nestedPathValues(row));
    const decision = decideBridgePaths(scan, unrestricted, readable);
    if (decision === "deny") {
      throw err.aclDenied("bridge result cannot be attributed to a vault path; failing closed", {
        tool,
      });
    }
    return decision === "keep";
  });
}

/**
 * Filter a bridge result shaped `{ items: [...], total, ... }` (Datacore, Omnisearch). The rows are
 * filtered by note path (fail closed on an unattributable row for a restricted caller) and `total`
 * is always recounted. A result without an `items` array is reduced to an empty envelope. Every
 * other sibling field is always dropped: a companion can add undeclared path-bearing fields, and
 * changing sibling presence when a row is removed exposes the filter decision as a key-set oracle.
 */
export function filterBridgeResultItems(
  acl: FolderAcl | undefined,
  root: string,
  grantedScopes: Iterable<string>,
  result: unknown,
  opts: { tool: string; keys?: readonly string[]; barePath?: boolean },
): Record<string, unknown> {
  if (typeof result !== "object" || result === null || Array.isArray(result))
    throw err.pluginIncompatible("companion returned an unexpected response payload", {
      tool: opts.tool,
    });
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.items)) return { items: [], total: 0 };
  const rows = record.items as unknown[];
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
  const scan = scanBridgeItemPaths(result);
  const unrestricted = readEnumerationUnrestricted(acl, grantedScopes);
  const readable = memoizedReadableResolved(acl, root, grantedScopes);
  if (decideBridgePaths(scan, unrestricted, readable) !== "keep")
    throw err.aclDenied("path is not readable by this caller", { tool: opts.tool });
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
