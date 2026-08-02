// Synthesis job — THE-233 W-WORKERS, collapses kb-synthesis-worker into a local plane job.
// Anthropic Opus -> gateway `synthesize` role; Supabase pulls -> SQLite. The GitHub vault-
// markdown commit is dropped — the synthesis record persists to the syntheses table; writing a
// vault note is an integration concern. Anchor-folder pulls are simplified to "recent chunks +
// open contradictions" (folder taxonomy is vault-specific and lands at integration).

import { trimToBoundary } from "../../search/evidence";
import { type IsoWeek, isoWeek } from "../../util/iso-week";
import { type GatewayRoles, prompt } from "../gateway";
import type { JobContext, JobResult } from "../plane";

export { type IsoWeek, isoWeek };

const RECENT_LIMIT = 200;
const CONTRADICTION_LIMIT = 50;
const CONTENT_TRUNCATE = 1000;

/**
 * Aggregate cap on the whole request (system + user), in characters.
 *
 * RECENT_LIMIT x CONTENT_TRUNCATE is a PER-ITEM cap, not a budget: 200 chunks each under 1000 chars
 * is still 200,000 chars. In production on 2026-08-02 this job 400'd on every run —
 * `litellm.ContextWindowExceededError`, prompt 169,258 chars against a 32,768-token serving window.
 *
 * That 32,768 is the SERVER's limit, not the model's. Qwen3-4B-Instruct-2507 is natively 262,144;
 * vLLM's `--max-model-len` is an operator-set memory lever ("reduces memory usage by setting a
 * maximum sequence length"), and the deployment behind this role picks 32,768 to fit KV cache on
 * its GPU. So the ceiling can move without the model changing at all — which is precisely why this
 * side must bound its own prompt instead of inferring a limit from the model name.
 *
 * The default is conservative because the model behind a gateway ROLE is swappable at the gateway
 * (that is the point of the indirection) and the server does not advertise `max_model_len` through
 * the LiteLLM `/v1/models` passthrough, so this side cannot discover the real ceiling.
 *
 * Measured on the live vault: **3.294 chars/token** (107,475 chars = 32,625 tokens, bisected
 * against the real endpoint). Denser content tokenizes worse — code and CJK run nearer 2.5.
 *
 * This number is the TOTAL: buildUserMessage subtracts `reserved` (the system prompt) from it, so
 * the system prompt is inside the 60,000, not on top of it. Worst case at 2.5 chars/token is
 * therefore 24,000 tokens, leaving 8,768 for the model's own JSON output inside a 32,768 window.
 * On this vault's actual prose (3.294) it is 18,214 tokens, leaving 14,554.
 *
 * Raise it via `plane.maxPromptChars` when the role points at a larger serving window.
 */
const DEFAULT_MAX_PROMPT_CHARS = 60_000;

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
  // trimToBoundary rather than a hard slice: cutting mid-word reads to a model as though the source
  // itself is malformed. Same helper the shared evidence builder uses (THE-632 / #623).
  const content =
    c.content.length > CONTENT_TRUNCATE
      ? `${trimToBoundary(c.content, CONTENT_TRUNCATE)}\n...[truncated]`
      : c.content;
  return `[${idx}] path: ${c.path} (chunk ${c.chunk_index})\ncontent: ${content}`;
}

function renderContradiction(c: ContradictionRow): string {
  return `id: ${c.id}\nsource: ${c.source_path}\nconflict: ${c.conflict_path}\nverdict: ${c.judge_verdict}\nrationale: ${c.judge_rationale}`;
}

export interface BuiltMessage {
  message: string;
  chunksUsed: number;
  chunksDropped: number;
  contradictionsUsed: number;
  contradictionsDropped: number;
}

/**
 * Build the user message within a TOTAL character budget.
 *
 * `reserved` is what the caller already spends on the system prompt, so the budget bounds the whole
 * request rather than just this half — the model counts both.
 *
 * Contradictions are placed FIRST and get the budget ahead of chunks. They are compact, and the
 * output schema requires the model to cite `contradiction_ids`: dropping them silently would ask
 * for citations of evidence never supplied. Chunks are the elastic side — they are already a
 * "newest 200" sample, so using fewer is a smaller sample, not a missing input.
 *
 * Whole items are dropped rather than half-included. A partially rendered chunk misrepresents what a
 * note says, and the model is being asked to draw cross-note patterns from exactly that content.
 */
export function buildUserMessage(
  recent: ChunkRow[],
  contradictions: ContradictionRow[],
  maxChars: number,
  reserved = 0,
): BuiltMessage {
  const budget = Math.max(0, maxChars - reserved);
  const CHUNK_HEADER = "RECENT CHUNKS:\n";
  const CONTRA_HEADER = "\n\nOPEN CONTRADICTIONS:\n";
  const NONE = "(none)";
  // Fixed scaffolding is charged first, so a tiny budget yields a small valid message rather than
  // one that silently exceeds it.
  let spent = CHUNK_HEADER.length + CONTRA_HEADER.length + NONE.length;

  const contraParts: string[] = [];
  let contradictionsUsed = 0;
  for (const c of contradictions) {
    const rendered = renderContradiction(c);
    if (spent + rendered.length + 2 > budget) break;
    contraParts.push(rendered);
    spent += rendered.length + 2;
    contradictionsUsed++;
  }

  const chunkParts: string[] = [];
  let chunksUsed = 0;
  for (const [i, c] of recent.entries()) {
    const rendered = renderChunk(c, i + 1);
    if (spent + rendered.length + 2 > budget) break;
    chunkParts.push(rendered);
    spent += rendered.length + 2;
    chunksUsed++;
  }

  const message = [
    "RECENT CHUNKS:",
    chunkParts.length === 0 ? NONE : chunkParts.join("\n\n"),
    "\n\nOPEN CONTRADICTIONS:",
    contraParts.length === 0 ? NONE : contraParts.join("\n\n"),
  ].join("\n");

  return {
    message,
    chunksUsed,
    chunksDropped: recent.length - chunksUsed,
    contradictionsUsed,
    contradictionsDropped: contradictions.length - contradictionsUsed,
  };
}

export async function runSynthesis(ctx: JobContext): Promise<JobResult> {
  const roles: GatewayRoles | null = ctx.roles;
  if (!roles) return { ok: false, detail: { skipped: "no gateway roles" } };

  // Per-vault: synthesis operates on whatever vaults actually hold content, so the plane Job
  // interface stays vault-free. DISTINCT over the indexed vault_id column is a small scan.
  const vaults = (
    ctx.db.prepare("SELECT DISTINCT vault_id FROM chunks").all() as { vault_id: string }[]
  ).map((r) => r.vault_id);
  if (vaults.length === 0) return { ok: true, detail: { skipped: "no chunks" } };

  const hasContradictions =
    ctx.db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'contradictions'")
      .get() !== undefined;

  const iso = isoWeek(new Date(ctx.now()));
  const perVault: Array<{
    vault_id: string;
    patterns: number;
    clusters: number;
    chunks_used: number;
    chunks_dropped: number;
    contradictions_used: number;
    contradictions_dropped: number;
  }> = [];

  for (const vaultId of vaults) {
    const recent = ctx.db
      .prepare(
        "SELECT path, chunk_index, headings, content FROM chunks WHERE vault_id = ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(vaultId, RECENT_LIMIT) as ChunkRow[];
    if (recent.length === 0) continue;

    const contradictions = hasContradictions
      ? (ctx.db
          .prepare(
            "SELECT id, source_path, conflict_path, judge_verdict, judge_rationale FROM contradictions WHERE status = 'open' AND vault_id = ? ORDER BY detected_at DESC LIMIT ?",
          )
          .all(vaultId, CONTRADICTION_LIMIT) as ContradictionRow[])
      : [];

    // The budget bounds the WHOLE request, so the system prompt is charged against it here rather
    // than left as invisible overhead the caller cannot see.
    const built = buildUserMessage(
      recent,
      contradictions,
      ctx.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
      SYSTEM_PROMPT.length,
    );
    if (built.chunksDropped > 0 || built.contradictionsDropped > 0) {
      ctx.log?.(
        `synthesis: prompt budget dropped ${built.chunksDropped} chunk(s) and ${built.contradictionsDropped} contradiction(s) for vault ${vaultId} — raise plane.maxPromptChars if the synthesize role has a larger context`,
      );
    }
    const res = await roles.synthesize(prompt(SYSTEM_PROMPT, built.message));
    let synthesis: SynthesisOutput;
    try {
      synthesis = parseSynthesis(res.text);
    } catch (e) {
      return { ok: false, detail: { vault_id: vaultId, error: (e as Error).message } };
    }

    ctx.db
      .prepare(
        "INSERT INTO syntheses (vault_id, iso_year, iso_week, generated_at, cluster_count, pattern_count, clusters, patterns, judge_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(vault_id, iso_year, iso_week) DO UPDATE SET generated_at = excluded.generated_at, cluster_count = excluded.cluster_count, pattern_count = excluded.pattern_count, clusters = excluded.clusters, patterns = excluded.patterns, judge_model = excluded.judge_model",
      )
      .run(
        vaultId,
        iso.year,
        iso.week,
        ctx.now(),
        synthesis.clusters.length,
        synthesis.patterns.length,
        JSON.stringify(synthesis.clusters),
        JSON.stringify(synthesis.patterns),
        res.model,
      );
    perVault.push({
      vault_id: vaultId,
      patterns: synthesis.patterns.length,
      clusters: synthesis.clusters.length,
      chunks_used: built.chunksUsed,
      chunks_dropped: built.chunksDropped,
      contradictions_used: built.contradictionsUsed,
      contradictions_dropped: built.contradictionsDropped,
    });
  }

  if (perVault.length === 0) return { ok: true, detail: { skipped: "no chunks" } };
  return { ok: true, detail: { iso_year: iso.year, iso_week: iso.week, vaults: perVault } };
}
