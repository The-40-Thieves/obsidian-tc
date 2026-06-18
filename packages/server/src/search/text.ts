// Filesystem text + regex scan — the always-available backend for search_text
// and search_regex (FTS5 acceleration is a later optimization; the grep-style
// fallback is the contract). Line/col are 1-based against the raw file so they
// line up with what the editor shows. search_text ranks files by BM25 over the
// query terms using the native module (JS fallback when the binary is absent).
import { err } from "@obsidian-tc/shared";
import { readNote } from "../vault/notes-io";
import { resolveVaultPath, walkVault } from "../vault/paths";
import { bm25Score, tokenize } from "./native";

export interface TextHit {
  path: string;
  line: number;
  col: number;
  snippet: string;
  score: number;
}

export interface TextOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  sub?: string;
  isReadable?: (path: string) => boolean;
  limit: number;
}

export interface RegexHit {
  path: string;
  line: number;
  col: number;
  match: string;
  snippet: string;
}

export interface RegexOptions {
  pattern: string;
  flags?: string;
  sub?: string;
  maxPerFile?: number;
  isReadable?: (path: string) => boolean;
  limit: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snippetOf(line: string): string {
  return line.trim().slice(0, 200);
}

interface Doc {
  path: string;
  lines: string[];
  tokens: string[];
}

function loadDocs(root: string, sub: string | undefined, readable: (p: string) => boolean): Doc[] {
  return walkVault(root, { sub, extensions: [".md"] })
    .map((e) => e.relPath)
    .filter(readable)
    .map((path) => {
      const raw = readNote(resolveVaultPath(root, path)).raw;
      return { path, lines: raw.split(/\r?\n/), tokens: tokenize(raw) };
    });
}

export function searchText(root: string, opts: TextOptions): TextHit[] {
  const readable = opts.isReadable ?? (() => true);
  const docs = loadDocs(root, opts.sub, readable);
  const n = docs.length;
  if (n === 0) return [];

  const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / n;
  const queryTerms = [...new Set(tokenize(opts.query))];
  const docFreq = new Map<string, number>();
  for (const t of queryTerms) docFreq.set(t, docs.filter((d) => d.tokens.includes(t)).length);

  const core = escapeRegExp(opts.query);
  const pattern = opts.wholeWord ? `\\b${core}\\b` : core;
  const re = new RegExp(pattern, opts.caseSensitive ? "" : "i");

  const hits: TextHit[] = [];
  for (const d of docs) {
    const lineHits: Array<{ line: number; col: number; snippet: string }> = [];
    d.lines.forEach((ln, i) => {
      const m = re.exec(ln);
      if (m) lineHits.push({ line: i + 1, col: m.index + 1, snippet: snippetOf(ln) });
    });
    if (lineHits.length === 0) continue;

    let score = 0;
    for (const t of queryTerms) {
      const tf = d.tokens.reduce((c, x) => (x === t ? c + 1 : c), 0);
      score += bm25Score(tf, d.tokens.length, avgLen, docFreq.get(t) ?? 0, n);
    }
    for (const lh of lineHits) hits.push({ path: d.path, score, ...lh });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  return hits.slice(0, opts.limit);
}

export function searchRegex(root: string, opts: RegexOptions): RegexHit[] {
  const flags = opts.flags ?? "i";
  let re: RegExp;
  try {
    re = new RegExp(opts.pattern, flags.includes("g") ? flags : `${flags}g`);
  } catch (e) {
    throw err.invalidInput(`invalid regular expression: ${(e as Error).message}`, {
      pattern: opts.pattern,
    });
  }
  const readable = opts.isReadable ?? (() => true);
  const maxPerFile = opts.maxPerFile ?? 10;
  const files = walkVault(root, { sub: opts.sub, extensions: [".md"] })
    .map((e) => e.relPath)
    .filter(readable);

  const hits: RegexHit[] = [];
  for (const path of files) {
    const lines = readNote(resolveVaultPath(root, path)).raw.split(/\r?\n/);
    let perFile = 0;
    for (let i = 0; i < lines.length && perFile < maxPerFile; i++) {
      const ln = lines[i] ?? "";
      re.lastIndex = 0;
      let m = re.exec(ln);
      while (m !== null && perFile < maxPerFile) {
        hits.push({ path, line: i + 1, col: m.index + 1, match: m[0], snippet: snippetOf(ln) });
        perFile += 1;
        if (m[0] === "") re.lastIndex += 1; // avoid an infinite loop on zero-width matches
        m = re.exec(ln);
      }
      if (hits.length >= opts.limit) return hits.slice(0, opts.limit);
    }
  }
  return hits.slice(0, opts.limit);
}
