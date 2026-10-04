// Golden-set contamination guard, shared by every retrieval eval that scores a golden set against a
// vault. A note that quotes golden queries verbatim (a decision note recording the candidate
// questions, an eval-results note, a pasted fixture) turns the text leg into a self-reference: the
// literal-substring match hits that one note instead of an expected one, and every lexical/hybrid
// number measured on the vault is skewed. This happened once on a real private corpus (all
// text-routed `auto` queries hit a single such note), so the check now runs BEFORE scoring and
// fails the run, naming the note(s).
//
// Output carries note paths and counts only, never query text: the golden set can be private and
// this runs in CI logs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadVaultExclusion } from "../src/search/index-exclusion";
import { walkVault } from "../src/vault/paths";
import type { GoldenSet } from "./metrics";

/** Default max verbatim golden queries one indexed note may carry (the guard fails at >= this). */
export const DEFAULT_CONTAMINATION_THRESHOLD = 3;
/** Env override. A positive integer, or `off`/`0` to measure a contaminated vault on purpose. */
export const CONTAMINATION_THRESHOLD_ENV = "EVAL_GOLDEN_CONTAMINATION_THRESHOLD";
/** A query shorter than this (in whitespace tokens) matches ordinary prose by chance, so it is not counted. */
export const MIN_QUERY_TOKENS = 3;

export interface GoldenContamination {
  path: string;
  /** Distinct golden queries found verbatim in this note. */
  queries: number;
}

export const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
// A wikilink or embed names another note, it does not quote a question: a hub note that links five
// notes whose titles happen to equal golden queries is ordinary vault structure, not a copy.
export const stripWikilinks = (s: string): string => s.replace(/!?\[\[[^\]]*\]\]/g, " ");

/** Resolve the threshold: explicit option, else env, else the default. `null` means disabled. */
export function resolveContaminationThreshold(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (explicit !== undefined) return explicit > 0 ? explicit : null;
  const raw = env[CONTAMINATION_THRESHOLD_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return DEFAULT_CONTAMINATION_THRESHOLD;
  if (raw === "off" || raw === "0") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(
      `${CONTAMINATION_THRESHOLD_ENV} must be a positive integer or "off", got "${raw}"`,
    );
  return n;
}

/**
 * Indexed notes (the same set the indexer walks: markdown, dot-folders and Obsidian's Excluded
 * files skipped) that contain at least `threshold` distinct golden queries verbatim, worst first.
 * Matching mirrors the text leg: case-insensitive, whitespace-collapsed substring.
 */
export function findGoldenContamination(
  golden: GoldenSet,
  vaultRoot: string,
  threshold: number,
  minTokens: number = MIN_QUERY_TOKENS,
): GoldenContamination[] {
  const queries = [
    ...new Set(
      golden.queries.map((q) => norm(q.query_text)).filter((t) => t.split(" ").length >= minTokens),
    ),
  ];
  const found: GoldenContamination[] = [];
  // A note on the vault's Excluded files list (Obsidian's `userIgnoreFilters`) is not indexed, so it
  // cannot be hit by the text leg and cannot contaminate it: skip it, as the indexer does.
  const { isExcluded } = loadVaultExclusion(vaultRoot);
  for (const entry of walkVault(vaultRoot, { extensions: [".md"] })) {
    if (isExcluded(entry.relPath)) continue;
    let body: string;
    try {
      body = norm(stripWikilinks(readFileSync(join(vaultRoot, entry.relPath), "utf8")));
    } catch {
      continue;
    }
    let n = 0;
    for (const t of queries) if (body.includes(t)) n++;
    if (n >= threshold) found.push({ path: entry.relPath, queries: n });
  }
  return found.sort((a, b) => b.queries - a.queries || a.path.localeCompare(b.path));
}

/** Throw (failing the eval run) when any indexed note carries >= threshold golden queries verbatim. */
export function assertGoldenNotInVault(
  golden: GoldenSet,
  vaultRoot: string,
  opts: { threshold?: number; env?: NodeJS.ProcessEnv } = {},
): void {
  const threshold = resolveContaminationThreshold(opts.threshold, opts.env);
  if (threshold === null) {
    process.stderr.write(
      `[golden-guard] contamination check DISABLED (${CONTAMINATION_THRESHOLD_ENV}); lexical/hybrid numbers may be skewed\n`,
    );
    return;
  }
  const found = findGoldenContamination(golden, vaultRoot, threshold);
  if (found.length === 0) return;
  throw new Error(
    `golden-set contamination: ${found.length} indexed note(s) contain >= ${threshold} golden queries verbatim, ` +
      "so the text leg matches them instead of an expected note and lexical/hybrid results are skewed. " +
      "Move them out of the indexed tree (a dot-folder is skipped by the indexer), add them to Obsidian's Excluded files, and rebuild the index, or set " +
      `${CONTAMINATION_THRESHOLD_ENV}=off to measure the contaminated vault on purpose:\n` +
      found.map((f) => `  - ${f.path} (${f.queries} queries)`).join("\n"),
  );
}
