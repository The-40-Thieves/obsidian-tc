// The lint_wiki engine: the scattered wiki-health checks (orphans, dangling links, open
// contradictions, stale / duplicated notes, missing sources, coverage gaps) plus a near-duplicate
// pass, folded into ONE list of PROPOSALS. It calls the checks' own internal functions rather than
// their MCP tools, so a proposal and the tool it points at agree by construction, and the same
// ACL semantics apply (a note the caller cannot read is absent from every section).
//
// Strictly read-only and never blocking: nothing here writes a note, a row or a file, a failing
// check is reported as `skipped` rather than thrown, and every proposal names the tool a caller
// could use to act on it (the caller decides). Notes Obsidian's Excluded files hides from the index
// are never the SUBJECT of a proposal, but they still count as link sources and targets.

import type { FolderAcl } from "../../../acl";
import { tableExists } from "../../../db/introspect";
import type { Database } from "../../../db/types";
import { readLatestGapReport } from "../../../experiential/gaps";
import { readNoteQuality } from "../../../experiential/note-quality";
import { NOTE_DUPLICATE_MIN, NOTE_IDENTICAL_MIN } from "../../../search/dedupe-band";
import type { VaultExclusion } from "../../../search/index-exclusion";
import { loadNoteVectors, nearDuplicatePairs } from "../../../search/note-vectors";
import { readableRel } from "../../../vault/acl-read-filter";
import { noteExists, readNote } from "../../../vault/notes-io";
import { resolveVaultPath } from "../../../vault/paths";
import { ScanWarnings } from "../../scan-warnings";
import {
  readableNotes,
  type ScanScope,
  scanOrphans,
  scanProvenance,
  scanUnresolved,
} from "../../wiki-scan";
import { openContradictionsForPaths } from "./retrieval-runtime";
import { isGeneratedWikiPath, rawPathFilter, WIKI_INDEX_FILE, WIKI_LOG_FILE } from "./wiki-folder";
import { inspectGenerated } from "./wiki-generated-seal";

export const LINT_CHECKS = [
  "generated_pages",
  "orphans",
  "unresolved_links",
  "contradictions",
  "quality",
  "missing_sources",
  "coverage_gaps",
  "near_duplicates",
] as const;
export type LintCheck = (typeof LINT_CHECKS)[number];

export type ProposalKind =
  | "generated_page"
  | "orphan"
  | "unresolved_link"
  | "contradiction"
  | "stale"
  | "duplicate_chunks"
  | "missing_sources"
  | "coverage_gap"
  | "near_duplicate";

export interface Proposal {
  kind: ProposalKind;
  /** The note the proposal is about (a note path), or the missing link target / gap query. */
  subject: string;
  /** Other notes involved: the other side of a pair, the notes carrying a dangling link. */
  related?: string[];
  detail: string;
  suggested_action: string;
  /** The tool that applies (or starts to apply) the action. Never called by lint_wiki. */
  tool: string;
  tool_args?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}

export interface LintInput {
  vaultId: string;
  folder?: string | undefined;
  checks: readonly LintCheck[];
  /** Cap per proposal kind. */
  limitPerCheck: number;
  /** Near-duplicate floor; defaults to the calibrated band. */
  minSimilarity?: number | undefined;
  /** Cap on notes whose vectors are compared pairwise (the pass is O(n^2)). */
  maxNotes: number;
}

export interface LintEnv {
  root: string;
  /** Cache db: chunks, vectors, contradictions. */
  db: Database;
  /** Experiential db: the note_quality rollup and gap reports. Absent when the membrane is closed. */
  edb?: Database | undefined;
  acl: FolderAcl | undefined;
  grantedScopes: Iterable<string>;
  exclusion: VaultExclusion;
  /** The serving embedding model id, to keep other models' vectors out of the near-duplicate pass. */
  embeddingModel: string;
  /** The vault's wiki folder. Its generated index.md / log.md are never the subject of a proposal. */
  wikiFolder?: string | undefined;
  /** Every name of the vault's raw-sources folder. Raw notes are inputs: never the subject of a proposal. */
  rawFolders?: readonly string[] | undefined;
  /** Server-local key that authenticates generated pages. */
  sealKey?: string | undefined;
}

export interface LintReport {
  vault: string;
  folder?: string;
  checks_run: LintCheck[];
  skipped: Array<{ check: LintCheck; reason: string }>;
  summary: { total: number; by_kind: Partial<Record<ProposalKind, number>> };
  proposals: Proposal[];
  truncated: ProposalKind[];
  notes: string[];
  warnings: ReturnType<ScanWarnings["out"]>;
}

const ORDER: ProposalKind[] = [
  "generated_page",
  "contradiction",
  "near_duplicate",
  "duplicate_chunks",
  "unresolved_link",
  "orphan",
  "missing_sources",
  "stale",
  "coverage_gap",
];

const CONTRADICTION_NOTE =
  "Open contradiction rows come from a judge that over-flagged: an audit of 86 sampled rows found 81 were not real conflicts. Rows marked rejudged=false have not been re-judged yet (production rows are re-judged after the next release); read both notes before acting.";

function chunked<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Other notes sharing at least one chunk body with `path` (the exact-duplicate signal behind note_quality's `duplicate` flag). */
function exactChunkPeers(
  db: Database,
  vaultId: string,
  path: string,
  ok: (p: string) => boolean,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT b.path AS path FROM chunks a JOIN chunks b
         ON b.body_sha = a.body_sha AND b.vault_id = a.vault_id AND b.path <> a.path
       WHERE a.vault_id = ? AND a.path = ? AND a.body_sha IS NOT NULL LIMIT 20`,
    )
    .all(vaultId, path) as Array<{ path: string }>;
  return rows.map((r) => r.path).filter(ok);
}

export function runWikiLint(env: LintEnv, input: LintInput): LintReport {
  const warnings = new ScanWarnings();
  const scope: ScanScope = {
    root: env.root,
    acl: env.acl,
    grantedScopes: env.grantedScopes,
    wikiFolder: env.wikiFolder,
    rawFolders: env.rawFolders,
  };
  const folder = input.folder?.replace(/\/+$/, "");
  const prefix = folder ? `${folder}/` : "";
  const inFolder = (p: string): boolean => prefix === "" || p.startsWith(prefix);
  const isRaw = rawPathFilter(env.rawFolders);
  const subjectOk = (p: string): boolean =>
    !env.exclusion.isExcluded(p) && !isGeneratedWikiPath(p, env.wikiFolder) && !isRaw(p);
  const readable = (p: string): boolean => readableRel(env.acl, p, env.grantedScopes);
  const proposals: Proposal[] = [];
  const skipped: LintReport["skipped"] = [];
  const checksRun: LintCheck[] = [];
  const truncated = new Set<ProposalKind>();
  const notes: string[] = [];
  const push = (kind: ProposalKind, items: Proposal[]): void => {
    if (items.length > input.limitPerCheck) truncated.add(kind);
    proposals.push(...items.slice(0, input.limitPerCheck));
  };
  const run = (check: LintCheck, fn: () => string | undefined): void => {
    if (!input.checks.includes(check)) return;
    try {
      const skip = fn();
      if (skip) skipped.push({ check, reason: skip });
      else checksRun.push(check);
    } catch (e) {
      skipped.push({ check, reason: e instanceof Error ? e.message : String(e) });
    }
  };

  // The generated pages are the one thing here that can be WRONG rather than merely improvable: a
  // hand-edited (or foreign) index.md / log.md is left alone by the generator, and this says so.
  run("generated_pages", () => {
    const wiki = env.wikiFolder;
    if (!wiki) return undefined;
    if (env.sealKey === undefined) return "generated-page HMAC key unavailable";
    const found: Proposal[] = [];
    for (const name of [WIKI_INDEX_FILE, WIKI_LOG_FILE]) {
      const rel = `${wiki}/${name}`;
      if (!readable(rel) || !inFolder(rel)) continue;
      const abs = resolveVaultPath(env.root, rel);
      if (!noteExists(abs).exists) continue;
      const state = inspectGenerated(readNote(abs).raw, env.sealKey, {
        vaultId: input.vaultId,
        path: rel,
      });
      if (state === "ours") continue;
      found.push({
        kind: "generated_page",
        subject: rel,
        detail:
          state === "edited"
            ? "Generated by obsidian-tc but edited by hand since: it is no longer regenerated, so it goes stale."
            : state === "legacy"
              ? "Generated with the legacy unkeyed seal: the next generated-page pass rebuilds it from trusted sources with an HMAC."
              : "Not generated by obsidian-tc (no generated_by marker), so the server leaves it alone and writes no index or log here.",
        suggested_action:
          state === "edited"
            ? "Move what you added to a page of its own, then delete this file (restore_note keeps a copy); the next wiki write regenerates it."
            : state === "legacy"
              ? "Run or wait for generated-page maintenance; it replaces this legacy file without reusing its body or cursor."
              : "Keep it as your own page, or delete it to have the generated one written.",
        tool: "delete_note",
        tool_args: { vault: input.vaultId, path: rel },
        evidence: { state },
      });
    }
    push("generated_page", found);
    return undefined;
  });

  run("orphans", () => {
    const orphans = scanOrphans(scope, warnings, { folder }).filter(subjectOk);
    push(
      "orphan",
      orphans.map((p) => ({
        kind: "orphan" as const,
        subject: p,
        detail: "No other note links to this page (a link in a property counts).",
        suggested_action:
          "Link it from a related page or an index note; suggest_links lists candidates from the link graph.",
        tool: "suggest_links",
        tool_args: { vault: input.vaultId, path: p },
      })),
    );
    return undefined;
  });

  run("unresolved_links", () => {
    const { unresolved } = scanUnresolved(scope, warnings, { folder, limit: 5000 });
    const byTarget = new Map<string, { target: string; sources: Set<string>; property?: string }>();
    for (const u of unresolved) {
      const src = u.source_path as string;
      if (!subjectOk(src)) continue;
      const target = u.target as string;
      const key = target.toLowerCase();
      const slot = byTarget.get(key) ?? { target, sources: new Set<string>() };
      slot.sources.add(src);
      if (typeof u.property === "string") slot.property ??= u.property;
      byTarget.set(key, slot);
    }
    push(
      "unresolved_link",
      [...byTarget.values()]
        .sort((a, b) => b.sources.size - a.sources.size || a.target.localeCompare(b.target))
        .map((g) => ({
          kind: "unresolved_link" as const,
          subject: g.target,
          related: [...g.sources].slice(0, 10),
          detail: `${g.sources.size} note(s) link to "${g.target}", which does not exist${g.property ? ` (written in the \`${g.property}\` property)` : ""}.`,
          suggested_action:
            "If the topic deserves a page, run find_existing_page first (it may exist under another name) and then write_note; if it exists under another name, point the links at it with rewrite_link.",
          tool: "find_existing_page",
          tool_args: { vault: input.vaultId, topic: g.target },
        })),
    );
    return undefined;
  });

  run("contradictions", () => {
    if (!tableExists(env.db, "contradictions")) return "contradictions table not present";
    const paths = readableNotes(env.root, env.acl, env.grantedScopes, folder).filter(subjectOk);
    const rows = new Map<string, ReturnType<typeof openContradictionsForPaths>[number]>();
    for (const group of chunked(paths, 400))
      for (const r of openContradictionsForPaths(env.db, input.vaultId, group, readable))
        rows.set(r.id, r);
    const rejudged = new Map<string, boolean>();
    try {
      for (const group of chunked([...rows.keys()], 400)) {
        const found = env.db
          .prepare(
            `SELECT id, rejudged_at AS at FROM contradictions WHERE id IN (${group.map(() => "?").join(",")})`,
          )
          .all(...group) as Array<{ id: string; at: number | null }>;
        for (const f of found) rejudged.set(f.id, f.at !== null);
      }
    } catch {
      // pre-migration cache.db: no rejudged_at column, so the flag is simply absent.
    }
    if (rows.size > 0) notes.push(CONTRADICTION_NOTE);
    push(
      "contradiction",
      [...rows.values()].map((r) => ({
        kind: "contradiction" as const,
        subject: r.source_path,
        related: [r.conflict_path],
        detail: `${r.judge_verdict}: ${r.judge_rationale}`.slice(0, 400),
        suggested_action:
          "Read both notes and reconcile them: correct the wrong claim, or state the tension in both pages and link them to each other.",
        tool: "read_notes",
        tool_args: { vault: input.vaultId, paths: [r.source_path, r.conflict_path] },
        evidence: {
          id: r.id,
          judge_verdict: r.judge_verdict,
          rejudged: rejudged.get(r.id) ?? null,
        },
      })),
    );
    return undefined;
  });

  run("quality", () => {
    if (!env.edb) return "experiential store not open (no note_quality rollup)";
    const rows = readNoteQuality(env.edb, { vaultId: input.vaultId }).filter(
      (r) => inFolder(r.path) && readable(r.path) && subjectOk(r.path),
    );
    if (rows.length === 0)
      return "no note_quality rollup for this scope yet (run `obsidian-tc note-quality`)";
    const stale: Proposal[] = [];
    const dup: Proposal[] = [];
    for (const r of rows) {
      const flags = JSON.parse(r.flags) as string[];
      if (flags.includes("stale_edit")) {
        stale.push({
          kind: "stale",
          subject: r.path,
          detail: `Not edited for ${r.age_days === null ? "a long time" : `${Math.round(r.age_days)} days`}.`,
          suggested_action:
            "Re-check the claims against current sources; update the page, or mark it superseded in its frontmatter.",
          tool: "read_note",
          tool_args: { vault: input.vaultId, path: r.path },
          evidence: { age_days: r.age_days },
        });
      }
      if (flags.includes("duplicate")) {
        const peers = exactChunkPeers(env.db, input.vaultId, r.path, (p) => readable(p));
        dup.push({
          kind: "duplicate_chunks",
          subject: r.path,
          related: peers,
          detail: `${r.dup_chunk_count} chunk(s) repeat text that also appears in ${peers.length || "other"} note(s).`,
          suggested_action:
            "Keep the repeated passage in one page and link to it from the others instead of restating it.",
          tool: "read_notes",
          tool_args: { vault: input.vaultId, paths: [r.path, ...peers] },
          evidence: { dup_chunk_count: r.dup_chunk_count, dup_ratio: r.dup_ratio },
        });
      }
    }
    push("stale", stale);
    push("duplicate_chunks", dup);
    return undefined;
  });

  run("missing_sources", () => {
    const scan = scanProvenance(scope, warnings, { field: "sources", folder });
    push(
      "missing_sources",
      scan.missing.filter(subjectOk).map((p) => ({
        kind: "missing_sources" as const,
        subject: p,
        detail: "No `sources` frontmatter: the evidence behind this page's claims is not recorded.",
        suggested_action: "Add a `sources` list (links or citations) to the frontmatter.",
        tool: "update_frontmatter",
        tool_args: { vault: input.vaultId, path: p, operation: "set", key: "sources" },
      })),
    );
    return undefined;
  });

  run("coverage_gaps", () => {
    if (!env.edb) return "experiential store not open (no gap report)";
    const report = readLatestGapReport(env.edb, input.vaultId);
    if (!report) return "no gap pass has been persisted for this vault (run `obsidian-tc gaps`)";
    const gaps: Proposal[] = [];
    for (const item of report.items) {
      if (!item.gap) continue;
      const nearest = item.nearest.filter((n) => readable(n.path));
      if (prefix !== "" && !nearest.some((n) => inFolder(n.path))) continue;
      gaps.push({
        kind: "coverage_gap",
        subject: item.query,
        related: nearest.slice(0, 3).map((n) => n.path),
        detail: `Queries like this found no good page (best score ${nearest[0]?.score ?? "none"}).`,
        suggested_action:
          "If the wiki should cover this, run find_existing_page to confirm nothing does, then write_note.",
        tool: "find_existing_page",
        tool_args: { vault: input.vaultId, topic: item.query },
      });
    }
    push("coverage_gap", gaps);
    return undefined;
  });

  run("near_duplicates", () => {
    const nv = loadNoteVectors(env.db, input.vaultId, {
      model: env.embeddingModel,
      include: (p) => readable(p) && subjectOk(p),
      maxNotes: input.maxNotes,
    });
    if (nv.paths.length === 0) return "no embedded notes in scope (nothing to compare)";
    if (nv.truncated)
      notes.push(`near_duplicates compared the first ${input.maxNotes} notes only.`);
    const min = input.minSimilarity ?? NOTE_DUPLICATE_MIN;
    const pairs = nearDuplicatePairs(nv, min, 5000).filter((p) => inFolder(p.a) || inFolder(p.b));
    push(
      "near_duplicate",
      pairs.map((p) => ({
        kind: "near_duplicate" as const,
        subject: p.a,
        related: [p.b],
        detail: `These two pages may cover the same ground (note-level cosine ${p.score.toFixed(3)}, ${p.score >= NOTE_IDENTICAL_MIN ? "near-identical" : "near-duplicate"}).`,
        suggested_action:
          "Read both. Keep one page, fold the other's unique content into it, and re-point links to the survivor with rewrite_link.",
        tool: "read_notes",
        tool_args: { vault: input.vaultId, paths: [p.a, p.b] },
        evidence: { score: Number(p.score.toFixed(3)), min },
      })),
    );
    return undefined;
  });

  const rank = (k: ProposalKind): number => ORDER.indexOf(k);
  proposals.sort((a, b) => rank(a.kind) - rank(b.kind));
  const byKind: Partial<Record<ProposalKind, number>> = {};
  for (const p of proposals) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  return {
    vault: input.vaultId,
    ...(folder ? { folder } : {}),
    checks_run: checksRun,
    skipped,
    summary: { total: proposals.length, by_kind: byKind },
    proposals,
    truncated: [...truncated],
    notes,
    warnings: warnings.out(),
  };
}
