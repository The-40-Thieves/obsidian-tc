// The link map behind draft_wiki_page: which existing notes a new page should link TO and which
// existing notes should link FROM it. Built from what find_existing_page already computed (its
// candidates: aliases, link text, similarity) and the identity scan's by-products (the notes that
// mention the topic, the notes that already link it), so a draft costs one vault walk and one query
// embedding, not two.
//
//   link_to    notes the new page should link: the sources the caller named that are notes, plus
//              every other candidate the dedupe check found (related, not the same topic);
//   link_from  notes that should link the new page: notes that mention the topic in plain text
//              without linking it, and related pages inside the wiki folder (a "See also");
//   already_linking  notes that already link the topic, so they need no patch: their link starts
//              resolving as soon as the page exists.
// Notes Obsidian's Excluded files hides are never `link_from` (nobody asked the wiki to edit them),
// but they can still be `link_to` (they are valid link targets). Everything here is ACL-filtered
// by the scan that produced it.
import { buildVaultIndex, resolveTarget } from "../../../vault/links";
import { cleanTopic, type IdentityScan, type PageCandidate } from "./wiki-evidence";

export interface LinkMapEntry {
  path: string;
  /** Why it is here: evidence kinds (`semantic`, `alias`...), `source`, `mentions_topic`,
   *  `related_wiki_page`. */
  reasons: string[];
  /** Best similarity, when similarity was a reason. */
  score?: number;
  /** Inside the wiki folder (always true when the vault has none). */
  in_wiki: boolean;
}

export interface LinkMap {
  link_to: LinkMapEntry[];
  link_from: LinkMapEntry[];
  already_linking: string[];
}

export const LINK_MAP_LIMIT = 8;

const FILENAME_UNSAFE = /[\\/:*?"<>|#^[\]]/g;

/** A file name for a page about `topic`: the cleaned topic with characters a vault path or a wikilink
 *  cannot carry removed. */
export function pageTitleOf(topic: string): string {
  return (
    cleanTopic(topic)
      .replace(FILENAME_UNSAFE, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .slice(0, 120)
      .trim() || "Untitled"
  );
}

/** Where a new page about `topic` goes: the wiki folder, then its type's subfolder, then the title. */
export function proposedPagePath(
  topic: string,
  parts: { wikiFolder?: string | undefined; typeFolder?: string | undefined },
): string {
  const dir = [parts.wikiFolder, parts.typeFolder].filter((p): p is string => !!p).join("/");
  return `${dir ? `${dir}/` : ""}${pageTitleOf(topic)}.md`;
}

const inWikiFolder = (path: string, wikiFolder: string | undefined): boolean =>
  !wikiFolder || path.startsWith(`${wikiFolder}/`);

function add(
  map: Map<string, LinkMapEntry>,
  path: string,
  reason: string,
  wikiFolder: string | undefined,
  score?: number,
): void {
  const e = map.get(path) ?? { path, reasons: [], in_wiki: inWikiFolder(path, wikiFolder) };
  if (!e.reasons.includes(reason)) e.reasons.push(reason);
  if (score !== undefined) e.score = Math.max(e.score ?? 0, score);
  map.set(path, e);
}

const semanticScore = (c: PageCandidate): number | undefined => {
  const s = c.evidence.filter((e) => e.kind === "semantic").map((e) => e.score ?? 0);
  return s.length > 0 ? Math.max(...s) : undefined;
};

/** Order for a capped list: caller-named sources, then the better-evidenced, then by path. */
const byRelevance = (a: LinkMapEntry, b: LinkMapEntry): number =>
  Number(b.reasons.includes("source")) - Number(a.reasons.includes("source")) ||
  b.reasons.length - a.reasons.length ||
  (b.score ?? 0) - (a.score ?? 0) ||
  a.path.localeCompare(b.path);

export function buildLinkMap(args: {
  ranked: readonly PageCandidate[];
  scan: Pick<IdentityScan, "notes" | "mentions" | "linkers">;
  /** What the caller cited: note paths / wikilinks resolve to notes, anything else (URLs) is ignored here. */
  sources: readonly string[];
  wikiFolder?: string | undefined;
  /** The page being drafted or committed: never its own link target. */
  selfPath?: string | undefined;
  isExcluded: (rel: string) => boolean;
  limit?: number;
}): LinkMap {
  const { wikiFolder, selfPath } = args;
  const limit = args.limit ?? LINK_MAP_LIMIT;
  const linkers = new Set(args.scan.linkers);
  const to = new Map<string, LinkMapEntry>();
  const from = new Map<string, LinkMapEntry>();

  const index = buildVaultIndex([...args.scan.notes]);
  for (const s of args.sources) {
    const r = resolveTarget(index, cleanTopic(s));
    if (r.resolved && r.target_path && r.target_path !== selfPath)
      add(to, r.target_path, "source", wikiFolder);
  }
  for (const c of args.ranked) {
    if (c.path === selfPath) continue;
    const score = semanticScore(c);
    for (const kind of new Set(c.evidence.map((e) => e.kind))) {
      if (kind !== "judged_by")
        add(to, c.path, kind, wikiFolder, kind === "semantic" ? score : undefined);
    }
    if (!c.excluded && inWikiFolder(c.path, wikiFolder) && !linkers.has(c.path))
      add(from, c.path, "related_wiki_page", wikiFolder, score);
  }
  for (const path of args.scan.mentions) {
    if (path === selfPath || linkers.has(path) || args.isExcluded(path)) continue;
    add(from, path, "mentions_topic", wikiFolder);
  }
  const top = (m: Map<string, LinkMapEntry>): LinkMapEntry[] =>
    [...m.values()].sort(byRelevance).slice(0, limit);
  return {
    link_to: top(to),
    link_from: top(from),
    already_linking: [...linkers].filter((p) => p !== selfPath).sort(),
  };
}
