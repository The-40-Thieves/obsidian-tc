// Link target rewriting, fenced-code aware. Shared by move_note (backlink update)
// and Domain 5's rewrite_link. Fenced code blocks are skipped so code samples are
// never mutated; the dominant line ending is preserved. Inline-code spans on an
// otherwise-prose line are not excluded (a documented M1 limitation).
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

function rewriteText(
  raw: string,
  map: TargetMapper,
  crlf = raw.includes("\r\n"),
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
      const { target, display, heading, pipeSep } = splitParts(m.inner);
      const next = map(target, m.bang ? "embed" : "wikilink");
      if (next === null) return m.raw;
      count++;
      let v = next;
      if (heading !== null) v += `#${heading}`;
      if (display !== null) v += `${pipeSep}${display}`;
      return `${bang}[[${v}]]`;
    });
    l = applyScanReplacements(l, scanMdLinks(l), (m) => {
      const bang = m.bang ? "!" : "";
      const next = map(m.url.trim(), m.bang ? "embed" : "markdown");
      if (next === null) return m.raw;
      count++;
      return `${bang}[${m.display}](${next})`;
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
export function rewriteLinks(raw: string, map: TargetMapper): LinkRewrite {
  const crlf = raw.includes("\r\n");
  const body = splitFrontmatterBody(raw);
  const span = frontmatterYamlSpan(raw);
  if (!span) return { ...rewriteText(body, map, crlf), warnings: [] };
  const yamlText = raw.slice(span.start, span.end);
  let yamlOut = yamlText;
  let count = 0;
  let warnings: PropertyRewriteWarning[] = [];
  if (/\[\[|\]\(/.test(yamlText)) {
    const props = rewriteFrontmatterProperties(yamlText, map, rewriteText);
    if (props) ({ text: yamlOut, count, warnings } = props);
    else {
      // Already invalid YAML: nothing to prove a rewrite against, and it cannot get more invalid.
      const legacy = rewriteText(yamlText, map, crlf);
      yamlOut = legacy.text;
      count = legacy.count;
      if (count > 0)
        warnings = [
          { message: "frontmatter is not valid YAML: its links were rewritten as plain text" },
        ];
    }
  }
  const b = rewriteText(body, map, crlf);
  return {
    text:
      raw.slice(0, span.start) + yamlOut + raw.slice(span.end, raw.length - body.length) + b.text,
    count: count + b.count,
    warnings,
  };
}
