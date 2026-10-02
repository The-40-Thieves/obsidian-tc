// Heading syntax shared by the anchor resolver (anchors.ts): the ATX heading recognizer and the
// matching of a heading anchor (literal text or a `Parent > Child` path) against a note's headings.
// Pure functions over strings; anchors.ts builds section resolution on top of them.

/** Strip ONLY ASCII space/tab indentation off the start of `line`, expanding a tab to the next
 *  4-column stop (CommonMark's rule, shared by fence AND heading indentation — review round 3
 *  G1/R3). `col` is the total indentation width in columns; `rest` is the line from the first
 *  non-space/tab character onward. Any OTHER leading whitespace-LOOKING character (NBSP U+00A0,
 *  ideographic space U+3000, ...) does NOT count as indentation — `rest` starts there instead, so
 *  the line is content, not a fence delimiter or heading, however it looks after a Unicode-aware
 *  `.trim()` — review round 4 R2. */
export function stripAsciiIndent(line: string): { col: number; rest: string } {
  let i = 0;
  let col = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " ") {
      col += 1;
      i++;
    } else if (ch === "\t") {
      col = Math.floor(col / 4) * 4 + 4;
      i++;
    } else break;
  }
  return { col, rest: line.slice(i) };
}

/** Recognizes an ATX heading LINE as a section BOUNDARY — review round 4 R3: tolerates up to 3
 *  columns of leading ASCII space/tab indentation (4+ is an indented code block, not a heading —
 *  the same CommonMark rule fences use, review round 3 M8), an optional closing hash sequence
 *  (`"## A ##"` has the title `"A"` — pre-merge U3), and an EMPTY title (`"##"` alone, `"## "` with
 *  nothing after, or a bare closing sequence like `"## ##"` / `"### ###"` — pre-merge U4) — a real, if untargetable, boundary (no caller can anchor to
 *  `heading: ""` — the schema requires `min(1)`). Review round 5 D1: this is the ONE heading
 *  recognizer in this module — `dropDuplicateLeadingHeading` tests caller-supplied content with it
 *  too. A second, stricter column-0 regex used to live here for that narrower job, which meant an
 *  indented anchor heading was a valid TARGET whose indented duplicate in `content` went
 *  undetected, reviving the GH #922 shape 2 duplication the drop exists to prevent. */
export function matchHeadingBoundary(line: string): { level: number; title: string } | null {
  const { col, rest } = stripAsciiIndent(line);
  if (col > 3) return null;
  // Pre-merge U2: the separator after the hashes is ASCII space/tab or end of line — `\s` also
  // accepted NBSP and friends, which turned a non-heading into a section boundary.
  const m = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(rest);
  if (!m) return null;
  // Pre-merge U3: an ATX closing sequence (`## A ##`) is syntax, not title text — it must be
  // preceded by a space or tab, so a trailing hash run written flush against the text (`## A#`)
  // stays part of the title. Stripped here, in the ONE shared matcher, so every consumer agrees:
  // boundary scan, anchor target, ambiguity count, and the duplicate-heading drop.
  // Pre-merge U4: a remainder that is NOTHING BUT a hash run is the closing sequence of an EMPTY
  // heading (CommonMark: `### ###` is an empty h3); the strip above cannot see it, its separator
  // having been consumed by this regex's own `[ \t]+` — untreated, the title reads `"##"`.
  const rest2 = m[2] ?? "";
  const title = /^#+[ \t]*$/.test(rest2) ? "" : rest2.replace(/[ \t]+#+[ \t]*$/, "");
  return { level: (m[1] ?? "").length, title: title.trim() };
}

export interface HeadingHit {
  index: number;
  level: number;
  title: string;
  /** Titles (lowercased) of the enclosing headings, outermost first. */
  ancestors: string[];
}

/** Every real (non-fenced) heading in `lines`, in document order, with its enclosing headings. */
export function scanHeadings(lines: string[], mask: boolean[]): HeadingHit[] {
  const out: HeadingHit[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const m = matchHeadingBoundary(lines[i] ?? "");
    if (!m) continue;
    while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= m.level)
      stack.pop();
    out.push({
      index: i,
      level: m.level,
      title: m.title,
      ancestors: stack.map((a) => a.title.toLowerCase()),
    });
    stack.push({ level: m.level, title: m.title });
  }
  return out;
}

/** Heading matches for `heading`: the text matched case-insensitively and trimmed, or, when no
 *  heading has that literal text and it contains `>`, a `Parent > Child` path — the last segment is
 *  the heading and the earlier segments must be among its enclosing headings, outermost first (not
 *  necessarily adjacent). Literal text wins so a heading that itself contains `>` stays addressable. */
export function headingMatches(headings: HeadingHit[], heading: string): HeadingHit[] {
  const want = heading.trim().toLowerCase();
  const literal = headings.filter((h) => h.title.toLowerCase() === want);
  if (literal.length > 0 || !want.includes(">")) return literal;
  const segments = want.split(">").map((x) => x.trim());
  if (segments.some((x) => x === "")) return literal;
  const leaf = segments[segments.length - 1];
  const parents = segments.slice(0, -1);
  return headings.filter((h) => {
    if (h.title.toLowerCase() !== leaf) return false;
    let at = 0;
    for (const a of h.ancestors) if (a === parents[at]) at++;
    return at === parents.length;
  });
}
