// The bookkeeping half of ingesting a raw source into the wiki (draft_wiki_page `source`). The server
// checks and counts; the calling LLM reads the source and writes the prose. Nothing here calls a
// model or writes a file.
//
// A raw source is one markdown note inside the vault's raw folder (vault/raw-folder.ts). "Inside" is
// the wiki folder's own identity check (insideFolder): the path as written AND the real path it leads
// to, so a symlink in raw/ that leads out, or one that leads in, is not a source. A source the
// caller may not read answers exactly like a missing one, before any byte of it is read.
import { err, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import type { CallerContext } from "../../../mcp/registry";
import { enforcePathAcl } from "../../../vault/acl-path";
import { parseNoteLenient } from "../../../vault/frontmatter";
import { buildVaultIndex, resolveTarget } from "../../../vault/links";
import { noteExists, readNote } from "../../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../../vault/paths";
import type { ResolvedVault } from "../../../vault/registry";
import { ScanWarnings } from "../../scan-warnings";
import { linksOf } from "../../wiki-scan";
import { insideFolder, pathInFolder } from "./wiki-folder";

/**
 * The compression rule. A page should be shorter than what it distils, so a source under this many
 * characters (its body, frontmatter excluded) is refused a page of its own: restating it adds
 * nothing. It is only refused when nothing in the wiki can take it in: no page already covers the
 * topic, none is related to it, and none already cites it. Then the answer is to wait for more
 * sources on the topic, or to fold it into a page that exists.
 */
export const MIN_INGEST_SOURCE_CHARS = 1500;

export interface RawSource {
  path: string;
  content_hash: string;
  /** Characters of the body, frontmatter excluded, trimmed. */
  chars: number;
  title: string;
}

export interface IngestRefusal {
  reason: "source_too_short";
  chars: number;
  min_chars: number;
}

/** The `[[wikilink]]` a page cites its source by: a property link, so the source's backlinks show it. */
export const sourceLink = (path: string): string => `[[${path.replace(/\.md$/i, "")}]]`;

const H1 = /^#\s+(.+?)\s*#*\s*$/m;

/**
 * Validate and read the raw source `source` names. Throws invalid_input (no raw folder, not a
 * markdown note, outside the raw folder) or note_not_found (missing, or not readable by this
 * caller, with the same answer).
 */
export function readRawSource(
  v: ResolvedVault,
  ctx: Pick<CallerContext, "acl" | "grantedScopes">,
  source: string,
): RawSource {
  if (v.rawFolder === undefined)
    throw err.invalidInput(
      "this vault has no raw folder: set vaults[].wiki.folder (the raw folder then defaults to `raw` beside it) or vaults[].wiki.rawFolder",
      { reason: "no_raw_folder", path: source },
    );
  const rel = normalizeVaultPath(source);
  if (!/\.md$/i.test(rel))
    throw err.invalidInput("a raw source must be a markdown note (.md)", {
      reason: "not_markdown",
      path: rel,
    });
  if (!insideFolder(v.root, v.rawFolder, rel))
    throw err.invalidInput(`a raw source must be inside the raw folder (${v.rawFolder}/)`, {
      reason: "outside_raw_folder",
      path: rel,
      raw_folder: v.rawFolder,
    });
  const notFound = (): never => {
    throw err.noteNotFound("raw source not found", { path: rel });
  };
  try {
    enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
  } catch (e) {
    if (e instanceof ObsidianTcError && e.code === "acl_denied") return notFound();
    throw e;
  }
  const abs = resolveVaultPath(v.root, rel);
  const ex = noteExists(abs);
  if (!ex.exists || ex.type === "folder") return notFound();
  const note = readNote(abs);
  const parsed = parseNoteLenient(note.raw, rel);
  const fmTitle = parsed.frontmatter?.title;
  const title =
    (typeof fmTitle === "string" && fmTitle.trim()) ||
    parsed.body.match(H1)?.[1]?.trim() ||
    (rel.split("/").pop() ?? rel).replace(/\.md$/i, "");
  return { path: rel, content_hash: note.hash, chars: parsed.body.trim().length, title };
}

/** The wiki pages that already cite `sourcePath`: a link to it in the body or in a property. */
export function pagesCiting(
  root: string,
  notes: readonly string[],
  wikiFolder: string,
  sourcePath: string,
): string[] {
  const index = buildVaultIndex([...notes]);
  const warnings = new ScanWarnings();
  return notes
    .filter((rel) => pathInFolder(rel, wikiFolder))
    .filter((rel) =>
      linksOf(root, rel, warnings).some(
        (l) =>
          !l.inCodeblock &&
          l.target !== "" &&
          resolveTarget(index, l.target).target_path === sourcePath,
      ),
    )
    .sort();
}

/** The compression rule: refused when the source is short AND the wiki has nothing to take it in. */
export function compressionRefusal(chars: number, wikiHasAPage: boolean): IngestRefusal | null {
  return chars < MIN_INGEST_SOURCE_CHARS && !wikiHasAPage
    ? { reason: "source_too_short", chars, min_chars: MIN_INGEST_SOURCE_CHARS }
    : null;
}

/** What to tell the caller when the rule refused the page. */
export const refusalAdvice = (r: IngestRefusal): string =>
  `This source is ${r.chars} characters (under ${r.min_chars}) and no page in the wiki covers, relates to or cites it, so a page for it would only restate it. Wait for more sources on the topic, or add it to a page that exists.`;
