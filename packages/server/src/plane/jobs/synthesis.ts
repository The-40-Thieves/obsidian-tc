// Synthesis job — THE-233 W-WORKERS, collapses kb-synthesis-worker into a local plane job.
// Anthropic Opus -> gateway `synthesize` role; Supabase pulls -> SQLite. The GitHub vault-
// markdown commit is dropped — the synthesis record persists to the syntheses table; writing a
// vault note is an integration concern. Anchor-folder pulls are simplified to "recent chunks +
// open contradictions" (folder taxonomy is vault-specific and lands at integration).

import { type IsoWeek, isoWeek } from "../../util/iso-week";
import { type GatewayRoles, prompt } from "../gateway";
import type { Job, JobContext, JobResult } from "../plane";

export { type IsoWeek, isoWeek };

const RECENT_LIMIT = 200;
const CONTRADICTION_LIMIT = 50;
const CONTENT_TRUNCATE = 1000;

interface ChunkRow {
  path: string;
  chunk_index: string;
  headings: string;
  content: string;
}
interface ContradictionRow {
  id: string;
  source_path: string;
  conflict_path: string;
  judge_verdict: string;
  judge_rationale: string;
}

export interface SynthesisOutput {
  patterns: {
    title: string;
    summary: string;
    evidence_paths: string[];
    contradiction_ids: string[];
  }[];
  clusters: { label: string; summary: string; chunk_paths: string[] }[];
}

const SYSTEM_PROMPT = `You are an analyst reviewing chunks of an Obsidian second-brain vault.

Identify cross-cluster PATTERNS from recent vault activity. A pattern is a thread that runs through multiple chunks and matters for what comes next — connections, tensions, emerging themes, repeated framings, or shifts in direction. Patterns are NOT summaries of single notes.

You receive RECENT CHUNKS and OPEN CONTRADICTIONS (previously-flagged conflicts in the user's own thinking). Produce 3 to 7 patterns and 3 to 6 clusters.

For each PATTERN: title (5-9 words), summary (2-3 specific sentences), evidence_paths (2-5 paths), contradiction_ids (ids of OPEN CONTRADICTIONS it touches, else []).
For each CLUSTER: label (2-5 words), summary (one sentence), chunk_paths (3-8 paths).

Output STRICT JSON only. No prose, no code fences. Schema:
{"patterns":[{"title":"...","summary":"...","evidence_paths":["..."],"contradiction_ids":["..."]}],"clusters":[{"label":"...","summary":"...","chunk_paths":["..."]}]}`;

export function parseSynthesis(raw: string): SynthesisOutput {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const parsed = JSON.parse(stripped) as SynthesisOutput;
  if (!parsed || !Array.isArray(parsed.patterns) || !Array.isArray(parsed.clusters)) {
    throw new Error("synthesis JSON missing patterns or clusters arrays");
  }
  return parsed;
}

function renderChunk(c: ChunkRow, idx: number): string {
  const content =
    c.content.length > CONTENT_TRUNCATE
      ? `${c.content.slice(0, CONTENT_TRUNCATE)}\n...[truncated]`
      : c.content;
  return `[${idx}] path: ${c.path} (chunk ${c.chunk_index})\ncontent: ${content}`;
}

function buildUserMessage(recent: ChunkRow[], contradictions: ContradictionRow[]): string {
  const parts: string[] = ["RECENT CHUNKS:"];
  parts.push(
    recent.length === 0 ? "(none)" : recent.map((c, i) => renderChunk(c, i + 1)).join("\n\n"),
  );
  parts.push("\n\nOPEN CONTRADICTIONS:");
  parts.push(
    contradictions.length === 0
      ? "(none)"
      : contradictions
          .map(
            (c) =>
              `id: ${c.id}\nsource: ${c.source_path}\nconflict: ${c.conflict_path}\nverdict: ${c.judge_verdict}\nrationale: ${c.judge_rationale}`,
          )
          .join("\n\n"),
  );
  return parts.join("\n");
}

export async function runSynthesis(ctx: JobContext): Promise<JobResult> {
  const roles: GatewayRoles | null = ctx.roles;
  if (!roles) return { ok: false, detail: { skipped: "no gateway roles" } };
  const recent = ctx.db
    .prepare(
      "SELECT path, chunk_index, headings, content FROM chunks ORDER BY updated_at DESC LIMIT ?",
    )
    .all(RECENT_LIMIT) as ChunkRow[];
  if (recent.length === 0) return { ok: true, detail: { skipped: "no chunks" } };
  // Open contradictions are optional context; skip gracefully if the plane table is absent
  // (pre-integration, before the plane migration is wired into the migrate chain).
  const hasContradictions =
    ctx.db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'contradictions'")
      .get() !== undefined;
  const contradictions = hasContradictions
    ? (ctx.db
        .prepare(
          "SELECT id, source_path, conflict_path, judge_verdict, judge_rationale FROM contradictions WHERE status = 'open' ORDER BY detected_at DESC LIMIT ?",
        )
        .all(CONTRADICTION_LIMIT) as ContradictionRow[])
    : [];

  const res = await roles.synthesize(
    prompt(SYSTEM_PROMPT, buildUserMessage(recent, contradictions)),
  );
  let synthesis: SynthesisOutput;
  try {
    synthesis = parseSynthesis(res.text);
  } catch (e) {
    return { ok: false, detail: { error: (e as Error).message } };
  }

  const iso = isoWeek(new Date(ctx.now()));
  ctx.db
    .prepare(
      "INSERT INTO syntheses (iso_year, iso_week, generated_at, cluster_count, pattern_count, clusters, patterns, judge_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(iso_year, iso_week) DO UPDATE SET generated_at = excluded.generated_at, cluster_count = excluded.cluster_count, pattern_count = excluded.pattern_count, clusters = excluded.clusters, patterns = excluded.patterns, judge_model = excluded.judge_model",
    )
    .run(
      iso.year,
      iso.week,
      ctx.now(),
      synthesis.clusters.length,
      synthesis.patterns.length,
      JSON.stringify(synthesis.clusters),
      JSON.stringify(synthesis.patterns),
      res.model,
    );
  return {
    ok: true,
    detail: {
      iso_year: iso.year,
      iso_week: iso.week,
      patterns: synthesis.patterns.length,
      clusters: synthesis.clusters.length,
    },
  };
}

export const synthesisJob: Job = { name: "synthesis", run: runSynthesis };
