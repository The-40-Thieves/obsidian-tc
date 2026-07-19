// Link target rewriting, fenced-code aware. Shared by move_note (backlink update)
// and Domain 5's rewrite_link. Fenced code blocks are skipped so code samples are
// never mutated; the dominant line ending is preserved. Inline-code spans on an
// otherwise-prose line are not excluded (a documented M1 limitation).
import type { LinkKind } from "./links";

const FENCE = /^\s*(```|~~~)/;
const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MDLINK = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;

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
export type TargetMapper = (target: string, kind: LinkKind) => string | null;

export function rewriteLinks(raw: string, map: TargetMapper): { text: string; count: number } {
  let count = 0;
  const crlf = raw.includes("\r\n");
  const lines = raw.split(/\r?\n/);
  let fenced = false;
  const out = lines.map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    let l = line.replace(WIKILINK, (m, bang: string, inner: string) => {
      const { target, display, heading, pipeSep } = splitParts(inner);
      const next = map(target, bang === "!" ? "embed" : "wikilink");
      if (next === null) return m;
      count++;
      let v = next;
      if (heading !== null) v += `#${heading}`;
      if (display !== null) v += `${pipeSep}${display}`;
      return `${bang}[[${v}]]`;
    });
    l = l.replace(MDLINK, (m, bang: string, disp: string, url: string) => {
      const next = map(url.trim(), bang === "!" ? "embed" : "markdown");
      if (next === null) return m;
      count++;
      return `${bang}[${disp}](${next})`;
    });
    return l;
  });
  return { text: out.join(crlf ? "\r\n" : "\n"), count };
}
