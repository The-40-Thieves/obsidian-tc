// Identity evidence for find_existing_page: the ways a vault can already say "this topic has a
// page". Everything here is read from the files themselves (a path, `aliases`, a `wikidata`
// property, a title, the text other notes link it under), never from the index, which is why a
// note hidden from the index by Obsidian's Excluded files still counts: it is an ordinary vault
// file and a valid link target. Similarity evidence is the other kind and lives in the tool.
//
// READ-ONLY, and ACL-scoped by construction: only notes the caller's read ACL admits are walked,
// so a denied note is indistinguishable from a missing one.
import { buildVaultIndex, extractNoteLinks, resolveTarget } from "../../../vault/links";
import { readNote } from "../../../vault/notes-io";
import { resolveVaultPath } from "../../../vault/paths";
import { ScanWarnings } from "../../scan-warnings";
import { readableNotes, type ScanScope } from "../../wiki-scan";
import { isGeneratedWikiPath } from "./wiki-folder";

export type EvidenceKind =
  | "path"
  | "name_variant"
  | "alias"
  | "wikidata"
  | "title"
  | "link_text"
  | "semantic"
  | "judged_by";

export interface Evidence {
  kind: EvidenceKind;
  /** Human-readable specifics: the alias that matched, the link text, the QID. */
  detail?: string;
  /** The top-level property a `link_text` link sits under (a property link). */
  property?: string;
  /** Cosine, for `semantic`. */
  score?: number;
  /** For `judged_by`: the resolved model that ruled and its verdict (the rationale is `detail`). */
  model?: string;
  verdict?: string;
}

export interface PageCandidate {
  path: string;
  evidence: Evidence[];
  /** True when the note is left out of the index by Excluded files / index.excludePaths. */
  excluded: boolean;
}

/** Evidence that says the topic IS this page: a name, an alias, an identifier, a title. */
export const STRONG_KINDS: ReadonlySet<EvidenceKind> = new Set([
  "path",
  "name_variant",
  "alias",
  "wikidata",
  "title",
]);

/** Case-, punctuation- and spacing-insensitive comparison key ("Spaced-repetition" == "spaced repetition"). */
export function looseKey(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[-_\s]+/g, " ")
    .trim();
}

/** A bare topic, with a pasted `[[wikilink]]` unwrapped to its target. */
export function cleanTopic(topic: string): string {
  const t = topic.trim();
  const m = t.match(/^\[\[([^\]]+)\]\]$/);
  const inner = (m?.[1] ?? t).split("|")[0] ?? t;
  return inner.split("#")[0]?.trim().replace(/\.md$/i, "") || t;
}

/** A shorter topic is too common a string to call a mention. */
const MIN_MENTION_CHARS = 3;

/** The file name a link target points at: no folder, no `.md`. */
const baseOf = (target: string): string =>
  (target.split("/").pop() ?? target).replace(/\.md$/i, "");

const QID = /(?:^|[^A-Za-z0-9])(Q\d+)(?![A-Za-z0-9])/gi;

/** Every QID in a string (`Q42`, or a wikidata URL), uppercased. */
export function qidsIn(value: string): string[] {
  return [...value.matchAll(QID)].map((m) => (m[1] as string).toUpperCase());
}

const WIKIDATA_KEY = /^wikidata([_-]?id)?$/i;
const ALIAS_KEY = /^aliases?$/i;

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (typeof v === "number") return [String(v)];
  if (Array.isArray(v)) return v.flatMap(strings);
  return [];
}

/** The note's own title, if it states one: frontmatter `title`, else its first H1. */
function titlesOf(fm: Record<string, unknown> | null, body: string): string[] {
  const out: string[] = [];
  const t = fm?.title;
  if (typeof t === "string" && t.trim()) out.push(t.trim());
  const h1 = body.match(/^#\s+(.+?)\s*#*\s*$/m);
  if (h1?.[1]) out.push(h1[1].trim());
  return out;
}

export interface IdentityScan {
  candidates: Map<string, PageCandidate>;
  /** Notes read for aliases/ids/titles/links (the cost of the call). */
  scanned: number;
  warnings: ScanWarnings;
  /** Every readable note, for resolving link targets without a second walk. */
  notes: string[];
  /** Notes whose text mentions the topic (loose match), linked or not. */
  mentions: string[];
  /** Notes that already link something named like the topic, resolved or not. */
  linkers: string[];
}

/**
 * Collect identity evidence for `topic` across the caller's readable notes. `folder` narrows which
 * notes may be REPORTED, not which notes are read: a link from outside the folder still counts as
 * evidence for a page inside it.
 */
export function collectIdentityEvidence(
  scope: ScanScope,
  topicRaw: string,
  opts: {
    folder?: string | undefined;
    isExcluded: (rel: string) => boolean;
    /** Notes that are not pages (a vault's raw sources): readable and valid link targets, so they stay
     *  in `notes`, but never evidence, candidates, mentions or linkers. */
    ignore?: (rel: string) => boolean;
  },
): IdentityScan {
  const topic = cleanTopic(topicRaw);
  const topicKey = looseKey(topic);
  const topicQids = new Set(qidsIn(topicRaw));
  const all = readableNotes(scope.root, scope.acl, scope.grantedScopes);
  const index = buildVaultIndex(all);
  const folderPrefix = opts.folder ? `${opts.folder.replace(/\/+$/, "")}/` : "";
  const inFolder = (p: string): boolean => folderPrefix === "" || p.startsWith(folderPrefix);
  const ignored = opts.ignore ?? (() => false);
  const candidates = new Map<string, PageCandidate>();
  // The generated index.md / log.md are never a page, and never evidence for one: the index links
  // every page under its own name, which would read as every topic already having a page.
  const generated = (p: string): boolean => isGeneratedWikiPath(p, scope.wikiFolder);
  const add = (path: string, ev: Evidence): void => {
    if (!inFolder(path) || generated(path) || ignored(path)) return;
    const c = candidates.get(path) ?? { path, evidence: [], excluded: opts.isExcluded(path) };
    // One entry per (kind, detail): a note listing the same alias twice is one piece of evidence.
    if (!c.evidence.some((e) => e.kind === ev.kind && e.detail === ev.detail)) c.evidence.push(ev);
    candidates.set(path, c);
  };

  // Path / name: what `[[topic]]` would resolve to in Obsidian (case-insensitive path or basename).
  const resolved = resolveTarget(index, topic);
  if (resolved.resolved) {
    for (const p of resolved.candidates ?? [resolved.target_path as string])
      add(p, { kind: "path", detail: p });
  }
  for (const p of all) {
    const base = (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p).replace(/\.md$/i, "");
    if (looseKey(base) === topicKey && !candidates.get(p)?.evidence.some((e) => e.kind === "path"))
      add(p, { kind: "name_variant", detail: base });
  }

  const warnings = new ScanWarnings();
  const linkTexts = new Map<string, { n: number; property?: string; sample: string }>();
  const mentions: string[] = [];
  const linkers: string[] = [];
  for (const rel of all) {
    if (generated(rel) || ignored(rel)) continue;
    const parsed = warnings.parse(readNote(resolveVaultPath(scope.root, rel)).raw, rel);
    const fm = parsed.frontmatter;
    if (fm) {
      for (const [key, value] of Object.entries(fm)) {
        if (ALIAS_KEY.test(key)) {
          // `aliases: a, b` (a comma string) is as valid as a list in Obsidian.
          for (const raw of strings(value).flatMap((s) =>
            typeof value === "string" ? s.split(",") : [s],
          )) {
            if (looseKey(raw) === topicKey && topicKey !== "")
              add(rel, { kind: "alias", detail: raw.trim() });
          }
        } else if (WIKIDATA_KEY.test(key) && topicQids.size > 0) {
          for (const q of strings(value).flatMap(qidsIn))
            if (topicQids.has(q)) add(rel, { kind: "wikidata", detail: q });
        }
      }
    }
    for (const t of titlesOf(fm, parsed.body)) {
      if (looseKey(t) === topicKey && topicKey !== "") add(rel, { kind: "title", detail: t });
    }
    if (topicKey.length >= MIN_MENTION_CHARS && looseKey(parsed.body).includes(topicKey))
      mentions.push(rel);
    const links = extractNoteLinks(parsed);
    if (links.some((l) => !l.inCodeblock && looseKey(baseOf(l.target)) === topicKey))
      linkers.push(rel);
    for (const l of links) {
      if (l.inCodeblock || !l.display || looseKey(l.display) !== topicKey) continue;
      const r = resolveTarget(index, l.target);
      if (!r.resolved || !r.target_path || r.target_path === rel) continue;
      const slot = linkTexts.get(r.target_path) ?? { n: 0, sample: l.display };
      slot.n++;
      if (l.source === "property" && l.property !== undefined) slot.property ??= l.property;
      linkTexts.set(r.target_path, slot);
    }
  }
  for (const [path, s] of linkTexts) {
    add(path, {
      kind: "link_text",
      detail: `${s.n} link(s) call this page "${s.sample}"`,
      ...(s.property !== undefined ? { property: s.property } : {}),
    });
  }
  return { candidates, scanned: all.length, warnings, notes: all, mentions, linkers };
}
