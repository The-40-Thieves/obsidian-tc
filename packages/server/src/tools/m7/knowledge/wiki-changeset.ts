// The changeset draft_wiki_page proposes and commit_wiki_page applies: ONE new page plus the small
// additive patches that keep the rest of the wiki linked to it. The patches are deliberately limited
// to adding to a note (a link bullet, or text under a heading / at the end): rewriting or deleting
// existing prose is patch_note / write_note's job, with their own guards.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { frontmatterFallbackSink } from "../../../util/errors";
import { parseNote, serializeNote } from "../../../vault/frontmatter";
import { type ExtractedLink, extractNoteLinks } from "../../../vault/links";
import {
  hasUnterminatedFence,
  type ResolvedAnchor,
  resolveSection,
  resolveSectionOrThrow,
} from "../../m1/notes/anchors";

export const DEFAULT_LINK_HEADING = "See also";

/** Caps on what one commit may carry, so a runaway changeset cannot rewrite the wiki. */
export const MAX_PATCHES = 25;
export const MAX_BODY_CHARS = 200_000;

export const WikiPageSpec = z
  .object({
    path: z.string().min(1).describe("Where the page goes (vault-relative, ends in .md)."),
    frontmatter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The page's properties, as an object (not YAML text). Checked against SCHEMA.md."),
    body: z
      .string()
      .min(1)
      .max(MAX_BODY_CHARS)
      .describe("The page's markdown, WITHOUT a frontmatter block. You write it."),
    mode: z
      .enum(["create", "overwrite"])
      .default("create")
      .describe(
        "`create` (default) refuses a path that exists. `overwrite` replaces an existing page, needs `prev_hash`, and asks for confirmation like write_note does.",
      ),
    prev_hash: z
      .string()
      .min(1)
      .optional()
      .describe("`overwrite` only: the page's current content_hash."),
  })
  .strict();

export const WikiPatchSpec = z
  .object({
    path: z.string().min(1).describe("Existing note to patch (vault-relative)."),
    prev_hash: z
      .string()
      .min(1)
      .describe(
        "content_hash of the note when you read it (the draft gives it): compare-and-swap.",
      ),
    operation: z
      .enum(["link", "append"])
      .describe(
        "`link` adds a bullet linking the new page under `heading` (default 'See also', created at the end when the note has none) and does nothing when the note already links it. `append` adds `content` at the end of the note, or at the end of the section under `heading`.",
      ),
    heading: z.string().min(1).max(200).optional(),
    content: z
      .string()
      .max(20_000)
      .optional()
      .describe("`append` only: the text to add. You write it."),
    text: z
      .string()
      .max(500)
      .optional()
      .describe("`link` only: a few words after the link saying why it is related. You write it."),
  })
  .strict();
export type WikiPatch = z.infer<typeof WikiPatchSpec>;

export type PatchOutcome =
  | { applied: true; content: string; added: string }
  | { applied: false; content: string; reason: "already_links" };

const oneLine = (s: string): string => s.replace(/\s*\r?\n\s*/g, " ").trim();

/** Whether any (non-code) link points at the page, by path or bare name (`names`, lowercase, no .md). */
export function linksTo(links: readonly ExtractedLink[], names: ReadonlySet<string>): boolean {
  return links.some((l) => {
    if (l.inCodeblock) return false;
    const t = l.target.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
    return names.has(t);
  });
}

/**
 * `added` inserted directly after the last non-blank line of the section under `heading` (so a
 * bullet extends the list instead of starting a new paragraph), or null when no heading matches.
 * An ambiguous heading throws invalid_input like patch_note does.
 */
function appendUnderHeading(
  body: string,
  heading: string,
  added: string,
  eol: string,
  rel: string,
): string | null {
  const anchor: ResolvedAnchor = { type: "heading", heading };
  const r = resolveSection(body, anchor);
  if (!r.found && r.reason === "not_found") return null;
  const span = resolveSectionOrThrow(body, anchor, rel);
  const lines = body.split(/\r?\n/);
  let at = span.endIndex;
  while (at > span.startIndex + 1 && (lines[at - 1] ?? "").trim() === "") at--;
  return [...lines.slice(0, at), ...added.split(/\r?\n/), ...lines.slice(at)].join(eol);
}

/**
 * The note after `spec`, or why it is unchanged. Pure: reads nothing, writes nothing. `page` is how
 * the new page is linked (`link`, a wikilink) and the lowercase names that count as linking it.
 * Throws invalid_input, naming the note, for a patch that cannot be applied (a missing heading, a
 * note whose frontmatter is not valid YAML, a result that would leave a code fence open).
 */
export function computePatch(
  raw: string,
  spec: WikiPatch,
  rel: string,
  page: { link: string; names: ReadonlySet<string> },
): PatchOutcome {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  if (spec.operation === "append" && spec.content === undefined)
    throw err.invalidInput("an append patch needs `content`", { path: rel });
  const added =
    spec.operation === "link"
      ? `- ${page.link}${spec.text ? ` ${oneLine(spec.text)}` : ""}`
      : (spec.content as string);

  if (spec.operation === "append" && !spec.heading) {
    const sep = raw.length > 0 && !raw.endsWith("\n") ? eol : "";
    return { applied: true, content: raw + sep + added, added };
  }

  const note = parseNote(raw, rel);
  if (spec.operation === "link" && linksTo(extractNoteLinks(note), page.names))
    return { applied: false, content: raw, reason: "already_links" };
  const heading = spec.heading ?? DEFAULT_LINK_HEADING;
  let body: string;
  const patched = appendUnderHeading(note.body, heading, added, eol, rel);
  if (patched !== null) body = patched;
  else if (spec.operation === "link")
    body = `${note.body.replace(/\s+$/, "")}${eol}${eol}## ${heading}${eol}${added}${eol}`;
  else throw err.invalidInput("heading not found", { path: rel, heading });
  if (!hasUnterminatedFence(note.body) && hasUnterminatedFence(body))
    throw err.invalidInput("patch would leave an unterminated code fence", { path: rel });
  const content = serializeNote(note.frontmatter, body, note.rawFrontmatter, {
    frontmatterEol: note.frontmatterEol,
    frontmatterAtEof: note.frontmatterAtEof,
    path: rel,
    onFallback: frontmatterFallbackSink,
  });
  return { applied: true, content, added };
}
