// Equivalence: the linear scanner (link-scan.ts), the O(log n) inline-code marking and the
// call sites built on them must produce byte-identical output to the regex implementations they
// replaced. The oracle is test/link-scan-oracle.ts: a verbatim, commit-pinned copy of main's
// links.ts / rewrite.ts / prune.ts / tags.ts (cb8f1da8) — NOT a re-implementation, so it keeps
// rewrite.ts's real behaviour (the original `\|` vs `|` alias separator, no trimming). Compared
// over a hand-written edge-case corpus, the repo's generated random markdown corpus and,
// read-only, the owner's real vault when present (an explicit, reported skip otherwise).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inCodeRange, inlineCodeRanges, scanLinks } from "../src/vault/link-scan";
import { buildVaultIndex, extractLinks } from "../src/vault/links";
import { type PrunePolicy, pruneHubLinks } from "../src/vault/prune";
import { rewriteLinks } from "../src/vault/rewrite";
import { extractInlineTags } from "../src/vault/tags";
import {
  ORIGINAL_PRUNE_LINK,
  originalExtractInlineTags,
  originalExtractLinks,
  originalPruneHubLinks,
  originalRewriteLinks,
} from "./link-scan-oracle";

// ---- hand-written edge cases (each one a distinct link shape) ----

const EDGE_CASES: Record<string, string> = {
  plain: "see [[Note]] and [text](a.md)",
  "escaped pipe (table)": "| [[Note\\|Alias]] | b |",
  "escaped pipe with heading": "| [[Note#Head\\|Alias]] |",
  "unescaped pipe alias": "[[Note|Alias]]",
  "spaced alias": "[[Note | Spaced Alias ]]",
  "spaced target": "[[  Note  ]]",
  "spaced escaped pipe": "[[Note \\| Alias ]]",
  heading: "[[Note#Heading]]",
  "heading spaced": "[[Note# Heading with spaces ]]",
  "heading and alias": "[[Note#Heading|Alias]]",
  "block ref": "[[Note#^block-id]]",
  "block ref and alias": "[[Note#^block-id|Alias]]",
  "empty heading": "[[Note#]]",
  "embed wikilink": "![[Image.png]]",
  "embed with size": "![[Image.png|200]]",
  "embed markdown": "![alt](img.png)",
  "nested brackets in display": "[a [b] c](url.md)",
  "nested wikilink in md display": "[[[Note]]](x.md)",
  "image inside link": "[![alt](inner.png)](outer.png)",
  "nested parens in url": "[a](b(c)d.md)",
  "angle url": "[a](<my file.md>)",
  "url with title": '[a](b.md "Title")',
  "url with single-quoted title": "[a](b.md 'Title')",
  "empty display": "[](x.md)",
  "empty url": "[a]()",
  "empty wikilink": "[[]]",
  "spaced url": "[a](  spaced.md  )",
  "unterminated wikilink": "[[unclosed and [[Note]]",
  "unterminated md": "[a](no close [b](c.md)",
  "many unterminated": "[a]([a]([a](",
  "lone brackets": "a [ b ] c ( d ) e",
  "adjacent links": "[[a]][[b]][c](d)[e](f)",
  "wikilink then md": "[[a]](b.md)",
  "bang edge": "!!![[a]] ![b](c) !",
  "inline code with link": "`[[Note]]` and [[Other]] and `[a](b.md)`",
  "inline code around link": "`x` [[Note]] `y` [a](b.md) `z`",
  "unclosed backtick": "`x [[Note]] [a](b.md)",
  "fenced backticks": "```\n[[Note]]\n```\n[[After]]",
  "fenced tildes": "~~~\n[a](b.md)\n~~~\n[a](c.md)",
  "unclosed fence": "```\n[[Note]]\n[a](b.md)",
  "indented fence": "  ```js\n[[Note]]\n  ```\n[[Out]]",
  crlf: "[[Note]]\r\n[a](b.md)\r\n```\r\n[[x]]\r\n```\r\n[[y]]",
  "mixed line endings": "[[Note]]\n[a](b.md)\r\n[[c]]",
  unicode: "[[日本語|エイリアス]] [\u{1F600}](\u{1F4A9}.md) [[Ünï]] ![[é#ü]]",
  "surrogate pair boundary": "\u{1F600}[[a]]\u{1F600}[b](c)\u{1F600}",
  "table row": "| [[A\\|x]] | [b](c.md) | `[[code]]` |",
  "bullet list": "- [[A]]\n- [[B]]\n  - [c](d.md)\n- [[A]]",
  "external and internal": "[ext](https://example.com/x) [int](x.md) [[Note]]",
  "hash in md url": "[a](b.md#section)",
  "no links": "just prose, no links, `code`, #tag",
};

const EDGE_TAG_CASES: Record<string, string> = {
  "tag then code": "`#code` #real `#c2` #real2",
  "code between tags": "#a `x` #b `y` #c",
  "tag in fence": "```\n#nope\n```\n#yes",
  "hierarchical and numeric": "#project/sub #123 #a-b #_x #1a/",
  "tag after link": "[[Note]] #t [a](b.md) #u",
  "unclosed backtick": "`#a #b",
};

const PRUNE_INDEX = buildVaultIndex(["Note.md", "a.md", "b.md", "c.md", "dir/Other.md"]);
const PRUNE_POLICIES: PrunePolicy[] = [
  { removeUnresolved: true, removeDuplicates: false },
  { removeUnresolved: false, removeDuplicates: true },
  { removeUnresolved: true, removeDuplicates: true },
];

const renameAll = (t: string): string => `${t}-moved`;
const MAPS: Record<string, (t: string, k: string) => string | null> = {
  "rename all": renameAll,
  "identity (count only)": (t) => t,
  "skip embeds, upcase rest": (t, k) => (k === "embed" ? null : t.toUpperCase()),
  "spaced replacement": (t) => `New Name ${t}`,
};

function sameMatches(line: string): void {
  const oracle = [...line.matchAll(ORIGINAL_PRUNE_LINK)].map((m) =>
    m[2] !== undefined
      ? { kind: "wikilink", start: m.index, raw: m[0], bang: m[1] === "!", a: m[2], b: "" }
      : { kind: "mdlink", start: m.index, raw: m[0], bang: m[3] === "!", a: m[4], b: m[5] },
  );
  const scanned = scanLinks(line).map((m) =>
    m.kind === "wikilink"
      ? { kind: m.kind, start: m.start, raw: m.raw, bang: m.bang, a: m.inner, b: "" }
      : { kind: m.kind, start: m.start, raw: m.raw, bang: m.bang, a: m.display, b: m.url },
  );
  expect(scanned).toEqual(oracle);
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

function sameEverywhere(doc: string): void {
  expect(extractLinks(doc)).toEqual(originalExtractLinks(doc));
  for (const [, map] of Object.entries(MAPS)) {
    expect(rewriteLinks(doc, map)).toEqual(originalRewriteLinks(doc, map));
  }
  for (const policy of PRUNE_POLICIES) {
    expect(pruneHubLinks(doc, PRUNE_INDEX, policy)).toEqual(
      originalPruneHubLinks(doc, PRUNE_INDEX, policy),
    );
  }
  for (const line of doc.split(/\r?\n/)) sameMatches(line);
  expect(extractInlineTags(doc)).toEqual(originalExtractInlineTags(doc));
}

const VAULT_DIR = "/home/ubuntu/Documents/Obsidian Vault";

describe("link-scan equivalence: production matches the commit-pinned regex oracle", () => {
  it("has a non-trivial edge-case corpus (existence floor)", () => {
    expect(Object.keys(EDGE_CASES).length).toBeGreaterThanOrEqual(43);
    expect(Object.keys(EDGE_TAG_CASES).length).toBeGreaterThanOrEqual(5);
  });

  for (const [name, doc] of Object.entries(EDGE_CASES)) {
    it(`edge case: ${name}`, () => {
      sameEverywhere(doc);
    });
  }

  for (const [name, doc] of Object.entries(EDGE_TAG_CASES)) {
    it(`tag edge case: ${name}`, () => {
      expect(extractInlineTags(doc)).toEqual(originalExtractInlineTags(doc));
    });
  }

  it("the escaped-pipe rewrite keeps `\\|` and does not trim (oracle is main's, not a re-implementation)", () => {
    // Guards the oracle itself: a re-implementation that always wrote `|` and trimmed would
    // differ from main's rewrite.ts on exactly these two inputs.
    const map = (t: string) => `${t}-x`;
    expect(originalRewriteLinks("[[N\\|Alias]]", map).text).toBe("[[N-x\\|Alias]]");
    expect(originalRewriteLinks("[[N| spaced ]]", map).text).toBe("[[N-x| spaced ]]");
    expect(rewriteLinks("[[N\\|Alias]]", map).text).toBe("[[N-x\\|Alias]]");
    expect(rewriteLinks("[[N| spaced ]]", map).text).toBe("[[N-x| spaced ]]");
  });

  it("inlineCodeRanges matches the old regex, and inCodeRange agrees with a linear scan at every index", () => {
    const lines = [...Object.values(EDGE_CASES), ...Object.values(EDGE_TAG_CASES), "``` `a``b` ``"];
    let indices = 0;
    for (const line of lines.flatMap((l) => l.split(/\r?\n/))) {
      const ranges = inlineCodeRanges(line);
      // The oracle is the regex the flat scan replaced, kept as [start, end) tuples.
      const oracle = [...line.matchAll(/`[^`]*`/g)].map((m): [number, number] => [
        m.index ?? 0,
        (m.index ?? 0) + m[0].length,
      ]);
      expect(ranges).toEqual(oracle.flat());
      for (let idx = -1; idx <= line.length + 1; idx++) {
        const linear = oracle.some(([a, b]) => idx >= a && idx < b);
        expect(inCodeRange(ranges, idx)).toBe(linear);
        indices++;
      }
    }
    expect(indices).toBeGreaterThan(500);
  });

  it("matches on a large generated random corpus (all entry points)", () => {
    let checked = 0;
    for (let seed = 0; seed < 60; seed++) {
      sameEverywhere(randomCorpus(seed, 40));
      checked++;
    }
    expect(checked).toBe(60);
  });

  it("matches over the owner's real vault, read-only", (ctx) => {
    if (!existsSync(VAULT_DIR)) {
      // A local-only check: CI and fresh checkouts have no vault. Skip with a reason instead of
      // returning green having compared nothing.
      ctx.skip(`real vault not present at ${VAULT_DIR} (local-only check)`);
      return;
    }
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".")) continue; // skip .obsidian/.claude/etc plugin dirs
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (entry.endsWith(".md")) files.push(p);
      }
    };
    walk(VAULT_DIR);
    expect(files.length).toBeGreaterThan(0);
    const differing: string[] = [];
    for (const f of files) {
      const body = readFileSync(f, "utf8");
      const same =
        JSON.stringify(extractLinks(body)) === JSON.stringify(originalExtractLinks(body)) &&
        JSON.stringify(rewriteLinks(body, renameAll)) ===
          JSON.stringify(originalRewriteLinks(body, renameAll)) &&
        JSON.stringify(extractInlineTags(body)) === JSON.stringify(originalExtractInlineTags(body));
      if (!same) differing.push(f);
    }
    expect(differing.slice(0, 10)).toEqual([]);
  }, 120_000);
});
