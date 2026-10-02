// Linear-time scanner for `[[wikilinks]]`/`![[embeds]]` and `[md](links)`/`![md](embeds)`,
// replacing the regex parse both links.ts (extractLinks) and rewrite.ts (rewriteLinks) used to
// duplicate: `/(!?)\[\[([^\]\n]+?)\]\]/g` and `/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g`.
//
// Both regexes are O(n^2) on adversarial input (measured: an 80 KB line of repeated "[a](" with
// no closing ")" took 11+ seconds). The character classes forbid the delimiter they are looking
// for (`[^\]\n]` can never consume a `]`), so a single match attempt never backtracks internally —
// but every FAILED start position (every "[" with no eventual closer on the line) re-scans forward
// to the end of the line before giving up, and a crafted line can have O(n) such starts. `recheck`
// (github.com/makenowjust-labs/recheck) confirms both as "vulnerable, polynomial degree 2"; see
// scripts/check-redos.mjs, which re-runs that check on every regex here and in experiential/ as a
// recurrence guard.
//
// The fix: precompute, once per line, the index of the next `]` (and `)`) at or after every
// position — an O(n) backward pass — so each candidate start position resolves its closing
// delimiter in O(1) instead of rescanning. The scan loop below then walks the line exactly once,
// mirroring `String.matchAll`'s per-position retry-on-failure / skip-past-match-on-success
// semantics, so output is byte-identical to the regex it replaces (see
// test/link-scan-equivalence.test.ts) at O(n) total cost (see test/link-scan-perf.test.ts).

/** next[i] = index of the first occurrence of `ch` in `line` at position >= i, or -1. */
function nextOccurrence(line: string, ch: string): Int32Array {
  const n = line.length;
  const next = new Int32Array(n + 1);
  next[n] = -1;
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (line[i] === ch) last = i;
    next[i] = last;
  }
  return next;
}

export interface WikiScanMatch {
  /** Index of the match's first character (the `!` when `bang`, else the first `[`). */
  start: number;
  /** Index just past the closing `]]`. */
  end: number;
  raw: string;
  bang: boolean;
  /** Raw text between `[[` and `]]`, unsplit (callers separate heading/alias/target). */
  inner: string;
}

export interface MdScanMatch {
  start: number;
  end: number;
  raw: string;
  bang: boolean;
  display: string;
  url: string;
}

/** Equivalent to `[...line.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)]`, in O(line.length). */
export function scanWikilinks(line: string): WikiScanMatch[] {
  const out: WikiScanMatch[] = [];
  const n = line.length;
  if (n === 0) return out;
  const nextBracket = nextOccurrence(line, "]");
  let i = 0;
  while (i < n) {
    const bang = line[i] === "!";
    const open = bang ? i + 1 : i;
    if (line[open] !== "[" || line[open + 1] !== "[") {
      i++;
      continue;
    }
    const contentStart = open + 2;
    const close1 = (contentStart <= n ? nextBracket[contentStart] : -1) ?? -1;
    // `[^\]\n]+?` requires >= 1 char before the first `]`, then a second literal `]`.
    if (close1 === -1 || close1 === contentStart || line[close1 + 1] !== "]") {
      i++;
      continue;
    }
    const end = close1 + 2;
    out.push({
      start: i,
      end,
      raw: line.slice(i, end),
      bang,
      inner: line.slice(contentStart, close1),
    });
    i = end;
  }
  return out;
}

/** Equivalent to `[...line.matchAll(/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g)]`, in O(line.length). */
export function scanMdLinks(line: string): MdScanMatch[] {
  const out: MdScanMatch[] = [];
  const n = line.length;
  if (n === 0) return out;
  const nextBracket = nextOccurrence(line, "]");
  const nextParen = nextOccurrence(line, ")");
  let i = 0;
  while (i < n) {
    const bang = line[i] === "!";
    const open = bang ? i + 1 : i;
    if (line[open] !== "[") {
      i++;
      continue;
    }
    const dispStart = open + 1;
    // `[^\]\n]*` allows zero chars, so close === dispStart (empty display "[]") is valid.
    const close = (dispStart <= n ? nextBracket[dispStart] : -1) ?? -1;
    if (close === -1 || line[close + 1] !== "(") {
      i++;
      continue;
    }
    const urlStart = close + 2;
    // `[^)\n]+` requires >= 1 char, so closeParen === urlStart (empty "()") is invalid.
    const closeParen = (urlStart <= n ? nextParen[urlStart] : -1) ?? -1;
    if (closeParen === -1 || closeParen === urlStart) {
      i++;
      continue;
    }
    const end = closeParen + 1;
    out.push({
      start: i,
      end,
      raw: line.slice(i, end),
      bang,
      display: line.slice(dispStart, close),
      url: line.slice(urlStart, closeParen),
    });
    i = end;
  }
  return out;
}

/** Rebuild a line with each match's span replaced by `replacement(match)`, preserving everything
 *  between matches verbatim — the scan-based equivalent of `line.replace(globalRegex, cb)`. */
export function applyScanReplacements<M extends { start: number; end: number }>(
  line: string,
  matches: M[],
  replacement: (m: M) => string,
): string {
  if (matches.length === 0) return line;
  let result = "";
  let last = 0;
  for (const m of matches) {
    result += line.slice(last, m.start);
    result += replacement(m);
    last = m.end;
  }
  result += line.slice(last);
  return result;
}

export type LinkScanMatch =
  | ({ kind: "wikilink" } & WikiScanMatch)
  | ({ kind: "mdlink" } & MdScanMatch);

/** Equivalent to `[...line.matchAll(/(!?)\[\[([^\]\n]+?)\]\]|(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g)]`
 *  (prune.ts's single alternation `LINK` regex, another duplicate of the same O(n^2) shape), in
 *  O(line.length). At any start position the wikilink and mdlink local checks are mutually
 *  exclusive: both would require the character right after the bracketed content's `]` to be
 *  simultaneously `]` (wikilink) and `(` (mdlink), which is impossible — so trying wikilink first
 *  reproduces the alternation's left-to-right, first-alternative-wins semantics exactly. */
export function scanLinks(line: string): LinkScanMatch[] {
  const out: LinkScanMatch[] = [];
  const n = line.length;
  if (n === 0) return out;
  const nextBracket = nextOccurrence(line, "]");
  const nextParen = nextOccurrence(line, ")");
  let i = 0;
  while (i < n) {
    const bang = line[i] === "!";
    const open = bang ? i + 1 : i;
    if (line[open] === "[" && line[open + 1] === "[") {
      const contentStart = open + 2;
      const close1 = (contentStart <= n ? nextBracket[contentStart] : -1) ?? -1;
      if (close1 !== -1 && close1 !== contentStart && line[close1 + 1] === "]") {
        const end = close1 + 2;
        out.push({
          kind: "wikilink",
          start: i,
          end,
          raw: line.slice(i, end),
          bang,
          inner: line.slice(contentStart, close1),
        });
        i = end;
        continue;
      }
    }
    if (line[open] === "[") {
      const dispStart = open + 1;
      const close = (dispStart <= n ? nextBracket[dispStart] : -1) ?? -1;
      if (close !== -1 && line[close + 1] === "(") {
        const urlStart = close + 2;
        const closeParen = (urlStart <= n ? nextParen[urlStart] : -1) ?? -1;
        if (closeParen !== -1 && closeParen !== urlStart) {
          const end = closeParen + 1;
          out.push({
            kind: "mdlink",
            start: i,
            end,
            raw: line.slice(i, end),
            bang,
            display: line.slice(dispStart, close),
            url: line.slice(urlStart, closeParen),
          });
          i = end;
          continue;
        }
      }
    }
    i++;
  }
  return out;
}

/** Inline `` `code` `` runs on one line, as a FLAT list of half-open spans: `[start0, end0, start1,
 *  end1, ...]`, in increasing order and pairwise disjoint (each run resumes after the previous
 *  one). A flat number list, not `[start, end]` tuples from `matchAll`: a line of "`x" repeated
 *  holds one span per 4 bytes, and a match array plus a tuple per span put enough live objects on
 *  the heap to push 2 MB inputs into GC promotion (scan time 2.5x per doubling on macOS CI,
 *  slope 1.64 over the 1.6 cap); the flat list allocates no per-span object. */
export function inlineCodeRanges(line: string): number[] {
  const spans: number[] = [];
  let open = line.indexOf("`");
  while (open >= 0) {
    const close = line.indexOf("`", open + 1);
    if (close < 0) break; // an unclosed run has no closing backtick, so no later run can match either
    spans.push(open, close + 1);
    open = line.indexOf("`", close + 1);
  }
  return spans;
}

/** Whether `idx` falls inside one of `ranges` (sorted and disjoint, as `inlineCodeRanges`
 *  returns them). Binary search: a per-link/per-tag `ranges.some` was O(spans x matches) — a line
 *  of "`a`[b](c) " repeated measured 23 s at 640 KB — where this is O(log spans). */
export function inCodeRange(ranges: ReadonlyArray<number>, idx: number): boolean {
  let lo = 0;
  let hi = (ranges.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (idx < (ranges[mid * 2] as number)) hi = mid - 1;
    else if (idx >= (ranges[mid * 2 + 1] as number)) lo = mid + 1;
    else return true;
  }
  return false;
}
