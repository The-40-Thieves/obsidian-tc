// The whole-vault note scans shared by the standalone link/provenance tools (find_orphans,
// find_unresolved_links, audit_provenance) and by lint_wiki, which folds them into one report.
// One implementation, so a lint proposal and the tool it points at cannot disagree about what an
// orphan, a dangling link or a missing-sources note is.
//
// Every scan here is READ-ONLY and walks only notes the caller's read ACL admits (denied == missing).

import type { FolderAcl } from "../acl";
import { globToRegExp } from "../acl";
import { readableRel } from "../vault/acl-read-filter";
import { buildVaultIndex, type ExtractedLink, resolveTarget } from "../vault/links";
import { readNote } from "../vault/notes-io";
import { resolveVaultPath, walkVault } from "../vault/paths";
import { isGeneratedWikiPath, rawPathFilter } from "./m7/knowledge/wiki-folder";
import { isGeneratedPage } from "./m7/knowledge/wiki-generated-seal";
import type { ScanWarnings } from "./scan-warnings";

/** Who is scanning: the vault root plus the caller's read ACL. */
export interface ScanScope {
  root: string;
  acl: FolderAcl | undefined;
  grantedScopes: Iterable<string>;
  /** The vault's wiki folder: its generated index.md / log.md are never the subject of a scan. */
  wikiFolder?: string | undefined;
  /** The vault's raw-sources folder: raw notes are inputs, never the subject of a scan. */
  rawFolder?: string | undefined;
}

/** Read-ACL-visible `.md` note paths (optionally under a folder). */
export function readableNotes(
  root: string,
  acl: FolderAcl | undefined,
  grantedScopes: Iterable<string>,
  sub?: string,
): string[] {
  return walkVault(root, { sub, extensions: [".md"] })
    .map((e) => e.relPath)
    .filter((rel) => readableRel(acl, rel, grantedScopes));
}

/** A note's links for a scan: property links, then body links. Bad frontmatter YAML does not fail
 *  the scan: the note is named in `warnings`, it has no property links, and its body still counts. */
export function linksOf(root: string, rel: string, warnings: ScanWarnings): ExtractedLink[] {
  const raw = readNote(resolveVaultPath(root, rel)).raw;
  // A generated page (the wiki index) links every page it lists: those are not authored links.
  return isGeneratedPage(raw) ? [] : warnings.links(raw, rel);
}

/** The fields that say a link was written in a property: `source: "property"` plus its `property`
 *  key. A body link carries neither, so a vault without property links gets the output it always
 *  had, in either response_format. */
export function originOf(l: Pick<ExtractedLink, "source" | "property">): {
  source?: "property";
  property?: string;
} {
  return l.source === "property" && l.property !== undefined
    ? { source: "property", property: l.property }
    : {};
}

export function isExternal(kind: string, target: string): boolean {
  return kind === "markdown" && /^[a-z]+:\/\//i.test(target);
}

/** Frontmatter has the key with a non-empty value (non-empty string/array, or any present scalar). */
export function fmHas(fm: Record<string, unknown> | null, key: string): boolean {
  if (!fm || !Object.hasOwn(fm, key)) return false;
  const val = fm[key];
  if (val == null) return false;
  if (typeof val === "string") return val.trim().length > 0;
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

/** Notes (in `folder`, or the whole vault) that nothing else links to. A link in a property counts.
 *  Resolution runs over EVERY readable note, so a link from outside the folder still rescues one. */
export function scanOrphans(
  scope: ScanScope,
  warnings: ScanWarnings,
  opts: { folder?: string | undefined; requireNoOutgoing?: boolean },
): string[] {
  const { root, acl, grantedScopes } = scope;
  const isRaw = rawPathFilter(scope.rawFolder);
  const candidates = readableNotes(root, acl, grantedScopes, opts.folder).filter(
    (p) => !isGeneratedWikiPath(p, scope.wikiFolder) && !isRaw(p),
  );
  const all = readableNotes(root, acl, grantedScopes);
  const index = buildVaultIndex(all);
  const linkedTo = new Set<string>();
  const hasOutgoing = new Set<string>();
  for (const p of all) {
    for (const l of linksOf(root, p, warnings)) {
      if (l.inCodeblock) continue;
      const r = resolveTarget(index, l.target);
      if (r.resolved && r.target_path && r.target_path !== p) {
        linkedTo.add(r.target_path);
        hasOutgoing.add(p);
      }
    }
  }
  return candidates.filter(
    (p) => !linkedTo.has(p) && (!opts.requireNoOutgoing || !hasOutgoing.has(p)),
  );
}

/** Internal links that resolve to no note. Each record carries `source: "property"` + `property`
 *  when the link was written in a property. */
export function scanUnresolved(
  scope: ScanScope,
  warnings: ScanWarnings,
  opts: { folder?: string | undefined; limit: number },
): { unresolved: Array<Record<string, unknown>>; truncated: boolean } {
  const { root, acl, grantedScopes } = scope;
  const scan = readableNotes(root, acl, grantedScopes, opts.folder);
  const index = buildVaultIndex(readableNotes(root, acl, grantedScopes));
  const unresolved: Array<Record<string, unknown>> = [];
  let truncated = false;
  for (const p of scan) {
    for (const l of linksOf(root, p, warnings)) {
      if (l.inCodeblock) continue;
      if (isExternal(l.kind, l.target)) continue;
      if (l.target === "" || l.target.startsWith("#")) continue;
      if (resolveTarget(index, l.target).resolved) continue;
      if (unresolved.length >= opts.limit) {
        truncated = true;
        break;
      }
      unresolved.push({
        source_path: p,
        target: l.target,
        line: l.line,
        col: l.col,
        kind: l.kind,
        ...originOf(l),
      });
    }
    if (truncated) break;
  }
  return { unresolved, truncated };
}

/** Notes audit_provenance leaves out unless asked: dailies, templates, index files, drawings. */
export const PROVENANCE_DEFAULT_EXCLUDE = [
  "01-daily/**",
  "_templates/**",
  "**/00-INDEX.md",
  "**/_*-Index.md",
  "**/*.excalidraw.md",
];

export interface ProvenanceScan {
  scanned: number;
  withField: number;
  withConfidence: number;
  withVerified: number;
  missing: string[];
  byFolder: Map<string, { scanned: number; missing: number }>;
}

/** Claim-bearing notes that lack the `field` frontmatter key, plus coverage of
 *  sources/confidence/verified over the readable set. The include/exclude globs are compiled ONCE
 *  for the whole scan (THE-618): an over-long glob fails up front as `glob too long`, and not
 *  only on whichever note happened to be scanned first. */
export function scanProvenance(
  scope: ScanScope,
  warnings: ScanWarnings,
  opts: {
    field: string;
    include?: string[] | undefined;
    exclude?: string[] | undefined;
    folder?: string | undefined;
  },
): ProvenanceScan {
  const exclude = [...PROVENANCE_DEFAULT_EXCLUDE, ...(opts.exclude ?? [])];
  const includeRes = (opts.include ?? []).map((g) => globToRegExp(g.normalize("NFC")));
  const excludeRes = exclude.map((g) => globToRegExp(g.normalize("NFC")));
  const inScope = (rel: string): boolean => {
    const p = rel.normalize("NFC");
    if (includeRes.length && !includeRes.some((re) => re.test(p))) return false;
    return !excludeRes.some((re) => re.test(p));
  };
  const isRaw = rawPathFilter(scope.rawFolder);
  const notes = readableNotes(scope.root, scope.acl, scope.grantedScopes, opts.folder).filter(
    (p) => inScope(p) && !isGeneratedWikiPath(p, scope.wikiFolder) && !isRaw(p),
  );
  const byFolder = new Map<string, { scanned: number; missing: number }>();
  const missing: string[] = [];
  let withField = 0;
  let withConfidence = 0;
  let withVerified = 0;
  for (const rel of notes) {
    const fm = warnings.parse(readNote(resolveVaultPath(scope.root, rel)).raw, rel).frontmatter;
    const top = rel.split("/")[0] ?? "";
    const folder = byFolder.get(top) ?? { scanned: 0, missing: 0 };
    folder.scanned++;
    if (fmHas(fm, opts.field)) withField++;
    else {
      folder.missing++;
      missing.push(rel);
    }
    if (fmHas(fm, "confidence")) withConfidence++;
    if (fm != null && "verified" in fm) withVerified++;
    byFolder.set(top, folder);
  }
  return { scanned: notes.length, withField, withConfidence, withVerified, missing, byFolder };
}
