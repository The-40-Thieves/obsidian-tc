// Shape statistics for a Markdown corpus, the numbers ADR 0007 asks every suite member to carry:
// note count, links per note, orphan rate, folder depth, note length. Computed from the files on
// disk with the SAME link extraction and resolution the server uses (`vault/links.ts`), so "a link"
// here is a link the indexer would have made an edge from, not a regex's guess.
//
//   bun eval/corpora/corpus-stats.ts <vault-root> [--json out.json] [--label name]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitFrontmatterBody } from "../../src/vault/frontmatter";
import { buildVaultIndex, extractLinks, resolveTarget } from "../../src/vault/links";
import { walkVault } from "../../src/vault/paths";

export interface Spread {
  mean: number;
  median: number;
  max: number;
}

export interface CorpusStats {
  notes: number;
  /** Distinct resolved note-to-note links (a note linking the same target twice counts once). */
  resolvedLinks: number;
  /** Raw link occurrences outside code, embeds excluded, before resolution or dedupe. */
  linkOccurrences: number;
  /** Share of link occurrences whose target is not a note in the corpus (URLs, dangling links). */
  unresolvedShare: number;
  linksPerNote: Spread;
  /** Notes with no resolved link in either direction. */
  orphanRate: number;
  /** Notes nothing links to (a superset of the orphans). */
  noInboundRate: number;
  /** Folder depth: directory segments above the file (a root file is 0). */
  folderDepth: Spread;
  folderDepthHistogram: Record<string, number>;
  /** Body length (frontmatter excluded) in characters. */
  bodyChars: Spread;
  /** Body length in whitespace-separated words; CJK text barely splits, so read it with `cjkShare`. */
  bodyWords: Spread;
  /** Share of body letters that are Han, kana or Hangul. */
  cjkShare: number;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LETTER = /\p{L}/gu;

function spread(xs: number[]): Spread {
  if (xs.length === 0) return { mean: 0, median: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, median, max: s[s.length - 1] ?? 0 };
}

const round = (x: number, d = 4): number => Math.round(x * 10 ** d) / 10 ** d;
const roundSpread = (s: Spread, d = 2): Spread => ({
  mean: round(s.mean, d),
  median: round(s.median, d),
  max: s.max,
});

function decoded(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

export function computeCorpusStats(root: string): CorpusStats {
  const paths = walkVault(root, { extensions: [".md"] })
    .filter((e) => e.type === "file")
    .map((e) => e.relPath)
    .sort();
  const index = buildVaultIndex(paths);
  const out = new Map<string, Set<string>>();
  const inbound = new Map<string, number>();
  const chars: number[] = [];
  const words: number[] = [];
  const depths: number[] = [];
  let occurrences = 0;
  let unresolved = 0;
  let cjk = 0;
  let letters = 0;

  for (const p of paths) {
    const body = splitFrontmatterBody(readFileSync(join(root, p), "utf8"));
    chars.push(body.length);
    words.push(body.split(/\s+/).filter(Boolean).length);
    depths.push(p.split("/").length - 1);
    cjk += body.match(CJK)?.length ?? 0;
    letters += body.match(LETTER)?.length ?? 0;
    const targets = new Set<string>();
    for (const l of extractLinks(body)) {
      if (l.inCodeblock || l.kind === "embed") continue;
      occurrences++;
      const r = resolveTarget(index, l.kind === "markdown" ? decoded(l.target) : l.target);
      if (!r.resolved || r.target_path === undefined) {
        unresolved++;
        continue;
      }
      if (r.target_path !== p) targets.add(r.target_path);
    }
    out.set(p, targets);
    for (const t of targets) inbound.set(t, (inbound.get(t) ?? 0) + 1);
  }

  const outDegree = paths.map((p) => out.get(p)?.size ?? 0);
  const resolvedLinks = outDegree.reduce((a, b) => a + b, 0);
  const orphans = paths.filter((p) => (out.get(p)?.size ?? 0) === 0 && !inbound.has(p)).length;
  const noInbound = paths.filter((p) => !inbound.has(p)).length;
  const hist: Record<string, number> = {};
  for (const d of depths) hist[String(d)] = (hist[String(d)] ?? 0) + 1;

  return {
    notes: paths.length,
    resolvedLinks,
    linkOccurrences: occurrences,
    unresolvedShare: round(occurrences > 0 ? unresolved / occurrences : 0),
    linksPerNote: roundSpread(spread(outDegree)),
    orphanRate: round(paths.length > 0 ? orphans / paths.length : 0),
    noInboundRate: round(paths.length > 0 ? noInbound / paths.length : 0),
    folderDepth: roundSpread(spread(depths)),
    folderDepthHistogram: hist,
    bodyChars: roundSpread(spread(chars), 0),
    bodyWords: roundSpread(spread(words), 0),
    cjkShare: round(letters > 0 ? cjk / letters : 0),
  };
}

if ((import.meta as unknown as { main?: boolean }).main) {
  const argv = process.argv.slice(2);
  const root = argv.find((a) => !a.startsWith("--"));
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!root) {
    process.stderr.write(
      "usage: bun eval/corpora/corpus-stats.ts <vault-root> [--json out.json]\n",
    );
    process.exit(2);
  }
  const stats = computeCorpusStats(root);
  const text = `${JSON.stringify({ label: flag("--label") ?? null, ...stats }, null, 2)}\n`;
  const jsonOut = flag("--json");
  if (jsonOut) writeFileSync(jsonOut, text);
  else process.stdout.write(text);
}
