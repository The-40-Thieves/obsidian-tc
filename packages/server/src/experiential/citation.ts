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

/**
 * A transcript tokenized and interned ONCE, so the per-chunk loop below does not redo it.
 *
 * `inferCitations` scores every retrieved chunk against the SAME transcript. The previous
 * `rougeL(chunk, transcript)` signature forced `tokenize(transcript, 6000)` — a lowercase pass
 * plus a global regex match over the whole transcript — to run again for every chunk, and the DP
 * then compared JS STRINGS in its innermost cell. Measured at the module's own bounds
 * (512 x 6000 = 3,072,000 cells): 62.6 ns/cell with string compares, 40.1 ns/cell over interned
 * ints, for an identical score. Hoisting the tokenize is pure removed work on top of that.
 */
export interface PreparedTranscript {
  /** Interned transcript token ids, in order. Ids are dense, `0 .. index.size - 1`. */
  readonly ids: Int32Array;
  /** token -> id. A chunk token ABSENT from this map is unmatchable — see `UNMATCHABLE`. */
  readonly index: ReadonlyMap<string, number>;
}

/**
 * Sentinel for a chunk token the transcript never contains. It must sit OUTSIDE the dense id
 * range, because the DP's match test is `a[i] === b[j]`: a `?? 0` fallback would alias every
 * unknown chunk token onto transcript token 0 and inflate the score. Chunk tokens are never
 * compared against each other, so a shared sentinel is safe.
 */
const UNMATCHABLE = -1;

/** Tokenize + intern a transcript once for reuse across every chunk in a citation pass. */
export function prepareTranscript(transcript: string): PreparedTranscript {
  const toks = tokenize(transcript, MAX_TRANSCRIPT_TOKENS);
  const index = new Map<string, number>();
  const ids = new Int32Array(toks.length);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as string;
    let id = index.get(t);
    if (id === undefined) {
      id = index.size;
      index.set(t, id);
    }
    ids[i] = id;
  }
  return { ids, index };
}

/**
 * ROUGE-L F1 of `chunk` against an already-prepared transcript. Same two-row LCS DP as before,
 * over `Int32Array` instead of `string[]`; `rougeLPrepared(c, prepareTranscript(t))` is exactly
 * `rougeL(c, t)`, pinned by a test.
 */
export function rougeLPrepared(chunk: string, prepared: PreparedTranscript): number {
  const toks = tokenize(chunk, MAX_CHUNK_TOKENS);
  const tb = prepared.ids;
  if (toks.length === 0 || tb.length === 0) return 0;
  const ta = new Int32Array(toks.length);
  for (let i = 0; i < toks.length; i++) {
    ta[i] = prepared.index.get(toks[i] as string) ?? UNMATCHABLE;
  }
  let prev = new Int32Array(tb.length + 1);
  let curr = new Int32Array(tb.length + 1);
  for (let i = 1; i <= ta.length; i++) {
    const ai = ta[i - 1] as number;
    for (let j = 1; j <= tb.length; j++) {
      curr[j] =
        ai === tb[j - 1]
          ? (prev[j - 1] as number) + 1
          : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[tb.length] as number;
  if (lcs === 0) return 0;
  const p = lcs / ta.length;
  const r = lcs / tb.length;
  return (2 * p * r) / (p + r);
}

/** ROUGE-L F1 of a vs b (token LCS; two-row DP, capped for bounded cost). Prefer
 *  `prepareTranscript` + `rougeLPrepared` when scoring many chunks against one transcript. */
export function rougeL(a: string, b: string): number {
  return rougeLPrepared(a, prepareTranscript(b));
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

/** The widened contract, used ONLY when `allowUncertain` is set. Kept as a separate string rather
 *  than a conditional fragment so the default prompt is byte-identical to what has always shipped:
 *  a judge prompt is model-visible input, and changing it changes model output on every call. */
const JUDGE_SYSTEM_UNCERTAIN =
  "You judge citation. Given a SOURCE chunk and a RESPONSE, decide whether the RESPONSE uses " +
  "information from the SOURCE (paraphrase counts; shared topic alone does not). Respond with " +
  'ONLY strict JSON: {"cited": true|false|"uncertain", "score": <number 0..1>}. Answer ' +
  '"uncertain" when the evidence genuinely does not settle it — abstention is better than a ' +
  "confident guess. No prose, no fences.";

/** `true`/`false` are the judge's verdict; `"uncertain"` is its abstention, and only reachable
 *  when the caller opted in (see `allowUncertain`). */
type JudgeVerdict = { cited: boolean | "uncertain"; score: number };

/**
 * `allowUncertain` gates the WIDER vocabulary on the parse side too, deliberately.
 *
 * A rejected parse is not free: it increments `parseFailures`, and >5% of judged rows aborts the
 * entire stamping pass (the kill switch). So the prompt and the parser have to move together — a
 * widened prompt against this parser's old `typeof v.cited !== "boolean"` check would turn every
 * abstention into a parse failure and could abort a whole run. Gating both on one flag makes that
 * pairing impossible to get half-right.
 *
 * With the flag OFF the behaviour is byte-identical to before: an `"uncertain"` reply is still a
 * parse failure, exactly as it is today.
 */
function parseVerdict(text: string, allowUncertain: boolean): JudgeVerdict | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const v = JSON.parse(stripped) as { cited?: unknown; score?: unknown };
    const score = typeof v.score === "number" && Number.isFinite(v.score) ? v.score : 0;
    const clamped = Math.max(0, Math.min(1, score));
    if (typeof v.cited === "boolean") return { cited: v.cited, score: clamped };
    if (allowUncertain && v.cited === "uncertain") return { cited: "uncertain", score: clamped };
    return null;
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
  /**
   * Let the judge abstain. DARK BY DEFAULT, and that is the point.
   *
   * Enabling it changes two model-visible things at once: the judge prompt gains a third allowed
   * answer, and rows the judge declines to settle stamp `cited_in_response = 0` instead of `1`.
   * That MOVES ROWS OUT OF THE CITATION COUNT read by chunk_access_stats, contribution.ts and
   * metrics.ts. It is very likely the right answer — abstention beats fabricated certainty — but
   * "likely right" is not the bar here: this repo ships retrieval policy dark until it beats a
   * baseline on the golden set (13 of 15 flags in retrieval.schema.ts default false), and a change
   * to what a model is asked belongs in the same category.
   *
   * There is no NULL option for an abstention, incidentally: NULL means "unprocessed", so an
   * uncertain row left NULL would be re-judged on every run and abstain again forever.
   */
  allowUncertain?: boolean;
  thresholds?: { rouge?: number; cosine?: number; killSwitch?: number };
  /** THE-617 item 3 — cap on how many stage-1 survivors get judged per run (bounded judge
   *  cost). Same default/shape as reflect.ts's identically-named MAX_JUDGED, but this is a
   *  SEPARATE knob: citation-inference judgements and episode-evaluation judgements are
   *  independent workloads and should be tunable independently. Override via --max-judged on
   *  the citation-infer CLI. Default 25. */
  maxJudged?: number;
  log?: (line: string) => void;
}

export interface InferCitationsStats {
  scoped: number;
  stage1Pass: number;
  judged: number;
  cited: number;
  /** Judge abstentions. Always 0 unless `allowUncertain` is set. */
  uncertain: number;
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
    return {
      scoped: 0,
      stage1Pass: 0,
      judged: 0,
      cited: 0,
      uncertain: 0,
      parseFailures: 0,
      aborted: false,
    };
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
  // Tokenize + intern the transcript ONCE. Every chunk below scores against this same transcript,
  // so the old `rougeL(content, transcript)` call redid a full lowercase + regex tokenize of it per
  // chunk — O(chunks x 6000 tokens) of work that produces the identical array every time.
  const preparedTranscript = prepareTranscript(opts.transcript);
  for (const chunkId of chunkIds) {
    const row = contentStmt.get(chunkId) as { content: string } | undefined;
    if (!row) continue; // chunk deleted since retrieval — nothing to compare
    const rouge = rougeLPrepared(row.content, preparedTranscript);
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
  const verdicts = new Map<string, JudgeVerdict>();
  let judged = 0;
  let parseFailures = 0;
  if (opts.judge && passers.length > 0) {
    for (const a of passers.slice(0, opts.maxJudged ?? MAX_JUDGED)) {
      const req = {
        ...prompt(
          opts.allowUncertain ? JUDGE_SYSTEM_UNCERTAIN : JUDGE_SYSTEM,
          `SOURCE:\n${a.content.slice(0, 1500)}\n\nRESPONSE:\n${opts.transcript.slice(0, 4000)}`,
        ),
        responseFormat: { type: "json_object" },
      };
      judged += 1;
      try {
        const res = await opts.judge(req);
        const v = parseVerdict(res.text, opts.allowUncertain === true);
        if (v) verdicts.set(a.chunkId, v);
        else parseFailures += 1;
      } catch {
        parseFailures += 1;
      }
    }
  }
  const aborted = judged > 0 && parseFailures / judged > th.killSwitch;
  if (aborted) log(`citation-infer: kill switch — ${parseFailures}/${judged} judge parse failures`);

  // `citation_state` (20260731_001) records WHY each verdict is what it is. `cited_in_response`
  // keeps its exact prior semantics — the values written below are unchanged — because it is read
  // as a citation count by chunk_access_stats, contribution.ts and metrics.ts, and changing what
  // those count is a data-semantics decision, not a refactor. See the migration header.
  //
  // The WHERE guard still keys on `cited_in_response IS NULL`, deliberately: that is the existing
  // idempotency contract, and moving it to citation_state would re-stamp every row written before
  // this migration.
  const stamp = opts.edb.prepare(
    `UPDATE chunk_retrievals SET cited_in_response = ?, citation_score = ?, citation_state = ?
     WHERE chunk_id = ? AND cited_in_response IS NULL AND ${scopeClause}`,
  );
  let cited = 0;
  let uncertain = 0;
  for (const a of negatives) {
    stamp.run(0, a.cosine ?? a.rouge, "rejected", a.chunkId, ...scopeParams);
  }
  for (const a of passers) {
    if (opts.judge) {
      if (aborted) continue; // leave NULL for a clean rerun — state stays NULL too
      const v = verdicts.get(a.chunkId);
      if (!v) continue; // this chunk's judgement failed to parse — rerun later
      if (v.cited === "uncertain") {
        // An abstention is NOT a citation, so it must not count as one — but it is also not the
        // judge saying "no", which is why it gets its own state rather than being folded into
        // 'rejected'. Only reachable with allowUncertain set.
        stamp.run(0, v.score, "uncertain", a.chunkId, ...scopeParams);
        uncertain += 1;
      } else {
        stamp.run(
          v.cited ? 1 : 0,
          v.score,
          v.cited ? "confirmed" : "rejected",
          a.chunkId,
          ...scopeParams,
        );
        if (v.cited) cited += 1;
      }
    } else {
      // Stage-1-only: this row is stamped cited_in_response = 1 and therefore COUNTS as a citation
      // downstream, but nothing ever checked it against the transcript — it only cleared the cheap
      // ROUGE-L/cosine filter. `candidate` is the honest name for that, and making it queryable is
      // the whole point of this column: `SELECT count(*) ... WHERE citation_state = 'candidate'`
      // now answers "how much of our citation signal was never actually judged?"
      stamp.run(1, a.cosine ?? a.rouge, "candidate", a.chunkId, ...scopeParams);
      cited += 1;
    }
  }

  return {
    scoped: chunkIds.length,
    stage1Pass: passers.length,
    judged,
    cited,
    uncertain,
    parseFailures,
    aborted,
  };
}
