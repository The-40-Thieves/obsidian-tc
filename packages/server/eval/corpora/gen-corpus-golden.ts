// Golden-set generator for the public suite corpora. The ground truth is OUTPUT-DERIVED: every
// label comes from the corpus itself (a note's title, a heading only that note carries, a sentence
// only that note contains, a link its author wrote), never from any retrieval arm's ranking, and it
// is fixed here, before any arm runs. That is what keeps the labels from favouring the mechanism
// under test, and it is the same property the synthetic slice (`gen-multi-hop-slice.ts`) has by
// construction.
//
// Five query classes, each mechanical and each verifiable from the files alone:
//   exact-title     query = a note's title (unique across the corpus); target = that note
//   unique-heading  query = a heading carried by exactly one note; target = that note
//   quote-fragment  query = a fragment of a sentence found in exactly one note; target = that note
//   link-context    query = a sentence from note A with its link markup removed, where A links to
//                   B; seed = A, target = B (the author's own link is the judgment)
//   bridge-2hop     A links to B, B links to C, no link between A and C in either direction;
//                   templated question; seed = A, bridge = B, target = C
//
// Deterministic from its seed. `--check` regenerates in memory and fails when a committed set
// differs, so a corpus or generator change cannot leave a stale golden set behind.
//
//   bun eval/corpora/gen-corpus-golden.ts <name> --corpus <dir> --out <file>
//   bun eval/corpora/gen-corpus-golden.ts <name> --corpus <dir> --check <file>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitFrontmatterBody } from "../../src/vault/frontmatter";
import { buildVaultIndex, extractLinks, resolveTarget } from "../../src/vault/links";
import { walkVault } from "../../src/vault/paths";
import {
  assertGoldenNotInVault,
  DEFAULT_CONTAMINATION_THRESHOLD,
  MIN_QUERY_TOKENS,
  norm,
  stripWikilinks,
} from "../golden-guard";
import { type GoldenQuery, GoldenSetSchema } from "../metrics";
import { loadRegistry } from "./fetch-corpus";

export const GOLDEN_CLASSES = [
  "link-context",
  "bridge-2hop",
  "quote-fragment",
  "unique-heading",
  "exact-title",
] as const;
export type GoldenClass = (typeof GOLDEN_CLASSES)[number];

export interface GoldenRecipe {
  seed: number;
  idPrefix: string;
  /** Template language for the bridge question. */
  template: "en" | "zh";
  caps: Record<GoldenClass, number>;
}

/** A note may be the TARGET of this many queries; more would make one note's retrieval count thrice. */
const MAX_TARGET_USES = 2;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const DATE_LIKE = /^\d{4}[-./]\d{1,2}([-./]\d{1,2})?$|^\d+$/;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/** Markup removed, link text kept: the words a reader sees. Callback replacers on purpose (a `$` in
 *  note text must not be read as a replacement pattern). */
export function plainText(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]/g, " ")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, (_m, d: string) => d)
    .replace(/\[\[([^\]#]*)(?:#[^\]]*)?\]\]/g, (_m, t: string) => t.replace(/^.*\//, ""))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, (_m, t: string) => t)
    .replace(/<[^>]+>/g, " ")
    .replace(/[*`]+|~~/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const isCjk = (s: string): boolean => CJK.test(s);
const titleOf = (p: string): string => (p.split("/").pop() ?? p).replace(/\.md$/i, "");
const folderOf = (p: string): string => (p.includes("/") ? (p.split("/")[0] ?? "") : "(root)");

/** Long enough to be a query rather than a stray token: 2+ words, or 4+ CJK characters. */
function usableTitle(t: string): boolean {
  if (DATE_LIKE.test(t) || /^(index|readme|untitled)/i.test(t)) return false;
  if (isCjk(t)) return t.length >= 4;
  return /\s/.test(t) ? t.length >= 4 : t.length >= 6;
}

/** A title short enough to read inside a templated "how does A relate to C" question. */
const bridgeTitle = (t: string): boolean => usableTitle(t) && t.length <= 30;

interface Note {
  path: string;
  title: string;
  /** Blocks of prose, raw markup kept, code fences and tables dropped. */
  blocks: string[];
  headings: string[];
  plainNorm: string;
  /** The text the contamination guard matches queries against (whole file, wikilinks blanked). */
  guardBody: string;
  out: Set<string>;
}

function proseBlocks(body: string): string[] {
  const noCode = body.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "");
  const blocks: string[] = [];
  for (const block of noCode.split(/\n\s*\n/)) {
    // Quote and callout markers are layout, not words: `> [!note] text` reads as `text`.
    const lines = block
      .split("\n")
      .map((l) => l.replace(/^\s*(>\s*)+(\[![\w-]+\][+-]?\s*)?/, ""))
      .filter((l) => l.trim() !== "");
    const first = lines[0]?.trim() ?? "";
    // `key:: value` is an inline-field (dataview) line, metadata rather than prose.
    if (first === "" || /^(#|\||<|\w+::)/.test(first)) continue;
    const bullet = /^\s*([-*+]|\d+[.)])\s+/;
    if (bullet.test(first)) {
      for (const l of lines) if (bullet.test(l)) blocks.push(l.replace(bullet, "").trim());
    } else {
      blocks.push(lines.map((l) => l.trim()).join(" "));
    }
  }
  return blocks;
}

function loadNotes(root: string): Note[] {
  const paths = walkVault(root, { extensions: [".md"] })
    .filter((e) => e.type === "file")
    .map((e) => e.relPath)
    .sort();
  const index = buildVaultIndex(paths);
  return paths.map((path) => {
    const rawFile = readFileSync(join(root, path), "utf8");
    const body = splitFrontmatterBody(rawFile);
    const out = new Set<string>();
    for (const l of extractLinks(body)) {
      if (l.inCodeblock || l.kind === "embed") continue;
      let target = l.target;
      if (l.kind === "markdown") {
        try {
          target = decodeURIComponent(target);
        } catch {
          // keep the raw target; it simply will not resolve
        }
      }
      const r = resolveTarget(index, target);
      if (r.resolved && r.target_path !== undefined && r.target_path !== path)
        out.add(r.target_path);
    }
    const blocks = proseBlocks(body);
    const headings = [...body.matchAll(/^#{2,4}\s+(.+?)\s*#*\s*$/gm)].map((m) =>
      plainText(m[1] ?? ""),
    );
    return {
      path,
      title: titleOf(path),
      blocks,
      headings,
      plainNorm: norm(blocks.map(plainText).join(" ")),
      guardBody: norm(stripWikilinks(rawFile)),
      out,
    };
  });
}

function sentences(block: string): string[] {
  return block.split(/(?<=[.!?。！？])\s+|(?<=[。！？])/u).filter((s) => s.trim() !== "");
}

interface Candidate {
  cls: GoldenClass;
  query: string;
  seed: string[];
  target: string[];
  bridge: string[];
  description: string;
}

/** Mostly letters: rules out formulas, tables of symbols and key-value residue as "prose". */
function proseLike(s: string): boolean {
  const visible = s.replace(/\s/g, "");
  return visible.length > 0 && (visible.match(/\p{L}/gu)?.length ?? 0) / visible.length >= 0.75;
}

function inRange(s: string, lo: number, hi: number, loCjk: number, hiCjk: number): boolean {
  if (!proseLike(s)) return false;
  if (isCjk(s)) return s.length >= loCjk && s.length <= hiCjk;
  const w = s.split(/\s+/).length;
  return w >= lo && w <= hi;
}

function candidates(notes: Note[], recipe: GoldenRecipe): Record<GoldenClass, Candidate[]> {
  const byPath = new Map(notes.map((n) => [n.path, n]));
  const index = buildVaultIndex(notes.map((n) => n.path));
  const titleCount = new Map<string, number>();
  for (const n of notes) titleCount.set(norm(n.title), (titleCount.get(norm(n.title)) ?? 0) + 1);
  const headingNotes = new Map<string, Set<string>>();
  for (const n of notes) {
    for (const h of n.headings) {
      const k = norm(h);
      headingNotes.set(k, (headingNotes.get(k) ?? new Set()).add(n.path));
    }
  }
  const unique = (n: string): boolean => notes.filter((x) => x.plainNorm.includes(n)).length === 1;
  const out: Record<GoldenClass, Candidate[]> = {
    "link-context": [],
    "bridge-2hop": [],
    "quote-fragment": [],
    "unique-heading": [],
    "exact-title": [],
  };

  for (const n of notes) {
    if (titleCount.get(norm(n.title)) === 1 && usableTitle(n.title)) {
      out["exact-title"].push({
        cls: "exact-title",
        query: n.title,
        seed: [],
        target: [n.path],
        bridge: [],
        description: "mechanical: the note's own title is the query (title unique in the corpus)",
      });
    }
    for (const h of n.headings) {
      const k = norm(h);
      if (headingNotes.get(k)?.size !== 1 || titleCount.has(k)) continue;
      if (!inRange(h, 2, 12, 4, 40)) continue;
      out["unique-heading"].push({
        cls: "unique-heading",
        query: h,
        seed: [],
        target: [n.path],
        bridge: [],
        description: "mechanical: a heading carried by exactly one note (and equal to no title)",
      });
    }
    for (const block of n.blocks) {
      for (const s of sentences(block)) {
        const plain = plainText(s);
        const links = extractLinks(s).filter((l) => !l.inCodeblock && l.kind !== "embed");
        if (links.length === 0 && inRange(plain, 12, 40, 30, 120)) {
          const frag = isCjk(plain)
            ? plain.slice(4, 26)
            : plain
                .split(" ")
                .slice(3, 13)
                .join(" ")
                .replace(/[.,;:!?]+$/, "");
          if (norm(frag).length >= 12 && proseLike(frag) && unique(norm(frag))) {
            out["quote-fragment"].push({
              cls: "quote-fragment",
              query: frag,
              seed: [],
              target: [n.path],
              bridge: [],
              description: "mechanical: a fragment of a sentence that occurs in exactly one note",
            });
          }
        } else if (links.length >= 1 && links.length <= 2 && inRange(plain, 8, 40, 20, 120)) {
          const first = links.map((l) => resolveTarget(index, l.target)).find((r) => r.resolved);
          const to = first?.target_path;
          if (to !== undefined && to !== n.path && byPath.has(to)) {
            out["link-context"].push({
              cls: "link-context",
              query: plain,
              seed: [n.path],
              target: [to],
              bridge: [],
              description:
                "mechanical: a sentence of the seed note, link markup removed; its link is the target",
            });
          }
        }
      }
    }
  }

  const tpl =
    recipe.template === "zh"
      ? (a: string, c: string) => `${a}和${c}之间有什么联系？`
      : (a: string, c: string) => `How does ${a} relate to ${c}?`;
  const degree = new Map<string, number>();
  for (const n of notes) {
    degree.set(n.path, (degree.get(n.path) ?? 0) + n.out.size);
    for (const t of n.out) degree.set(t, (degree.get(t) ?? 0) + 1);
  }
  for (const a of notes) {
    if (titleCount.get(norm(a.title)) !== 1 || !bridgeTitle(a.title)) continue;
    for (const b of a.out) {
      const bn = byPath.get(b);
      const bd = degree.get(b) ?? 0;
      if (!bn || bd < 2 || bd > 20) continue;
      for (const c of bn.out) {
        const cn = byPath.get(c);
        if (!cn || c === a.path || a.out.has(c) || cn.out.has(a.path)) continue;
        if (titleCount.get(norm(cn.title)) !== 1 || !bridgeTitle(cn.title)) continue;
        out["bridge-2hop"].push({
          cls: "bridge-2hop",
          query: tpl(a.title, cn.title),
          seed: [a.path],
          target: [c],
          bridge: [b],
          description:
            "templated: seed links to bridge, bridge links to target, no link between seed and target",
        });
      }
    }
  }
  return out;
}

export function mineGolden(root: string, recipe: GoldenRecipe): GoldenQuery[] {
  const notes = loadNotes(root);
  const pools = candidates(notes, recipe);
  const rand = mulberry32(recipe.seed);
  const targetUse = new Map<string, number>();
  const bridgeUse = new Map<string, number>();
  const hostUse = new Map<string, number>();
  const seen = new Set<string>();
  const queries: GoldenQuery[] = [];
  for (const cls of GOLDEN_CLASSES) {
    let taken = 0;
    for (const c of shuffled(pools[cls], rand)) {
      if (taken >= recipe.caps[cls]) break;
      const key = norm(c.query);
      const t = c.target[0] as string;
      const b = c.bridge[0];
      if (seen.has(key) || (targetUse.get(t) ?? 0) >= MAX_TARGET_USES) continue;
      if (b !== undefined && (bridgeUse.get(b) ?? 0) >= 2) continue;
      // Build the guard's rule in: a note may carry at most threshold-1 queries verbatim.
      const hosts =
        key.split(" ").length >= MIN_QUERY_TOKENS
          ? notes.filter((n) => n.guardBody.includes(key)).map((n) => n.path)
          : [];
      if (hosts.some((h) => (hostUse.get(h) ?? 0) >= DEFAULT_CONTAMINATION_THRESHOLD - 1)) continue;
      for (const h of hosts) hostUse.set(h, (hostUse.get(h) ?? 0) + 1);
      seen.add(key);
      targetUse.set(t, (targetUse.get(t) ?? 0) + 1);
      if (b !== undefined) bridgeUse.set(b, (bridgeUse.get(b) ?? 0) + 1);
      taken++;
      const sd = c.seed[0] ?? t;
      queries.push({
        id: `${recipe.idPrefix}-${cls.split("-")[0]}-${String(taken).padStart(3, "0")}`,
        query_text: c.query,
        seed_domain: folderOf(sd),
        target_domain: folderOf(t),
        seed_paths: c.seed,
        target_paths: c.target,
        bridge_paths: c.bridge,
        description: c.description,
        categories: [cls],
      });
    }
  }
  return queries;
}

export const serialize = (queries: GoldenQuery[]): string =>
  `${JSON.stringify({ queries }, null, 2)}\n`;

export function recipeOf(name: string): GoldenRecipe {
  const spec = loadRegistry().corpora[name];
  const recipe = spec?.kind === "github" ? spec.golden : undefined;
  if (!recipe) throw new Error(`corpus "${name}" has no golden recipe in corpora.json`);
  const missing = GOLDEN_CLASSES.filter((c) => typeof recipe.caps[c] !== "number");
  if (missing.length > 0)
    throw new Error(`recipe for "${name}" lacks caps for: ${missing.join(", ")}`);
  return { ...recipe, caps: recipe.caps as Record<GoldenClass, number> };
}

if ((import.meta as unknown as { main?: boolean }).main) {
  const argv = process.argv.slice(2);
  const flag = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const name = argv.find((a) => !a.startsWith("--"));
  const corpus = flag("--corpus");
  const out = flag("--out");
  const check = flag("--check");
  if (!name || !corpus || (!out && !check)) {
    process.stderr.write(
      "usage: bun eval/corpora/gen-corpus-golden.ts <name> --corpus <dir> (--out <file> | --check <file>)\n",
    );
    process.exit(2);
  }
  const queries = mineGolden(corpus, recipeOf(name));
  const text = serialize(queries);
  const golden = GoldenSetSchema.parse(JSON.parse(text));
  assertGoldenNotInVault(golden, corpus);
  if (check) {
    if (readFileSync(check, "utf8") !== text) {
      process.stderr.write(`FAIL: ${check} differs from a fresh generation (stale golden set)\n`);
      process.exit(1);
    }
    process.stdout.write(`ok: ${check} reproduces (${queries.length} queries, guard clean)\n`);
  } else if (out) {
    writeFileSync(out, text);
    process.stdout.write(`wrote ${queries.length} queries to ${out}\n`);
  }
}
