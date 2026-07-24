// M7 — the knowledge domain (THE-233 integration). Exposes the folded retrieval-intelligence
// as MCP tools now that vault_edges (W-SCHEMA, populated by W-INGEST) and the gateway seams are
// on the branch: vault_graph_search (W-RETRIEVAL GraphRAG) and knowledge_challenge (W-WORKERS
// red-team core). Both degrade gracefully when the inference gateway is unconfigured.
// knowledge_get_critical is intentionally absent (vendor-KB data model not in the tree).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { err, grantsAll, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { tableExists } from "../../db/introspect";
import type { Database } from "../../db/types";
import type { EmbeddingProvider } from "../../embeddings";
import type { RetrievalLogger } from "../../experiential/log";
import type { ToolDefinition } from "../../mcp/registry";
import {
  type ContradictionContext,
  challengeProposal,
  type EvidenceChunk,
  isDecisionChunk,
} from "../../plane/challenge";
import { type GatewayRoles, prompt } from "../../plane/gateway";
import { bm25Chunks } from "../../search/chunk_fts";
import { readGeneration } from "../../search/generation";
import {
  type GraphSearchOptions,
  type GraphSearchResult,
  graphSearch,
} from "../../search/graph_search";
import {
  callerAclFingerprint,
  DEFAULT_PREFETCH_TTL_MS,
  prewarmPathFor,
  readPrewarm,
  writePrewarm,
} from "../../search/prefetch";
import type { Reranker } from "../../search/rerank";
import { lexicalRouteResults, routeQuery } from "../../search/router";
import { semanticSearch } from "../../search/semantic";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel } from "../../vault/acl-read-filter";
import { normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import type { VaultRegistry } from "../../vault/registry";
import { defineTool } from "../m1/define";
import { resolveQueryColbert, resolveQuerySparse } from "./query-sparse";

export interface M7Deps {
  vaultRegistry: VaultRegistry;
  embeddingProvider: EmbeddingProvider;
  /** Rerank seam → gateway /rerank passthrough; null when the gateway is unconfigured. */
  reranker: Reranker | null;
  /** Generative roles → gateway extract/synthesize/judge; null when unconfigured. */
  roles: GatewayRoles | null;
  /** THE-397: config-driven retrieval knobs (config.retrieval); absent -> graphSearch defaults. */
  retrieval?: {
    rrfK?: number;
    sparse?: boolean;
    colbert?: boolean;
    densify?: { includeInWalk?: boolean; derivedWeight?: number };
    /** THE-391/THE-536: adaptive per-stream RRF weighting. Absent/false -> static RRF, byte-
     *  identical to today. */
    adaptiveRrf?: { enabled?: boolean; gain?: number };
  };
  /** Config-driven POST-FUSION ranking overlays (config.ranking); absent -> graphSearch defaults
   *  (metadata prior OFF). */
  ranking?: {
    metadataPrior?: {
      enabled?: boolean;
      rules?: Array<{ field: string; value: string; boost: number }>;
      clampFraction?: number;
    };
  };
  /** THE-230: serve-path retrieval logging into the experiential store; absent -> no logging. */
  retrievalLog?: RetrievalLogger;
  /** THE-187/193: cached_activation_score lookup for the graph bubble pass; absent -> inert
   *  (the config-gated dark default until the A/B passes the ship rule). */
  activationFor?: (chunkId: string) => number | null;
  /** THE-258: the deterministic class router (retrieval.classRouter). Dark by default —
   *  absent/false, every query takes the measured standard path. */
  classRouter?: boolean;
  /** THE-132/229: open experiential handle for vault_context's include_work leg; absent ->
   *  include_work reports work_unavailable. */
  edb?: Database;
  /** THE-231: per-vault memory folder (same source as M5) — where the next-session signal
   *  note lives for vault_context's bootstrap mode; absent -> "memory". */
  memoryFolder?: (vaultId: string) => string;
  /** THE-136: directory holding the prewarm cache (prewarm-<vault>.json). When set, bootstrap
   *  mode reads a fresh entry instead of cold-querying and writes through on a live compose;
   *  absent -> every bootstrap composes live. */
  prewarmDir?: string;
}

/** THE-231: lesson-class paths — decision notes, lessons, postmortems, retros. Convention-based
 *  (path substring), matching the vault layouts the challenge corpus already assumes. */
const LESSON_PATH_RE = /decision|lesson|postmortem|retro/i;
/** THE-231: the queued-thread signal note written at the end of the previous session. */
const NEXT_SESSION_NOTE = "_next-session.md";

/** THE-222: grounded-synthesis role prompt for reflect's default mode. */
const REFLECT_SYSTEM_PROMPT =
  "You synthesize a grounded answer from the user's own notes. Use ONLY the numbered evidence " +
  "chunks; cite them inline as [n]; state plainly what the evidence does not establish. " +
  "Concise, factual, no filler.";

/** THE-132: greedy budget packer — walk fused-rank order, spend token costs until the budget
 *  binds. Pure and exported for the packing pins. */
export function packBudget<T>(
  items: T[],
  tokenOf: (item: T) => number,
  budget: number,
): { packed: T[]; tokens: number } {
  const packed: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const cost = Math.max(1, tokenOf(item));
    if (tokens + cost > budget && packed.length > 0) break;
    packed.push(item);
    tokens += cost;
    if (tokens >= budget) break;
  }
  return { packed, tokens };
}

const CHALLENGE_RECALL = 30;

/** THE-543 layer 3 (defence in depth): every vault-relative path a cached prewarm bundle
 *  references, so the hit path can re-run each one through readableRel before trusting the
 *  bundle — even a bundle whose cache key checks out gets one final authorization pass. */
function prewarmBundlePaths(bundle: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ["notes", "lessons"] as const) {
    const arr = bundle[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const p = (item as { path?: unknown } | null)?.path;
      if (typeof p === "string") paths.push(p);
    }
  }
  return paths;
}

/** THE-545: every CONFIG-DERIVED graphSearch option, assembled in exactly one place.
 *
 *  The four graphSearch call sites in this module each hand-assembled this object, and the copies
 *  drifted. `ranking.metadataPrior` reached vault_context and reflect but neither
 *  vault_graph_search — the primary search verb — nor knowledge_search. Partial reachability is
 *  worse than no reachability: the knob measurably changed two surfaces and silently did nothing on
 *  the other two, so any measurement taken on one surface did not describe the others.
 *
 *  The generator of that defect was the hand-assembly itself — a new knob had to be remembered four
 *  separate times, and remembering is not a mechanism. Routing every site through one builder makes
 *  threading structural: a knob added here reaches every surface by construction.
 *
 *  Genuinely per-site values stay explicit parameters rather than being defaulted here, so a
 *  deliberate deviation stays visible at its call site. `reranker` is the one that matters:
 *  knowledge_search pins it to null on purpose (THE-441, reranking lost on the docs corpus), and
 *  that decision must not look like an omission. */
export function buildGraphSearchOptions(
  deps: M7Deps,
  site: {
    route: { class: string };
    query: string;
    queryVec: number[];
    querySparse?: GraphSearchOptions["querySparse"];
    queryColbert?: GraphSearchOptions["queryColbert"];
    vaultId: string;
    finalTopK: number;
    reranker: GraphSearchOptions["reranker"];
    isReadable: GraphSearchOptions["isReadable"];
  },
): GraphSearchOptions {
  return {
    ...(site.route.class === "temporal" ? { temporal: { enabled: true } } : {}),
    query: site.query,
    queryVec: site.queryVec,
    model: deps.embeddingProvider.id, // THE-530: constrain seeds to the active model
    vaultId: site.vaultId,
    finalTopK: site.finalTopK,
    ...(deps.retrieval?.rrfK !== undefined ? { rrfK: deps.retrieval.rrfK } : {}),
    ...(deps.retrieval?.densify?.includeInWalk ? { densify: deps.retrieval.densify } : {}),
    ...(deps.retrieval?.adaptiveRrf?.enabled ? { adaptiveRrf: deps.retrieval.adaptiveRrf } : {}),
    ...(deps.ranking?.metadataPrior?.enabled ? { metadataPrior: deps.ranking.metadataPrior } : {}),
    ...(site.querySparse ? { querySparse: site.querySparse } : {}),
    ...(site.queryColbert ? { queryColbert: site.queryColbert } : {}),
    reranker: site.reranker,
    isReadable: site.isReadable,
    ...(deps.activationFor ? { activationFor: deps.activationFor } : {}),
  };
}

/** Note-level frontmatter tags for the given paths (THE-309), so isDecisionChunk's tag rule can
 *  fire on the retrieved evidence — the semantic hit itself carries no tags. Scoped to the vault. */
export function noteTagsByPath(
  db: Database,
  vaultId: string,
  paths: string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (paths.length === 0 || !tableExists(db, "notes")) return out;
  const placeholders = paths.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT path, tags FROM notes WHERE vault_id = ? AND path IN (${placeholders})`)
    .all(vaultId, ...paths) as Array<{ path: string; tags: string }>;
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.tags);
      if (Array.isArray(parsed)) {
        out.set(
          r.path,
          parsed.filter((t): t is string => typeof t === "string"),
        );
      }
    } catch {
      // malformed tags JSON — treat the note as untagged rather than failing the challenge.
    }
  }
  return out;
}

/** Open contradictions whose source or conflict note is in `paths` (THE-309) — gives the judge
 *  cross-note conflict context alongside the evidence. Empty when the plane table is absent. */
export function openContradictionsForPaths(db: Database, paths: string[]): ContradictionContext[] {
  if (paths.length === 0 || !tableExists(db, "contradictions")) return [];
  const placeholders = paths.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, source_path, conflict_path, judge_verdict, judge_rationale FROM contradictions
       WHERE status = 'open' AND (source_path IN (${placeholders}) OR conflict_path IN (${placeholders}))`,
    )
    .all(...paths, ...paths) as Array<{
    id: string;
    source_path: string;
    conflict_path: string;
    judge_verdict: string;
    judge_rationale: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    source_path: r.source_path,
    conflict_path: r.conflict_path,
    judge_verdict: r.judge_verdict,
    judge_rationale: r.judge_rationale ?? "",
  }));
}

export function buildKnowledgeTools(deps: M7Deps): ToolDefinition[] {
  const embedQuery = async (q: string): Promise<number[]> => {
    const [vec] = await deps.embeddingProvider.embed([q], { input: "query" });
    return vec ?? [];
  };
  const embedQuerySparse = (q: string) =>
    resolveQuerySparse(deps.embeddingProvider, q, deps.retrieval?.sparse);
  const embedQueryColbert = (q: string) =>
    resolveQueryColbert(deps.embeddingProvider, q, deps.retrieval?.colbert);

  return [
    defineTool({
      name: "vault_context",
      description:
        "Composite budgeted context in ONE call (the Honcho-style context() primitive): graph-reranked chunks packed to a token budget and grouped by note, recent synthesis patterns touching the query, open contradictions on the packed notes, and applicable past lessons (decision/lesson/postmortem chunks relevant to the query) — with source metadata and packing stats. include_work adds eligible work-memory episodes (the THE-229 reader contract; explicit opt-in, never default). Omit query for session bootstrap: the queued thread is read from the memory folder's _next-session.md signal note, so every session opens with its applicable lessons (push, not pull).",
      inputSchema: z
        .object({
          vault: VaultId,
          query: z.string().min(1).optional(),
          token_budget: z.number().int().positive().max(64000).default(4000),
          k: z.number().int().positive().max(60).default(30),
          include_work: z.boolean().default(false),
          include_lessons: z.boolean().default(true),
        })
        .strict(),
      requiredScopes: ["read:notes"],
      tags: ["knowledge", "search"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        // THE-231 bootstrap mode: with no query, the queued thread comes from the previous
        // session's signal note — the session opens with its own context instead of asking.
        let query = input.query;
        let querySource: "input" | "next_session" = "input";
        let signalPath: string | undefined;
        let signalHash: string | undefined;
        if (query === undefined) {
          const rel = `${deps.memoryFolder?.(v.id) ?? "memory"}/${NEXT_SESSION_NOTE}`;
          const abs = resolveVaultPath(v.root, rel);
          if (!readableRel(ctx.acl, rel) || !existsSync(abs)) {
            throw err.invalidInput("query omitted and no readable next-session signal note", {
              signal: rel,
            });
          }
          const text = readFileSync(abs, "utf8")
            .replace(/^---[\s\S]*?---/, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 600);
          if (!text) throw err.invalidInput("next-session signal note is empty", { signal: rel });
          query = text;
          querySource = "next_session";
          signalPath = rel;
          // THE-136: prewarm-cache hit — the anticipatory prefetch already composed this
          // bundle. The reader enforces the TTL and the signal hash (an edited note misses);
          // an empty marker (the prefetch floor) falls through to a live compose. Cache hits
          // are not retrieval-logged: no live retrieval happened, the prefetch run logged its.
          signalHash = createHash("sha256").update(text).digest("hex");
          if (deps.prewarmDir) {
            // THE-543: the cache key binds the CALLER (acl_fingerprint) and the CONTENT
            // (vault_generation) that produced the bundle — an entry written under a broader
            // ACL, or one whose vault has since mutated, is a miss here, not a match.
            const aclFingerprint = callerAclFingerprint(ctx.acl, ctx.grantedScopes);
            const cached = readPrewarm(prewarmPathFor(deps.prewarmDir, v.id, aclFingerprint), {
              nowMs: (ctx.now ?? Date.now)(),
              signalHash,
              aclFingerprint,
              vaultGeneration: readGeneration(ctx.db, v.id),
            });
            // THE-543 layer 3: re-check every path the bundle references against THIS
            // dispatch's ACL regardless of the key match above. A bundle is a composed whole —
            // if any path in it is now unreadable, the whole entry is a miss, never a partial
            // return, so it falls through to the live compose below.
            if (
              cached &&
              !cached.empty &&
              cached.bundle &&
              prewarmBundlePaths(cached.bundle).every((rel) => readableRel(ctx.acl, rel))
            ) {
              return {
                ...cached.bundle,
                prefetched: true,
                prefetch_generated_at: cached.generated_at,
              };
            }
          }
        }
        // Same front door as vault_graph_search: the class router when enabled, the measured
        // engine otherwise — vault_context adds composition, never a second retrieval path.
        const route = deps.classRouter
          ? routeQuery(ctx.db, v.id, query)
          : { class: "standard" as const, signals: [] as string[] };
        let results: GraphSearchResult[];
        if (route.class === "lexical") {
          results = lexicalRouteResults(ctx.db, v.id, query, input.k, (rel) =>
            readableRel(ctx.acl, rel),
          );
        } else {
          const queryVec = await embedQuery(query);
          const querySparse = await embedQuerySparse(query);
          const queryColbert = await embedQueryColbert(query);
          results = await graphSearch(
            ctx.db,
            buildGraphSearchOptions(deps, {
              route,
              query,
              queryVec,
              querySparse,
              queryColbert,
              vaultId: v.id,
              finalTopK: input.k,
              reranker: deps.reranker,
              isReadable: (rel) => readableRel(ctx.acl, rel),
            }),
          );
        }
        deps.retrievalLog?.({
          queryText: query,
          surfaceType: "vault_context",
          sessionId: ctx.sessionId ?? null,
          hits: results.map((r, i) => ({
            chunkId: r.chunk_id,
            rank: i + 1,
            score: r.rerank_score,
          })),
        });

        // Token costs from the authored store (token_count), length/4 fallback. 15% of the
        // budget is reserved for the synthesis + contradiction legs; chunks pack the rest.
        const tokenByChunk = new Map<string, number>();
        const ids = results.map((r) => r.chunk_id);
        for (let i = 0; i < ids.length; i += 200) {
          const batch = ids.slice(i, i + 200);
          const rows = ctx.db
            .prepare(
              `SELECT id, token_count FROM chunks WHERE id IN (${batch.map(() => "?").join(",")})`,
            )
            .all(...batch) as Array<{ id: string; token_count: number }>;
          for (const r of rows) tokenByChunk.set(r.id, r.token_count);
        }
        const chunkBudget = Math.floor(input.token_budget * 0.85);
        const { packed, tokens: chunkTokens } = packBudget(
          results,
          (r) => tokenByChunk.get(r.chunk_id) ?? Math.ceil((r.content?.length ?? 80) / 4),
          chunkBudget,
        );
        // Group consecutive same-note chunks so the packed block reads coherently.
        const notes: Array<{
          path: string;
          chunks: Array<{
            chunk_id: string;
            content: string | undefined;
            score: number;
            source: string;
            hop: number;
          }>;
        }> = [];
        for (const r of packed) {
          const last = notes[notes.length - 1];
          const entry = {
            chunk_id: r.chunk_id,
            content: r.content,
            score: r.rerank_score,
            source: r.source,
            hop: r.hop,
          };
          if (last && last.path === r.path) last.chunks.push(entry);
          else notes.push({ path: r.path, chunks: [entry] });
        }

        // Open contradictions on the packed notes (reuses the challenge plumbing), capped.
        const contradictions = openContradictionsForPaths(
          ctx.db,
          notes.map((n) => n.path),
        ).slice(0, 5);

        // Recent synthesis patterns touching the query (weekly rows; LIKE over the JSON text
        // on significant query tokens), newest first, capped to 2.
        const sigTokens = (query.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? []).slice(0, 3);
        let syntheses: Array<{
          iso_year: number;
          iso_week: number;
          generated_at: number;
          patterns: unknown;
        }> = [];
        if (sigTokens.length > 0 && tableExists(ctx.db, "syntheses")) {
          const like = sigTokens.map(() => "(patterns LIKE ? OR clusters LIKE ?)").join(" OR ");
          const params = sigTokens.flatMap((t) => [`%${t}%`, `%${t}%`]);
          const rows = ctx.db
            .prepare(
              `SELECT iso_year, iso_week, generated_at, patterns FROM syntheses
               WHERE vault_id = ? AND (${like}) ORDER BY generated_at DESC LIMIT 2`,
            )
            .all(v.id, ...params) as Array<{
            iso_year: number;
            iso_week: number;
            generated_at: number;
            patterns: string;
          }>;
          syntheses = rows.map((r) => {
            let patterns: unknown = r.patterns;
            try {
              patterns = JSON.parse(r.patterns);
            } catch {
              /* raw string fallback */
            }
            return {
              iso_year: r.iso_year,
              iso_week: r.iso_week,
              generated_at: r.generated_at,
              patterns,
            };
          });
        }

        // THE-231 lessons leg: applicable past lessons — decision/lesson/postmortem chunks
        // relevant to the query. Engine-ranked hits first (already relevance-ordered), then a
        // BM25 backfill over lesson-class paths the engine's top-k missed. Composition only:
        // packing and ranking are untouched, so no A/B is owed.
        const lessons: Array<{
          chunk_id: string;
          path: string;
          excerpt: string;
          via: "engine" | "lexical";
        }> = [];
        if (input.include_lessons) {
          const seen = new Set<string>();
          for (const r of results) {
            if (lessons.length >= 5) break;
            if (!LESSON_PATH_RE.test(r.path)) continue;
            seen.add(r.chunk_id);
            lessons.push({
              chunk_id: r.chunk_id,
              path: r.path,
              excerpt: (r.content ?? "").slice(0, 240),
              via: "engine",
            });
          }
          if (lessons.length < 5) {
            for (const h of bm25Chunks(ctx.db, v.id, query, 40)) {
              if (lessons.length >= 5) break;
              if (seen.has(h.chunk_id) || !LESSON_PATH_RE.test(h.path)) continue;
              if (!readableRel(ctx.acl, h.path)) continue;
              seen.add(h.chunk_id);
              lessons.push({
                chunk_id: h.chunk_id,
                path: h.path,
                excerpt: h.content.slice(0, 240),
                via: "lexical",
              });
            }
          }
        }

        // Optional work-memory leg — the THE-229 reader contract verbatim (eligible-only,
        // no tombstoned/expired, caller partition), explicit opt-in per the ticket.
        let episodes:
          | Array<{
              id: string;
              ts: number;
              tool: string | null;
              status: string;
              summary: string | null;
            }>
          | { work_unavailable: true }
          | undefined;
        if (input.include_work) {
          if (!deps.edb) {
            episodes = { work_unavailable: true };
          } else {
            episodes = deps.edb
              .prepare(
                `SELECT id, ts, tool, status, summary FROM agent_episodes
                 WHERE blocked = 0 AND eligibility = 'eligible'
                   AND (valid_until IS NULL OR valid_until > ?)
                   AND (trust IS NULL OR trust >= 0.3)
                   AND caller IS ?
                 ORDER BY ts DESC LIMIT 5`,
              )
              .all(Date.now(), ctx.caller ?? null) as Array<{
              id: string;
              ts: number;
              tool: string | null;
              status: string;
              summary: string | null;
            }>;
          }
        }

        const response = {
          vault: v.id,
          route: route.signals,
          query_source: querySource,
          ...(signalPath !== undefined ? { signal: signalPath } : {}),
          ...(signalHash !== undefined ? { signal_hash: signalHash } : {}),
          budget: {
            requested: input.token_budget,
            chunk_budget: chunkBudget,
            packed_tokens: chunkTokens,
          },
          stats: {
            chunks_considered: results.length,
            chunks_packed: packed.length,
            notes: notes.length,
            contradictions: contradictions.length,
            syntheses: syntheses.length,
            lessons: lessons.length,
          },
          notes,
          syntheses,
          contradictions,
          lessons,
          ...(episodes !== undefined ? { episodes } : {}),
        };
        // THE-136 write-through: a live bootstrap compose refreshes the prewarm cache so the
        // next bootstrap within the TTL is a hit even without a scheduled prefetch run.
        // Best-effort; atomic (tmp + rename) so no reader catches a torn file.
        if (querySource === "next_session" && deps.prewarmDir && signalHash !== undefined) {
          try {
            const now = (ctx.now ?? Date.now)();
            // THE-543: record the fingerprint of the ACL that actually produced `response`
            // (results were already filtered through readableRel(ctx.acl, ...) above) and the
            // vault generation at this instant, so a later reader under a different or wider
            // ACL, or after content moved, misses instead of inheriting this caller's view.
            writePrewarm(
              prewarmPathFor(
                deps.prewarmDir,
                v.id,
                callerAclFingerprint(ctx.acl, ctx.grantedScopes),
              ),
              {
                generated_at: now,
                expires_at: now + DEFAULT_PREFETCH_TTL_MS,
                signal: signalPath ?? "",
                signal_hash: signalHash,
                empty: packed.length === 0,
                acl_fingerprint: callerAclFingerprint(ctx.acl, ctx.grantedScopes),
                vault_generation: readGeneration(ctx.db, v.id),
                ...(packed.length === 0 ? {} : { bundle: response }),
              },
            );
          } catch {
            /* the cache is an optimization; the response is already composed */
          }
        }
        return response;
      },
    }),

    defineTool({
      name: "reflect",
      description:
        "The reflect verb (retain/recall/reflect): recall over the vault, then a gateway synthesis pass — one on-demand, query-scoped operation returning a grounded answer with source provenance. mode 'challenge' runs the adversarial red-team over the decision-bearing recall instead (the knowledge_challenge core). persist: true writes the answer as a derived note under the memory folder's reflections/ with source_model + chunk provenance (requires write:notes). Degrades gracefully: without the inference gateway, recall still returns sources with available: false. The sleep-time half (episode-eligibility evaluator + preference profile) runs via the `obsidian-tc reflect` CLI command.",
      inputSchema: z
        .object({
          vault: VaultId,
          query: z.string().min(3).max(4000),
          mode: z.enum(["synthesis", "challenge"]).default("synthesis"),
          k: z.number().int().positive().max(60).default(20),
          scope: z.string().min(1).optional(),
          persist: z.boolean().default(false),
        })
        .strict(),
      requiredScopes: ["read:notes"],
      tags: ["knowledge"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        // Same front door as every knowledge surface: the class router when enabled, the
        // measured engine otherwise. reflect composes recall + a generative pass — it never
        // adds a retrieval mechanism.
        const route = deps.classRouter
          ? routeQuery(ctx.db, v.id, input.query)
          : { class: "standard" as const, signals: [] as string[] };
        let results: GraphSearchResult[];
        if (route.class === "lexical") {
          results = lexicalRouteResults(ctx.db, v.id, input.query, input.k, (rel) =>
            readableRel(ctx.acl, rel),
          );
        } else {
          const queryVec = await embedQuery(input.query);
          const querySparse = await embedQuerySparse(input.query);
          const queryColbert = await embedQueryColbert(input.query);
          results = await graphSearch(
            ctx.db,
            buildGraphSearchOptions(deps, {
              route,
              query: input.query,
              queryVec,
              querySparse,
              queryColbert,
              vaultId: v.id,
              finalTopK: input.k,
              reranker: deps.reranker,
              isReadable: (rel) => readableRel(ctx.acl, rel),
            }),
          );
        }
        if (input.scope !== undefined) {
          const scope = input.scope;
          results = results.filter((r) => r.path.startsWith(scope));
        }
        deps.retrievalLog?.({
          queryText: input.query,
          surfaceType: "reflect",
          sessionId: ctx.sessionId ?? null,
          hits: results.map((r, i) => ({
            chunkId: r.chunk_id,
            rank: i + 1,
            score: r.rerank_score,
          })),
        });
        const sources = results.map((r) => ({
          chunk_id: r.chunk_id,
          path: r.path,
          score: r.rerank_score,
        }));
        if (!deps.roles) {
          return {
            vault: v.id,
            mode: input.mode,
            route: route.signals,
            available: false,
            message: "inference gateway not configured (set OBSIDIAN_TC_GATEWAY_URL)",
            answer: null,
            sources,
          };
        }
        if (input.mode === "challenge") {
          const paths = [...new Set(results.map((r) => r.path))];
          const tags = noteTagsByPath(ctx.db, v.id, paths);
          const evidence: EvidenceChunk[] = results
            .filter((r) => isDecisionChunk({ path: r.path, tags: tags.get(r.path) ?? null }))
            .slice(0, CHALLENGE_RECALL)
            .map((r) => ({
              path: r.path,
              tags: tags.get(r.path) ?? null,
              content: r.content ?? "",
            }));
          const contradictions = openContradictionsForPaths(ctx.db, paths);
          const { output, model } = await challengeProposal(
            deps.roles,
            input.query,
            evidence,
            contradictions,
          );
          return {
            vault: v.id,
            mode: "challenge",
            route: route.signals,
            available: true,
            model,
            challenge: output,
            sources,
          };
        }
        const evidenceBlock = results
          .slice(0, 20)
          .map((r, i) => `[${i + 1}] ${r.path}\n${(r.content ?? "").slice(0, 800)}`)
          .join("\n\n");
        const res = await deps.roles.synthesize(
          prompt(
            REFLECT_SYSTEM_PROMPT,
            `Question:\n${input.query}\n\nEvidence chunks:\n${evidenceBlock}`,
          ),
        );
        // Traceable derived memory (the Hindsight "update in a traceable way" requirement):
        // provenance frontmatter carries the model + the exact source chunk ids and paths.
        let persisted: { path: string } | undefined;
        if (input.persist) {
          // Wildcard-aware, matching the dispatch path (registry.ts grantsAll): a caller holding
          // `*` or `write:*` satisfies write:notes. A raw Set `.has("write:notes")` rejected them
          // even though every other write tool accepts them (audit THE-562 / P1.6).
          if (!grantsAll(ctx.grantedScopes ?? [], ["write:notes"]))
            throw err.forbidden("reflect persist requires write:notes");
          const folder = deps.memoryFolder?.(v.id) ?? "memory";
          const slug =
            input.query
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 48) || "reflection";
          const nowMs = (ctx.now ?? Date.now)();
          const rel = `${folder}/reflections/${new Date(nowMs).toISOString().slice(0, 10)}-${slug}.md`;
          enforcePathAcl(ctx.acl, "write", rel, v.root);
          const abs = resolveVaultPath(v.root, rel);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(
            abs,
            [
              "---",
              `generated_at: ${new Date(nowMs).toISOString()}`,
              `source_model: ${res.model}`,
              `query: ${JSON.stringify(input.query)}`,
              `source_chunks: ${JSON.stringify(results.slice(0, 20).map((r) => r.chunk_id))}`,
              `source_paths: ${JSON.stringify([...new Set(results.slice(0, 20).map((r) => r.path))])}`,
              "---",
              "",
              res.text,
              "",
            ].join("\n"),
          );
          persisted = { path: rel };
        }
        return {
          vault: v.id,
          mode: "synthesis",
          route: route.signals,
          available: true,
          answer: res.text,
          model: res.model,
          sources,
          ...(persisted ? { persisted } : {}),
        };
      },
    }),

    defineTool({
      name: "vault_graph_search",
      description:
        "Cross-domain / multi-hop semantic search with wikilink graph expansion (GraphRAG). Seeds by vector similarity, expands through the links_to graph (vault_edges), and fuses by RRF. Run index_vault first so the edge graph is populated. Returns chunks tagged seed|expansion with hop + via_edge.",
      inputSchema: z
        .object({
          vault: VaultId,
          query: z.string().min(1),
          // THE-451: agent-supplied HyDE (Gao 2023). MCP-native — the CLIENT writes the
          // hypothetical answer; there is no server-side LLM generating it here. When present,
          // it replaces the query as the DENSE-arm seed only (see below); sparse/ColBERT keep
          // the raw query untouched. No min() bound: an empty/whitespace-only value must be a
          // silent no-op (not a validation error), so length-gating happens in the handler.
          // Measurement-fragile per the ticket: HyDE helps under-specified/zero-shot queries and
          // can HURT a strong encoder on well-specified queries (our nomic-768 + golden set is
          // squarely the latter). This is an opt-in lever for the CALLER to reach for on vague
          // queries — never make it the default path.
          hypothetical_answer: z.string().max(4000).optional().nullable(),
          final_top_k: z.number().int().positive().max(100).default(30),
        })
        .strict(),
      requiredScopes: ["read:notes"],
      tags: ["knowledge", "search"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        // THE-451: trim-and-check so null/absent/blank are all byte-identical to no HyDE.
        const hyde = input.hypothetical_answer?.trim();
        const hydeActive = !!hyde;
        // THE-258: class router (dark unless retrieval.classRouter). The lexical class
        // short-circuits BEFORE the embedding round-trip — the router's cost win; temporal
        // auto-enables the THE-221 stream; standard falls through unchanged.
        const route = deps.classRouter
          ? routeQuery(ctx.db, v.id, input.query)
          : { class: "standard" as const, signals: [] as string[] };
        if (route.class === "lexical") {
          const results = lexicalRouteResults(ctx.db, v.id, input.query, input.final_top_k, (rel) =>
            readableRel(ctx.acl, rel),
          );
          deps.retrievalLog?.({
            queryText: input.query,
            surfaceType: "vault_graph_search",
            sessionId: ctx.sessionId ?? null,
            hits: results.map((r, i) => ({
              chunkId: r.chunk_id,
              rank: i + 1,
              score: r.rerank_score,
            })),
          });
          return {
            vault: v.id,
            mode_used: "lexical-route",
            route: route.signals,
            ...(hydeActive ? { query: input.query, hyde: true } : {}),
            results,
          };
        }
        // THE-451: the dense arm embeds the hypothetical answer when supplied; sparse/ColBERT
        // ALWAYS embed the raw query — HyDE seeds the dense vector only, it must never
        // contaminate lexical or late-interaction matching.
        const queryVec = await embedQuery(hydeActive ? (hyde as string) : input.query);
        const querySparse = await embedQuerySparse(input.query);
        const queryColbert = await embedQueryColbert(input.query);
        const results = await graphSearch(
          ctx.db,
          buildGraphSearchOptions(deps, {
            route,
            query: input.query,
            // THE-451: `queryVec` may be the HyDE-seeded vector; the raw query still rides
            // `query` for the lexical arms. The builder threads whatever it is given.
            queryVec,
            querySparse,
            queryColbert,
            vaultId: v.id,
            finalTopK: input.final_top_k,
            reranker: deps.reranker,
            isReadable: (rel) => readableRel(ctx.acl, rel),
          }),
        );
        // THE-230: serve-path retrieval telemetry (best-effort; the logger never throws).
        deps.retrievalLog?.({
          queryText: input.query,
          surfaceType: "vault_graph_search",
          sessionId: ctx.sessionId ?? null,
          hits: results.map((r, i) => ({
            chunkId: r.chunk_id,
            rank: i + 1,
            score: r.rerank_score,
          })),
        });
        return {
          vault: v.id,
          mode_used: "graph",
          // THE-451: echo `query` (audit — what the caller actually asked) and mark hyde:true
          // only when it fired; absent otherwise so existing callers see no new field.
          ...(hydeActive ? { query: input.query, hyde: true } : {}),
          results,
        };
      },
    }),

    defineTool({
      name: "knowledge_search",
      description:
        "Semantic + keyword search over a vendor / external-docs corpus (a reserved read-only docs vault), with wikilink graph expansion and RRF fusion. The docs-scoped analogue of vault_graph_search: bind `vault` to the docs corpus id. Returns source-attributed chunks tagged seed|expansion. Gated on read:docs so it stays isolated from the private vault.",
      inputSchema: z
        .object({
          vault: VaultId,
          query: z.string().min(1),
          final_top_k: z.number().int().positive().max(100).default(20),
        })
        .strict(),
      requiredScopes: ["read:docs"],
      tags: ["docs", "search", "knowledge"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const route = deps.classRouter
          ? routeQuery(ctx.db, v.id, input.query)
          : { class: "standard" as const, signals: [] as string[] };
        if (route.class === "lexical") {
          const results = lexicalRouteResults(ctx.db, v.id, input.query, input.final_top_k, (rel) =>
            readableRel(ctx.acl, rel),
          );
          deps.retrievalLog?.({
            queryText: input.query,
            surfaceType: "knowledge_search",
            sessionId: ctx.sessionId ?? null,
            hits: results.map((r, i) => ({
              chunkId: r.chunk_id,
              rank: i + 1,
              score: r.rerank_score,
            })),
          });
          return { vault: v.id, mode_used: "lexical-route", route: route.signals, results };
        }
        const queryVec = await embedQuery(input.query);
        const querySparse = await embedQuerySparse(input.query);
        const queryColbert = await embedQueryColbert(input.query);
        const results = await graphSearch(
          ctx.db,
          buildGraphSearchOptions(deps, {
            route,
            query: input.query,
            queryVec,
            querySparse,
            queryColbert,
            vaultId: v.id,
            finalTopK: input.final_top_k,
            // THE-441: reranking lost decisively to the champion on this stack; the docs corpus
            // never reranks, independent of any server-side reranker config. Passed explicitly so
            // this stays a visible decision rather than looking like a dropped option.
            reranker: null,
            isReadable: (rel) => readableRel(ctx.acl, rel),
          }),
        );
        deps.retrievalLog?.({
          queryText: input.query,
          surfaceType: "knowledge_search",
          sessionId: ctx.sessionId ?? null,
          hits: results.map((r, i) => ({
            chunkId: r.chunk_id,
            rank: i + 1,
            score: r.rerank_score,
          })),
        });
        return { vault: v.id, mode_used: "graph", results };
      },
    }),

    defineTool({
      name: "knowledge_get_critical",
      description:
        "List the critical-severity docs in a vendor / external-docs corpus: the breaking changes, security issues, and production gotchas to read before starting work. A tight metadata pre-filter over frontmatter severity == 'critical', not a search. Optionally narrow by `source` (the vendor or tool the doc is about). Gated on read:docs so it stays isolated from the private vault.",
      inputSchema: z
        .object({
          vault: VaultId,
          source: z.string().min(1).optional(),
          limit: z.number().int().positive().max(200).default(100),
        })
        .strict(),
      requiredScopes: ["read:docs"],
      tags: ["docs", "knowledge"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rows = ctx.db
          .prepare(
            "SELECT path, title, frontmatter FROM notes WHERE vault_id = ? AND json_extract(frontmatter, '$.severity') = 'critical' ORDER BY path",
          )
          .all(v.id) as Array<{ path: string; title: string; frontmatter: string | null }>;
        const items = rows
          .filter((r) => readableRel(ctx.acl, r.path))
          .map((r) => {
            let fm: Record<string, unknown> = {};
            if (r.frontmatter) {
              try {
                fm = JSON.parse(r.frontmatter) as Record<string, unknown>;
              } catch {
                fm = {};
              }
            }
            return {
              path: r.path,
              title: r.title,
              category: typeof fm.category === "string" ? fm.category : null,
              source: typeof fm.source === "string" ? fm.source : null,
              severity: "critical" as const,
            };
          })
          .filter((it) => input.source === undefined || it.source === input.source)
          .sort(
            (a, b) =>
              (a.source ?? "").localeCompare(b.source ?? "") ||
              (a.category ?? "").localeCompare(b.category ?? "") ||
              a.path.localeCompare(b.path),
          )
          .slice(0, input.limit);
        return { vault: v.id, count: items.length, items };
      },
    }),

    defineTool({
      name: "knowledge_challenge",
      description:
        "Red-team a proposal against your documented decision history. Retrieves decision-bearing chunks (02-projects, 04-writing/Published, 09-reference/system-reviews, 09-reference/syntheses) and asks the inference gateway to flag DIRECT_CONTRADICTION / PATTERN_REPEAT / REVERSAL / HIDDEN_DEPENDENCY. Requires the gateway; reports unavailable when it is not configured.",
      inputSchema: z
        .object({
          vault: VaultId,
          proposal: z.string().min(10).max(4000),
        })
        .strict(),
      requiredScopes: ["read:notes"],
      tags: ["knowledge"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        if (!deps.roles) {
          return {
            vault: v.id,
            available: false,
            message: "inference gateway not configured (set OBSIDIAN_TC_GATEWAY_URL)",
          };
        }
        const queryVec = await embedQuery(input.proposal);
        const hits = semanticSearch(ctx.db, v.id, queryVec, {
          k: CHALLENGE_RECALL,
          returnContent: true,
          isReadable: (rel) => readableRel(ctx.acl, rel),
          model: deps.embeddingProvider.id, // THE-530: constrain to the active model
        });
        // THE-230: challenge recall is a real retrieval surface — log it like the search tools.
        deps.retrievalLog?.({
          queryText: input.proposal,
          surfaceType: "knowledge_challenge",
          sessionId: ctx.sessionId ?? null,
          hits: hits.map((h, i) => ({ chunkId: h.chunk_id, rank: i + 1, score: h.score })),
        });
        // Enrich with note-level tags so isDecisionChunk's tag rule fires (not just the path
        // prefix) and the judge sees the tags; the semantic hit itself carries no tags (THE-309).
        const tagsByPath = noteTagsByPath(ctx.db, v.id, [...new Set(hits.map((h) => h.path))]);
        const evidence = hits
          .map((h) => ({
            path: h.path,
            content: h.content ?? "",
            tags: tagsByPath.get(h.path) ?? [],
          }))
          .filter((e) => isDecisionChunk({ path: e.path, tags: e.tags }));
        if (evidence.length === 0) {
          return {
            vault: v.id,
            available: true,
            evidence_count: 0,
            output: null,
            message: "no decision-bearing chunks matched this proposal",
          };
        }
        // Open contradictions touching the evidence give the judge cross-note conflict context.
        const contradictions = openContradictionsForPaths(
          ctx.db,
          evidence.map((e) => e.path),
        );
        const { output, model } = await challengeProposal(
          deps.roles,
          input.proposal,
          evidence,
          contradictions,
        );
        return {
          vault: v.id,
          available: true,
          evidence_count: evidence.length,
          contradiction_count: contradictions.length,
          output,
          model,
        };
      },
    }),

    // THE-491: contradiction detection is fully wired and writes the `contradictions` table, but
    // results only ever surfaced indirectly — folded inside vault_context / reflect /
    // knowledge_challenge via openContradictionsForPaths above. This is the direct reader: same
    // plumbing, no composition, so an agent (or a human) can inspect flagged conflicts on a note
    // set standalone rather than paying for a full context/challenge call to see them.
    defineTool({
      name: "list_contradictions",
      description:
        "List open contradictions (judge_verdict: 'contradiction' | 'tension') touching any of the given notes — the same detector output vault_context/reflect/knowledge_challenge surface indirectly, exposed directly for standalone inspection. Read-only.",
      inputSchema: z.object({ vault: VaultId, paths: z.array(VaultPath).min(1).max(200) }).strict(),
      requiredScopes: ["read:notes"],
      tags: ["knowledge"],
      pathAcl: (input) => input.paths.map((p) => ({ op: "read" as const, path: p })),
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const paths = input.paths.map((p) => normalizeVaultPath(p));
        for (const p of paths) enforcePathAcl(ctx.acl, "read", p, v.root);
        if (!tableExists(ctx.db, "contradictions")) {
          return {
            vault: v.id,
            available: false,
            message: "contradictions table not present (pre-migration cache.db)",
            total: 0,
            contradictions: [],
          };
        }
        const contradictions = openContradictionsForPaths(ctx.db, paths);
        return {
          vault: v.id,
          available: true,
          total: contradictions.length,
          contradictions,
        };
      },
    }),
  ];
}
