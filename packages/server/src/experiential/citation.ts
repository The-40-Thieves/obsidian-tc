// THE-170 — citation inference: the AUTOMATIC outcome writer over chunk_retrievals. Given a
// session transcript (assistant-side text the MCP server itself never sees), infer per
// retrieved chunk whether it was actually USED in the response and stamp
// cited_in_response / citation_score (record_retrieval_feedback is the manual counterpart).
// Two-stage per the 2026-05-16 design anchors, de-vendored onto local seams:
//   Stage 1 (cheap filter): ROUGE-L F of chunk content vs the transcript, OR max cosine of
//   the chunk's STORED embedding against embedded transcript blocks. Thresholds 0.05 / 0.30
//   carried from the design; the DoD's hand-labeled validation runs at data maturity.
//   Stage 2 (judge): the gateway `judge` role, strict-JSON entailment per stage-1 survivor,
//   with the DoD kill switch — >5% parse failures aborts stage-2 stamping (survivor rows stay
//   NULL for a clean rerun). Stage-1 NEGATIVES are always safe to stamp cited=0.
// Correlation: session_id (threaded from ctx into every retrieval-log call) or a
// retrieved_at window — the join the THE-228 capture bus made trivial.
import type { Database } from "../db/types";
import type { GatewayRoles } from "../plane/gateway";
import { prompt } from "../plane/gateway";
import { cosineSimilarity } from "../search/native";

const MAX_CHUNK_TOKENS = 512;
const MAX_TRANSCRIPT_TOKENS = 6000;
const MAX_BLOCKS = 48;
const MAX_JUDGED = 25;

function tokenize(text: string, cap: number): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, cap);
}

/** ROUGE-L F1 of a vs b (token LCS; two-row DP, capped for bounded cost). */
export function rougeL(a: string, b: string): number {
  const ta = tokenize(a, MAX_CHUNK_TOKENS);
  const tb = tokenize(b, MAX_TRANSCRIPT_TOKENS);
  if (ta.length === 0 || tb.length === 0) return 0;
  let prev = new Array<number>(tb.length + 1).fill(0);
  let curr = new Array<number>(tb.length + 1).fill(0);
  for (let i = 1; i <= ta.length; i++) {
    for (let j = 1; j <= tb.length; j++) {
      curr[j] =
        ta[i - 1] === tb[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[tb.length] ?? 0;
  if (lcs === 0) return 0;
  const p = lcs / ta.length;
  const r = lcs / tb.length;
  return (2 * p * r) / (p + r);
}

/** Split a transcript into embeddable blocks (blank-line paragraphs, capped). */
function transcriptBlocks(transcript: string): string[] {
  return transcript
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 20)
    .slice(0, MAX_BLOCKS)
    .map((b) => b.slice(0, 800));
}

const JUDGE_SYSTEM =
  "You judge citation. Given a SOURCE chunk and a RESPONSE, decide whether the RESPONSE uses " +
  "information from the SOURCE (paraphrase counts; shared topic alone does not). Respond with " +
  'ONLY strict JSON: {"cited": true|false, "score": <number 0..1>}. No prose, no fences.';

function parseVerdict(text: string): { cited: boolean; score: number } | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const v = JSON.parse(stripped) as { cited?: unknown; score?: unknown };
    if (typeof v.cited !== "boolean") return null;
    const score = typeof v.score === "number" && Number.isFinite(v.score) ? v.score : 0;
    return { cited: v.cited, score: Math.max(0, Math.min(1, score)) };
  } catch {
    return null;
  }
}

export interface InferCitationsOptions {
  /** Experiential store (chunk_retrievals lives here). */
  edb: Database;
  /** Authored cache store (chunks + chunk_embeddings for content + stored vectors). */
  cacheDb: Database;
  transcript: string;
  /** Scope: a workspace session id ... */
  sessionId?: string;
  /** ... or a retrieved_at window [since, until] in ms epoch. One of the two is required. */
  windowMs?: [number, number];
  /** Query-side embedder for transcript blocks; absent -> ROUGE-only stage 1. */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** Gateway judge role; absent/null -> stage-1-only mode (survivors stamp cited=1). */
  judge?: GatewayRoles["judge"] | null;
  thresholds?: { rouge?: number; cosine?: number; killSwitch?: number };
  log?: (line: string) => void;
}

export interface InferCitationsStats {
  scoped: number;
  stage1Pass: number;
  judged: number;
  cited: number;
  parseFailures: number;
  aborted: boolean;
}

export async function inferCitations(opts: InferCitationsOptions): Promise<InferCitationsStats> {
  const th = {
    rouge: opts.thresholds?.rouge ?? 0.05,
    cosine: opts.thresholds?.cosine ?? 0.3,
    killSwitch: opts.thresholds?.killSwitch ?? 0.05,
  };
  const log = opts.log ?? (() => {});

  let scopeClause: string;
  const scopeParams: unknown[] = [];
  if (opts.sessionId !== undefined) {
    scopeClause = "session_id = ?";
    scopeParams.push(opts.sessionId);
  } else if (opts.windowMs) {
    scopeClause = "retrieved_at BETWEEN ? AND ?";
    scopeParams.push(opts.windowMs[0], opts.windowMs[1]);
  } else {
    throw new Error("inferCitations: sessionId or windowMs is required");
  }

  const chunkIds = (
    opts.edb
      .prepare(
        `SELECT DISTINCT chunk_id AS id FROM chunk_retrievals
         WHERE cited_in_response IS NULL AND ${scopeClause}`,
      )
      .all(...scopeParams) as Array<{ id: string }>
  ).map((r) => r.id);
  if (chunkIds.length === 0) {
    return { scoped: 0, stage1Pass: 0, judged: 0, cited: 0, parseFailures: 0, aborted: false };
  }

  const contentStmt = opts.cacheDb.prepare("SELECT content FROM chunks WHERE id = ?");
  const embStmt = opts.cacheDb.prepare(
    "SELECT embedding FROM chunk_embeddings WHERE chunk_id = ? AND is_active = 1",
  );

  // Embed transcript blocks once (cosine leg is optional).
  let blockVecs: number[][] = [];
  if (opts.embed) {
    const blocks = transcriptBlocks(opts.transcript);
    if (blocks.length > 0) {
      try {
        blockVecs = await opts.embed(blocks);
      } catch (e) {
        log(
          `citation-infer: transcript embed failed (${e instanceof Error ? e.message : e}); ROUGE-only`,
        );
        blockVecs = [];
      }
    }
  }

  interface Assessment {
    chunkId: string;
    content: string;
    rouge: number;
    cosine: number | null;
    pass: boolean;
  }
  const assessments: Assessment[] = [];
  for (const chunkId of chunkIds) {
    const row = contentStmt.get(chunkId) as { content: string } | undefined;
    if (!row) continue; // chunk deleted since retrieval — nothing to compare
    const rouge = rougeL(row.content, opts.transcript);
    let cosine: number | null = null;
    if (blockVecs.length > 0) {
      const emb = embStmt.get(chunkId) as { embedding: Uint8Array } | undefined;
      if (emb) {
        const vec = new Float32Array(
          emb.embedding.buffer,
          emb.embedding.byteOffset,
          emb.embedding.byteLength / 4,
        );
        for (const bv of blockVecs) {
          const sim = cosineSimilarity(bv, vec);
          if (cosine === null || sim > cosine) cosine = sim;
        }
      }
    }
    const pass = rouge >= th.rouge || (cosine !== null && cosine >= th.cosine);
    assessments.push({ chunkId, content: row.content, rouge, cosine, pass });
  }

  const passers = assessments.filter((a) => a.pass);
  const negatives = assessments.filter((a) => !a.pass);

  // Stage 2: judge the survivors (bounded), collecting per-chunk verdicts.
  const verdicts = new Map<string, { cited: boolean; score: number }>();
  let judged = 0;
  let parseFailures = 0;
  if (opts.judge && passers.length > 0) {
    for (const a of passers.slice(0, MAX_JUDGED)) {
      const req = {
        ...prompt(
          JUDGE_SYSTEM,
          `SOURCE:\n${a.content.slice(0, 1500)}\n\nRESPONSE:\n${opts.transcript.slice(0, 4000)}`,
        ),
        responseFormat: { type: "json_object" },
      };
      judged += 1;
      try {
        const res = await opts.judge(req);
        const v = parseVerdict(res.text);
        if (v) verdicts.set(a.chunkId, v);
        else parseFailures += 1;
      } catch {
        parseFailures += 1;
      }
    }
  }
  const aborted = judged > 0 && parseFailures / judged > th.killSwitch;
  if (aborted) log(`citation-infer: kill switch — ${parseFailures}/${judged} judge parse failures`);

  const stamp = opts.edb.prepare(
    `UPDATE chunk_retrievals SET cited_in_response = ?, citation_score = ?
     WHERE chunk_id = ? AND cited_in_response IS NULL AND ${scopeClause}`,
  );
  let cited = 0;
  for (const a of negatives) {
    stamp.run(0, a.cosine ?? a.rouge, a.chunkId, ...scopeParams);
  }
  for (const a of passers) {
    if (opts.judge) {
      if (aborted) continue; // leave NULL for a clean rerun
      const v = verdicts.get(a.chunkId);
      if (!v) continue; // this chunk's judgement failed to parse — rerun later
      stamp.run(v.cited ? 1 : 0, v.score, a.chunkId, ...scopeParams);
      if (v.cited) cited += 1;
    } else {
      stamp.run(1, a.cosine ?? a.rouge, a.chunkId, ...scopeParams);
      cited += 1;
    }
  }

  return {
    scoped: chunkIds.length,
    stage1Pass: passers.length,
    judged,
    cited,
    parseFailures,
    aborted,
  };
}
