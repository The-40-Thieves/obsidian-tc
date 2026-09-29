// Equivalence: the linear scanner (link-scan.ts) must produce byte-identical output to the
// regex parse it replaced. `oldExtractLinks`/`oldRewriteLinks` below are a frozen copy of the
// PRE-FIX regex-based implementation (the exact WIKILINK/MDLINK regexes and surrounding logic
// links.ts/rewrite.ts used before switching to scanWikilinks/scanMdLinks) — an independent oracle,
// not a wrapper around the code under test. Compared over: the repo's own generated random
// markdown corpus (nested brackets, images, escaped chars, code fences/inline code, CRLF) and,
// read-only, the owner's real vault when present.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ExtractedLink, extractLinks } from "../src/vault/links";
import { rewriteLinks } from "../src/vault/rewrite";

// ---- frozen oracle: verbatim pre-fix regex logic ----

const OLD_FENCE = /^\s*(```|~~~)/;
const OLD_WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
const OLD_MDLINK = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const OLD_INLINE_CODE = /`[^`]*`/g;

function oldSplitWikilink(inner: string): {
  target: string;
  display: string | null;
  heading: string | null;
} {
  let rest = inner;
  let display: string | null = null;
  const pipeM = rest.match(/\\?\|/);
  if (pipeM?.index !== undefined) {
    display = rest.slice(pipeM.index + pipeM[0].length).trim();
    rest = rest.slice(0, pipeM.index);
  }
  let heading: string | null = null;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    heading = rest.slice(hash + 1).trim() || null;
    rest = rest.slice(0, hash);
  }
  return { target: rest.trim(), display, heading };
}

function oldCodeRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of line.matchAll(OLD_INLINE_CODE)) {
    const i = m.index ?? 0;
    ranges.push([i, i + m[0].length]);
  }
  return ranges;
}
function oldInCode(ranges: Array<[number, number]>, idx: number): boolean {
  return ranges.some(([a, b]) => idx >= a && idx < b);
}

function oldExtractLinks(body: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const lines = body.split(/\r?\n/);
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (OLD_FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    const ranges = fenced ? [] : oldCodeRanges(line);
    for (const m of line.matchAll(OLD_WIKILINK)) {
      const idx = m.index ?? 0;
      const embed = m[1] === "!";
      const { target, display, heading } = oldSplitWikilink(m[2] ?? "");
      out.push({
        raw: m[0],
        kind: embed ? "embed" : "wikilink",
        target,
        display,
        heading,
        line: i + 1,
        col: idx + 1,
        inCodeblock: fenced || oldInCode(ranges, idx),
      });
    }
    for (const m of line.matchAll(OLD_MDLINK)) {
      const idx = m.index ?? 0;
      const embed = m[1] === "!";
      out.push({
        raw: m[0],
        kind: embed ? "embed" : "markdown",
        target: (m[3] ?? "").trim(),
        display: (m[2] ?? "").trim() || null,
        heading: null,
        line: i + 1,
        col: idx + 1,
        inCodeblock: fenced || oldInCode(ranges, idx),
      });
    }
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return out;
}

function oldRewriteLinks(
  raw: string,
  map: (t: string, k: string) => string | null,
): { text: string; count: number } {
  let count = 0;
  const crlf = raw.includes("\r\n");
  const lines = raw.split(/\r?\n/);
  let fenced = false;
  const out = lines.map((line) => {
    if (OLD_FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    let l = line.replace(OLD_WIKILINK, (m, bang: string, inner: string) => {
      const { target, display, heading } = oldSplitWikilink(inner);
      const next = map(target, bang === "!" ? "embed" : "wikilink");
      if (next === null) return m;
      count++;
      let v = next;
      if (heading !== null) v += `#${heading}`;
      if (display !== null) v += `|${display}`;
      return `${bang}[[${v}]]`;
    });
    l = l.replace(OLD_MDLINK, (m, bang: string, disp: string, url: string) => {
      const next = map(url.trim(), bang === "!" ? "embed" : "markdown");
      if (next === null) return m;
      count++;
      return `${bang}[${disp}](${next})`;
    });
    return l;
  });
  return { text: out.join(crlf ? "\r\n" : "\n"), count };
}

// ---- random markdown corpus generator ----

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  "[[Note]]",
  "[[Note|Alias]]",
  "![[Embed.png]]",
  "[[Note#Heading]]",
  "[[Note#Heading|Alias]]",
  "[link](https://example.com)",
  "![alt](image.png)",
  "[![alt](inner.png)](outer.png)",
  "[a](",
  "[[unclosed",
  "[[a\\|b]]",
  "| [[Table\\|Cell]] |",
  "`code with [[not a link]]`",
  "```\n[[fenced not a link]]\n```",
  "plain text with no links at all",
  "[]()",
  "[[]]",
  "[empty]()",
  "[[a]] [b](c) ![[d]] ![e](f)",
  "line with a lone [ bracket",
  "line with a lone ] bracket",
  "line with a lone ( paren",
  "line with a lone ) paren",
  "\r\n",
  "\n",
];

function randomCorpus(seed: number, lines: number): string {
  const rnd = mulberry32(seed);
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const nFrags = 1 + Math.floor(rnd() * 4);
    const parts: string[] = [];
    for (let j = 0; j < nFrags; j++) {
      parts.push(FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)] ?? "");
    }
    out.push(parts.join(" "));
  }
  return out.join("\n");
}

describe("link-scan equivalence: new scanner matches the frozen pre-fix regex oracle", () => {
  it("matches on a large generated random corpus (extractLinks)", () => {
    let differ = 0;
    let checked = 0;
    for (let seed = 0; seed < 50; seed++) {
      const doc = randomCorpus(seed, 40);
      checked++;
      const oldOut = oldExtractLinks(doc);
      const newOut = extractLinks(doc);
      if (JSON.stringify(oldOut) !== JSON.stringify(newOut)) differ++;
    }
    expect({ checked, differ }).toEqual({ checked, differ: 0 });
  });

  it("matches on a large generated random corpus (rewriteLinks, identity map)", () => {
    let differ = 0;
    let checked = 0;
    const map = (t: string) => (t.includes("Note") ? `${t}-renamed` : null);
    for (let seed = 100; seed < 150; seed++) {
      const doc = randomCorpus(seed, 40);
      checked++;
      const oldOut = oldRewriteLinks(doc, map);
      const newOut = rewriteLinks(doc, map);
      if (oldOut.text !== newOut.text || oldOut.count !== newOut.count) differ++;
    }
    expect({ checked, differ }).toEqual({ checked, differ: 0 });
  });

  it("matches over the owner's real vault, read-only, if present", () => {
    const vaultDir = "/home/ubuntu/Documents/Obsidian Vault";
    let files: string[] = [];
    try {
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith(".")) continue; // skip .obsidian/.claude/etc plugin dirs
          const p = join(dir, entry);
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else if (entry.endsWith(".md")) files.push(p);
        }
      };
      walk(vaultDir);
    } catch {
      files = [];
    }
    if (files.length === 0) {
      // No vault available in this environment — not a failure, just nothing to check.
      expect(files.length).toBe(0);
      return;
    }
    let differ = 0;
    const diffs: string[] = [];
    for (const f of files) {
      const body = readFileSync(f, "utf8");
      const oldOut = oldExtractLinks(body);
      const newOut = extractLinks(body);
      if (JSON.stringify(oldOut) !== JSON.stringify(newOut)) {
        differ++;
        diffs.push(f);
      }
    }
    if (differ > 0) console.error("real-vault extractLinks mismatches:", diffs.slice(0, 10));
    expect({ total: files.length, differ }).toEqual({ total: files.length, differ: 0 });
  });
});
