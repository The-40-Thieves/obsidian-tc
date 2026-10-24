// The whole-vault note scans shared by the standalone link/provenance tools (find_orphans,
// find_unresolved_links, audit_provenance) and by lint_wiki, which folds them into one report.
// One implementation, so a lint proposal and the tool it points at cannot disagree about what an
// orphan, a dangling link or a missing-sources note is.
//
// Every scan here is READ-ONLY and walks only notes the caller's read ACL admits (denied == missing).
//
// Each scan is a step generator (`*Steps`, one `yield` per note) so a caller can run it
// cooperatively with `drainYielding` and not hold the event loop for the whole vault (scan-steps.ts):
// the standalone tools and lint_wiki do. `readableNotes` is the one synchronous drain left, for the
// callers that have not been made cooperative.

import type { FolderAcl } from "../acl";
import { globToRegExp } from "../acl";
import { drainSteps, type ScanSteps } from "../util/scan-steps";
import { readableEntry } from "../vault/acl-read-filter";
import { buildVaultIndex, type ExtractedLink, resolveTarget } from "../vault/links";
import { readNote } from "../vault/notes-io";
import { resolveVaultPath, walkVaultSteps } from "../vault/paths";
import { matchHeadingBoundary } from "./m1/notes/heading-syntax";
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
  /** Every name of the wiki folder (registry `wikiFolders`): the generated pages are left out under each. */
  wikiFolders?: readonly string[] | undefined;
  /** Every name of the vault's raw-sources folder: raw notes are inputs, never the subject of a scan. */
  rawFolders?: readonly string[] | undefined;
}

/** Read-ACL-visible `.md` note paths (optionally under a folder): one step per directory walked. */
export function* readableNotesSteps(
  root: string,
  acl: FolderAcl | undefined,
  grantedScopes: Iterable<string>,
  sub?: string,
): ScanSteps<string[]> {
  return (yield* walkVaultSteps(root, { sub, extensions: [".md"] }))
    .filter((e) => readableEntry(acl, e, grantedScopes))
    .map((e) => e.relPath);
}

export function readableNotes(
  root: string,
  acl: FolderAcl | undefined,
  grantedScopes: Iterable<string>,
  sub?: string,
): string[] {
  return drainSteps(readableNotesSteps(root, acl, grantedScopes, sub));
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
export function* scanOrphansSteps(
  scope: ScanScope,
  warnings: ScanWarnings,
  opts: { folder?: string | undefined; requireNoOutgoing?: boolean },
): ScanSteps<string[]> {
  const { root, acl, grantedScopes } = scope;
  const isRaw = rawPathFilter(scope.rawFolders);
  const candidates = (yield* readableNotesSteps(root, acl, grantedScopes, opts.folder)).filter(
    (p) => !isGeneratedWikiPath(p, scope.wikiFolders ?? scope.wikiFolder) && !isRaw(p),
  );
  const all = yield* readableNotesSteps(root, acl, grantedScopes);
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
    yield;
  }
  return candidates.filter(
    (p) => !linkedTo.has(p) && (!opts.requireNoOutgoing || !hasOutgoing.has(p)),
  );
}

/** Internal links that resolve to no note. Each record carries `source: "property"` + `property`
 *  when the link was written in a property. */
export function* scanUnresolvedSteps(
  scope: ScanScope,
  warnings: ScanWarnings,
  opts: { folder?: string | undefined; limit: number },
): ScanSteps<{ unresolved: Array<Record<string, unknown>>; truncated: boolean }> {
  const { root, acl, grantedScopes } = scope;
  const scan = yield* readableNotesSteps(root, acl, grantedScopes, opts.folder);
  const index = buildVaultIndex(yield* readableNotesSteps(root, acl, grantedScopes));
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
    yield;
  }
  return { unresolved, truncated };
}

/** Every link to `opts.target`, in note order then link order: `skip` links are passed over first
 *  (the cursor), then up to `limit` are kept; `truncated` says more existed. A link in a code block
 *  never counts. */
export function* scanBacklinksSteps(
  scope: ScanScope,
  warnings: ScanWarnings,
  opts: { target: string; skip: number; limit: number },
): ScanSteps<{ backlinks: Array<Record<string, unknown>>; truncated: boolean }> {
  const { root, acl, grantedScopes } = scope;
  const paths = yield* readableNotesSteps(root, acl, grantedScopes);
  const index = buildVaultIndex(paths);
  const backlinks: Array<Record<string, unknown>> = [];
  let truncated = false;
  let seen = 0;
  for (const p of paths) {
    for (const l of linksOf(root, p, warnings)) {
      if (l.inCodeblock) continue;
      const r = resolveTarget(index, l.target);
      if (!r.resolved || r.target_path !== opts.target) continue;
      if (seen++ < opts.skip) continue;
      if (backlinks.length >= opts.limit) {
        truncated = true;
        break;
      }
      backlinks.push({
        source_path: p,
        line: l.line,
        col: l.col,
        raw: l.raw,
        kind: l.kind,
        display: l.display,
        ...originOf(l),
      });
    }
    if (truncated) break;
    yield;
  }
  return { backlinks, truncated };
}

/** Notes audit_provenance leaves out unless asked: dailies, templates, index files, drawings. */
export const PROVENANCE_DEFAULT_EXCLUDE = [
  "01-daily/**",
  "_templates/**",
  "**/00-INDEX.md",
  "**/_*-Index.md",
  "**/*.excalidraw.md",
];

interface ProvenanceScanOpts {
  field: string;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  folder?: string | undefined;
  /** Only notes whose frontmatter `type` (a string, or an array) matches one of these are claim-bearing. */
  types?: string[] | undefined;
}

/** How a note's body cites evidence when its frontmatter has no sources field. */
export type BodyEvidence = "url" | "footnote" | "sources_section";

export interface ProvenanceScan {
  scanned: number;
  withField: number;
  withConfidence: number;
  withVerified: number;
  /** Claim-bearing notes with neither the field nor any body evidence. */
  missing: string[];
  /** Claim-bearing notes without the field whose body cites evidence. */
  bodyOnly: Array<{ path: string; evidence: BodyEvidence[] }>;
  skippedByType: number;
  byFolder: Map<string, { scanned: number; missing: number }>;
}

const URL_IN_TEXT = /\bhttps?:\/\/\S/i;
const LINK_IN_TEXT = /\[\[|\]\(|https?:\/\//i;
const FOOTNOTE_DEFINITION = /^\s{0,3}\[\^[^\]\s]+\]:/;
const SOURCES_HEADING = /^(sources|references)$/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

/** The evidence a note body carries: URLs, footnote definitions, and a Sources/References section
 *  (any heading level) holding a list item or a link. Fenced code blocks and inline code spans are
 *  left out, so a sample URL in code is not a citation. */
export function bodyEvidence(body: string): BodyEvidence[] {
  const prose: string[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) prose.push(line);
  }
  const kinds = new Set<BodyEvidence>();
  let sectionLevel: number | null = null;
  for (const line of prose) {
    const heading = matchHeadingBoundary(line);
    if (heading) {
      if (sectionLevel !== null && heading.level <= sectionLevel) sectionLevel = null;
      if (sectionLevel === null && SOURCES_HEADING.test(heading.title))
        sectionLevel = heading.level;
      continue;
    }
    const text = line.replace(/`[^`]*`/g, "");
    if (URL_IN_TEXT.test(text)) kinds.add("url");
    if (FOOTNOTE_DEFINITION.test(line)) kinds.add("footnote");
    if (sectionLevel !== null && (LIST_ITEM.test(line) || LINK_IN_TEXT.test(text))) {
      kinds.add("sources_section");
    }
  }
  return [...kinds];
}

/** Frontmatter `type` is a string equal to one of `types`, or an array containing one. */
function typeMatches(fm: Record<string, unknown> | null, types: ReadonlySet<string>): boolean {
  const t = fm?.type;
  if (typeof t === "string") return types.has(t);
  return Array.isArray(t) && t.some((x) => typeof x === "string" && types.has(x));
}

/** Claim-bearing notes that lack the `field` frontmatter key, plus coverage of
 *  sources/confidence/verified over the readable set. The include/exclude globs are compiled ONCE
 *  for the whole scan (THE-618): an over-long glob fails up front as `glob too long`, and not
 *  only on whichever note happened to be scanned first. A note without the field whose body cites
 *  evidence is `bodyOnly`, not `missing`. */
export function* scanProvenanceSteps(
  scope: ScanScope,
  warnings: ScanWarnings,
  opts: ProvenanceScanOpts,
): ScanSteps<ProvenanceScan> {
  const exclude = [...PROVENANCE_DEFAULT_EXCLUDE, ...(opts.exclude ?? [])];
  const includeRes = (opts.include ?? []).map((g) => globToRegExp(g.normalize("NFC")));
  const excludeRes = exclude.map((g) => globToRegExp(g.normalize("NFC")));
  const inScope = (rel: string): boolean => {
    const p = rel.normalize("NFC");
    if (includeRes.length && !includeRes.some((re) => re.test(p))) return false;
    return !excludeRes.some((re) => re.test(p));
  };
  const isRaw = rawPathFilter(scope.rawFolders);
  const notes = (yield* readableNotesSteps(
    scope.root,
    scope.acl,
    scope.grantedScopes,
    opts.folder,
  )).filter(
    (p) =>
      inScope(p) && !isGeneratedWikiPath(p, scope.wikiFolders ?? scope.wikiFolder) && !isRaw(p),
  );
  const types = opts.types ? new Set(opts.types) : undefined;
  const byFolder = new Map<string, { scanned: number; missing: number }>();
  const missing: string[] = [];
  const bodyOnly: Array<{ path: string; evidence: BodyEvidence[] }> = [];
  let scanned = 0;
  let skippedByType = 0;
  let withField = 0;
  let withConfidence = 0;
  let withVerified = 0;
  for (const rel of notes) {
    const parsed = warnings.parse(readNote(resolveVaultPath(scope.root, rel)).raw, rel);
    const fm = parsed.frontmatter;
    if (types && !typeMatches(fm, types)) {
      skippedByType++;
      yield;
      continue;
    }
    scanned++;
    const top = rel.split("/")[0] ?? "";
    const folder = byFolder.get(top) ?? { scanned: 0, missing: 0 };
    folder.scanned++;
    if (fmHas(fm, opts.field)) withField++;
    else {
      const evidence = bodyEvidence(parsed.body);
      if (evidence.length) bodyOnly.push({ path: rel, evidence });
      else {
        folder.missing++;
        missing.push(rel);
      }
    }
    if (fmHas(fm, "confidence")) withConfidence++;
    if (fm != null && "verified" in fm) withVerified++;
    byFolder.set(top, folder);
    yield;
  }
  return {
    scanned,
    withField,
    withConfidence,
    withVerified,
    missing,
    bodyOnly,
    skippedByType,
    byFolder,
  };
}
