// Filesystem text + regex scan — the always-available backend for search_text
// and search_regex (FTS5 acceleration is a later optimization; the grep-style
// fallback is the contract). Line/col are 1-based against the raw file so they
// line up with what the editor shows. search_text ranks files by BM25 over the
// query terms using the native module (JS fallback when the binary is absent).
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { readNote } from "../vault/notes-io";
import { resolveVaultPath, walkVault } from "../vault/paths";
import { bm25Score, tokenize } from "./native";
import { execRegexJob, regexWorkerAvailable, type WorkerHit } from "./regex-worker";

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
  /** THE-293: worker-time budget (ms) for the whole call — only regex execution in the worker
   *  counts (file I/O excluded). Default 2000. */
  timeoutMs?: number;
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

/**
 * Flag a pattern with a nested quantifier — a group that both CONTAINS a quantifier
 * and is itself quantified — at any nesting depth (the classic catastrophic-
 * backtracking signature). Conservative: bounded `{n}` repeats also trip it, an
 * acceptable usability cost for a safety guard. Char classes are skipped so a literal
 * `(`/`+`/`{` inside `[...]` is not mistaken for structure. The robust long-term fix
 * is a regex-execution timeout (RE2 / worker thread); this closes the known heuristic
 * bypasses (e.g. `((a)+)+`, `(a+){1,}`) in the meantime (review #6).
 */
function hasNestedQuantifier(p: string): boolean {
  const groupHasQuant: boolean[] = []; // per open group: does it contain a quantifier?
  const groupHasAlt: boolean[] = []; // per open group: contains a top-level alternation?
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
    } else if (c === "(") {
      groupHasQuant.push(false);
      groupHasAlt.push(false);
    } else if (c === "|") {
      if (groupHasAlt.length) groupHasAlt[groupHasAlt.length - 1] = true;
    } else if (c === ")") {
      const inner = groupHasQuant.pop() ?? false;
      const alt = groupHasAlt.pop() ?? false;
      const next = p[i + 1];
      const quantAfter = next === "*" || next === "+" || next === "{";
      if ((inner || alt) && quantAfter) return true;
      // a quantifier on this group also makes the enclosing group "quantified".
      if (quantAfter && groupHasQuant.length) groupHasQuant[groupHasQuant.length - 1] = true;
    } else if (c === "*" || c === "+" || c === "{") {
      if (groupHasQuant.length) groupHasQuant[groupHasQuant.length - 1] = true;
    }
  }
  return false;
}

export async function searchRegex(root: string, opts: RegexOptions): Promise<RegexHit[]> {
  const flags = opts.flags ?? "i";
  // ReDoS / misuse guards (F2): bound pattern length, whitelist flags (g is added
  // internally; sticky y would break the per-line scan), and reject obvious nested
  // quantifiers that can cause catastrophic backtracking. JS has no per-exec regex
  // timeout without a worker thread (a future hardening).
  if (opts.pattern.length > 1000)
    throw err.invalidInput("regex pattern too long", { max: 1000, length: opts.pattern.length });
  for (const f of flags)
    if (!"imsu".includes(f))
      throw err.invalidInput("unsupported regex flag", { flag: f, allowed: ["i", "m", "s", "u"] });
  if (hasNestedQuantifier(opts.pattern))
    throw err.invalidInput(
      "regex rejected: a quantifier on a nested quantifier or an alternation may cause catastrophic backtracking",
      { pattern: opts.pattern },
    );
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

  // THE-293: true execution timeout. The scan runs in a worker thread and only worker
  // wall-time counts against the budget — file I/O and message overhead are excluded, so a
  // benign pattern over a large vault cannot false-positive the ReDoS guard. When the runtime
  // cannot run the eval worker, fall back to the inline scan (heuristic-only, prior behavior).
  const timeoutMs = opts.timeoutMs ?? 2000;
  const useWorker = files.length > 0 && (await regexWorkerAvailable());
  let spentMs = 0;

  const hits: RegexHit[] = [];
  for (const path of files) {
    const lines = readNote(resolveVaultPath(root, path)).raw.split(/\r?\n/);
    let fileHits: WorkerHit[];
    if (useWorker) {
      const remaining = timeoutMs - spentMs;
      if (remaining <= 0)
        throw err.computeBudgetExceeded("regex execution exceeded its time budget", {
          timeout_ms: timeoutMs,
          pattern: opts.pattern,
        });
      const t0 = Date.now();
      fileHits = await execRegexJob(
        { pattern: opts.pattern, flags: re.flags, lines, maxPerFile },
        remaining,
      );
      spentMs += Date.now() - t0;
    } else {
      fileHits = [];
      for (let i = 0; i < lines.length && fileHits.length < maxPerFile; i++) {
        const ln = lines[i] ?? "";
        re.lastIndex = 0;
        let m = re.exec(ln);
        while (m !== null && fileHits.length < maxPerFile) {
          fileHits.push({ line: i + 1, col: m.index + 1, match: m[0] });
          if (m[0] === "") re.lastIndex += 1; // avoid an infinite loop on zero-width matches
          m = re.exec(ln);
        }
      }
    }
    for (const h of fileHits) {
      hits.push({
        path,
        line: h.line,
        col: h.col,
        match: h.match,
        snippet: snippetOf(lines[h.line - 1] ?? ""),
      });
      if (hits.length >= opts.limit) return hits.slice(0, opts.limit);
    }
  }
  return hits.slice(0, opts.limit);
}
