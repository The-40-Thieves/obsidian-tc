// Link target rewriting, fenced-code aware. Shared by move_note (backlink update)
// and Domain 5's rewrite_link. Fenced code blocks are skipped so code samples are
// never mutated; the dominant line ending is preserved. Inline-code spans on an
// otherwise-prose line are not excluded (a documented M1 limitation).
import { err, ObsidianTcError, wikiLinkNameProblem } from "@the-40-thieves/obsidian-tc-shared";
import { redactSecrets } from "../experiential/redact";
import { frontmatterYamlSpan, splitFrontmatterBody } from "./frontmatter";
import { applyScanReplacements, scanMdLinks, scanWikilinks } from "./link-scan";
import {
  type PropertyRewriteWarning,
  rewriteFrontmatterProperties,
  type TargetMapper,
} from "./rewrite-properties";

const FENCE = /^\s*(```|~~~)/;

function splitParts(inner: string): {
  target: string;
  display: string | null;
  heading: string | null;
  // The alias separator as written: "\|" inside a table, "|" otherwise. Re-emitted
  // verbatim so a rewrite cannot unescape a table pipe and break the row (GH #279).
  pipeSep: string;
} {
  let rest = inner;
  let display: string | null = null;
  let heading: string | null = null;
  let pipeSep = "|";
  const pipeM = rest.match(/\\?\|/);
  if (pipeM?.index !== undefined) {
    pipeSep = pipeM[0];
    display = rest.slice(pipeM.index + pipeM[0].length);
    rest = rest.slice(0, pipeM.index);
  }
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    heading = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  return { target: rest.trim(), display, heading, pipeSep };
}

/** Map a link target to its replacement, or null to leave it unchanged. */
export type { TargetMapper };

export interface RewriteOptions {
  /** The mapped target is a vault PATH or file name, never free text: it must come back out of the
   *  re-parse exactly as written. A `#` or `^` in it (an existing folder called `C#`) would be read
   *  as a heading or block reference, so `[[C#/Note]]` points at note `C`: refused, not emitted.
   *  rewrite_link leaves this off, since its to_target may legitimately end in its own `#heading`. */
  exactTarget?: boolean;
}

/** Refuse the whole rewrite: `next` cannot be written as exactly one link. Names the characters
 *  that break it, never the target itself (it is caller-chosen and may be secret-shaped). */
function refuseLink(next: string): never {
  const chars = wikiLinkNameProblem(next);
  throw err.invalidInput(
    `link rewrite refused: the new link target cannot be written as a single link${
      chars ? ` (it contains ${chars.join(" ")})` : ""
    }`,
    chars ? { characters: chars } : undefined,
  );
}

/** Defence in depth for every link `rewriteText` changes: the caller-chosen target is spliced into
 *  link syntax, so re-parse what was emitted and prove it is still exactly ONE link, spanning the
 *  whole emitted text, whose target (and heading, alias, separator) are the intended ones. A target
 *  that closes the link early, opens a second one, starts an alias or heading, or breaks the line
 *  would write text into the note around the link. Throws, so a note's edit is refused whole and
 *  the all-or-nothing writer persists none of them. */
function proveWikilink(
  emitted: string,
  intended: ReturnType<typeof splitParts>,
  next: string,
  bang: boolean,
  context: LinkContext,
  exact: boolean,
): void {
  // A frontmatter property value is a YAML scalar that already carries its own proof (#1115's
  // rewrite-properties.ts: the value must re-parse as the intended string), and its target may
  // legitimately hold `#` or a lone bracket there. It still must not close or open a link, start an
  // alias, open a comment or break the line.
  if (context === "property") {
    if (/[\r\n]|\[\[|\]\]|%%|\|/.test(next) || (exact && /[#^]/.test(next))) refuseLink(next);
    return;
  }
  const found = scanWikilinks(emitted);
  const only = found.length === 1 ? found[0] : undefined;
  const again = only ? splitParts(only.inner) : undefined;
  // `next` may itself end in a `#heading` (rewrite_link's to_target is free text): that tail joins
  // the heading the link already had, and anything else about the target must survive the re-parse.
  const hash = exact ? -1 : next.indexOf("#");
  const expectedTarget = (hash < 0 ? next : next.slice(0, hash)).trim();
  const expectedHeading =
    hash < 0
      ? intended.heading
      : `${next.slice(hash + 1)}${intended.heading === null ? "" : `#${intended.heading}`}`;
  if (
    /[\r\n]/.test(next) ||
    next.includes("%%") ||
    (exact && /[#^]/.test(next)) ||
    !only ||
    only.start !== 0 ||
    only.end !== emitted.length ||
    only.bang !== bang ||
    !again ||
    again.target !== expectedTarget ||
    again.heading !== expectedHeading ||
    again.display !== intended.display ||
    again.pipeSep !== intended.pipeSep
  )
    refuseLink(next);
}

function proveMdLink(
  emitted: string,
  display: string,
  next: string,
  bang: boolean,
  exact: boolean,
): void {
  const found = scanMdLinks(emitted);
  const only = found.length === 1 ? found[0] : undefined;
  // The scanner has no angle-bracket form (`[x](<a (b).md>)`): a `)` ends the url, so a target
  // holding one fails the whole-span check below and is refused rather than written broken.
  if (
    /[\r\n]/.test(next) ||
    (exact && next.includes("#")) ||
    !only ||
    only.start !== 0 ||
    only.end !== emitted.length ||
    only.bang !== bang ||
    only.display !== display ||
    only.url.trim() !== next.trim()
  )
    refuseLink(next);
}

/** Where the text being rewritten lives: a note body (every changed link is re-parsed and proven),
 *  or a frontmatter property value (see proveWikilink). */
type LinkContext = "body" | "property";

function rewriteText(
  raw: string,
  map: TargetMapper,
  crlf = raw.includes("\r\n"),
  context: LinkContext = "body",
  exact = false,
): { text: string; count: number } {
  let count = 0;
  const lines = raw.split(/\r?\n/);
  let fenced = false;
  const out = lines.map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    let l = applyScanReplacements(line, scanWikilinks(line), (m) => {
      const bang = m.bang ? "!" : "";
      const parts = splitParts(m.inner);
      const { target, display, heading, pipeSep } = parts;
      const next = map(target, m.bang ? "embed" : "wikilink");
      if (next === null) return m.raw;
      count++;
      let v = next;
      if (heading !== null) v += `#${heading}`;
      if (display !== null) v += `${pipeSep}${display}`;
      const emitted = `${bang}[[${v}]]`;
      proveWikilink(emitted, parts, next, m.bang, context, exact);
      return emitted;
    });
    l = applyScanReplacements(l, scanMdLinks(l), (m) => {
      const bang = m.bang ? "!" : "";
      const next = map(m.url.trim(), m.bang ? "embed" : "markdown");
      if (next === null) return m.raw;
      count++;
      const emitted = `${bang}[${m.display}](${next})`;
      proveMdLink(emitted, m.display, next, m.bang, exact);
      return emitted;
    });
    return l;
  });
  return { text: out.join(crlf ? "\r\n" : "\n"), count };
}

export interface LinkRewrite {
  text: string;
  count: number;
  /** Property rewrites refused or degraded, for the caller's per-note warning. */
  warnings: PropertyRewriteWarning[];
}

/** Rewrite every link `map` repoints: the body as text, frontmatter properties as YAML values
 *  (rewrite-properties.ts). A property that cannot be written back as valid YAML is left
 *  untouched and reported in `warnings`; the body is rewritten regardless, and the note is one
 *  returned string, so nothing is ever half-applied. */
export function rewriteLinks(
  raw: string,
  map: TargetMapper,
  opts: RewriteOptions = {},
): LinkRewrite {
  const exact = opts.exactTarget === true;
  const crlf = raw.includes("\r\n");
  const body = splitFrontmatterBody(raw);
  const span = frontmatterYamlSpan(raw);
  if (!span) return { ...rewriteText(body, map, crlf, "body", exact), warnings: [] };
  const yamlText = raw.slice(span.start, span.end);
  let yamlOut = yamlText;
  let count = 0;
  let warnings: PropertyRewriteWarning[] = [];
  if (/\[\[|\]\(/.test(yamlText)) {
    const props = rewriteFrontmatterProperties(yamlText, map, (t, m) =>
      rewriteText(t, m, undefined, "property", exact),
    );
    if (props) ({ text: yamlOut, count, warnings } = props);
    else {
      // Already invalid YAML: nothing to prove a rewrite against, and it cannot get more invalid.
      const legacy = rewriteText(yamlText, map, crlf, "property", exact);
      yamlOut = legacy.text;
      count = legacy.count;
      if (count > 0)
        warnings = [
          { message: "frontmatter is not valid YAML: its links were rewritten as plain text" },
        ];
    }
  }
  const b = rewriteText(body, map, crlf, "body", exact);
  return {
    text:
      raw.slice(0, span.start) + yamlOut + raw.slice(span.end, raw.length - body.length) + b.text,
    count: count + b.count,
    warnings,
  };
}

/** `rewriteLinks` for a move or rename, which a caller runs as a PLAN before it commits anything.
 *  The mapped target is a path, so it is proven exactly (see RewriteOptions.exactTarget). A link
 *  that cannot be written is refused as an invalid_input naming the note it sits in and the target
 *  it would have to carry, so the caller can refuse the whole move: nothing is moved, nothing is
 *  written, and a retry is not an indeterminate_outcome. */
export function rewriteLinksForMove(raw: string, map: TargetMapper, note: string): LinkRewrite {
  let last: string | null = null;
  try {
    return rewriteLinks(
      raw,
      (target, kind) => {
        const next = map(target, kind);
        if (next !== null) last = next;
        return next;
      },
      { exactTarget: true },
    );
  } catch (e) {
    if (!(e instanceof ObsidianTcError) || e.code !== "invalid_input") throw e;
    const shownNote = redactSecrets(note).text;
    const target = last === null ? undefined : redactSecrets(last).text;
    throw err.invalidInput(
      `move refused: a link in ${shownNote} cannot be rewritten to point at the destination${
        target === undefined ? "" : ` (${target})`
      }. ${e.message}. Nothing was moved.`,
      { ...e.details, note: shownNote, ...(target === undefined ? {} : { target }) },
    );
  }
}
