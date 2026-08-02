// WP2.2: the `vault_context` tool factory, extracted verbatim out of buildKnowledgeTools (the
// largest of the 7 M7 tools). Takes the shared retrieval runtime constructed once in
// buildKnowledgeTools rather than building its own embedder, cache, or policy state — see
// RetrievalRuntime's doc comment in retrieval-runtime.ts.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { tableExists } from "../../../db/introspect";
import type { ToolDefinition } from "../../../mcp/registry";
import { bm25Chunks } from "../../../search/chunk_fts";
import { readGeneration } from "../../../search/generation";
import type { GraphSearchResult } from "../../../search/graph_search";
import {
  callerAclFingerprint,
  DEFAULT_PREFETCH_TTL_MS,
  prewarmPathFor,
  readPrewarm,
  writePrewarm,
} from "../../../search/prefetch";
import { cachedGraphSearch } from "../../../search/query_cache";
import { lexicalRouteResults, routeQuery } from "../../../search/router";
import { readableRel, readEnumerationUnrestricted } from "../../../vault/acl-read-filter";
import { resolveVaultPath } from "../../../vault/paths";
import { defineTool } from "../../m1/define";
import type { M7Deps } from "./deps";
import {
  buildGraphSearchOptions,
  cacheContextFor,
  capturePolicy,
  LESSON_PATH_RE,
  NEXT_SESSION_NOTE,
  openContradictionsForPaths,
  packBudget,
  prewarmBundlePaths,
  type RetrievalRuntime,
  retrievalHits,
} from "./retrieval-runtime";
import { VaultContextOutput } from "./schemas";

export function createVaultContextTool(deps: M7Deps, retrieval: RetrievalRuntime): ToolDefinition {
  return defineTool({
    name: "vault_context",
    domain: "knowledge",
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
    outputSchema: VaultContextOutput,
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
          // THE-417: layer 4 — the bundle's SHAPE. `PrewarmEntry.bundle` is
          // `Record<string, unknown>` read from disk, so nothing here has ever guaranteed a
          // cached entry matches what this tool returns today. A bundle written by an older
          // build with a different response shape would have been served verbatim. Now that the
          // shape is declared, validate it and treat a mismatch as a MISS — the same discipline
          // as the ACL and generation layers above, and the same rule the comment there states:
          // a bundle is a composed whole, so a partial or stale-shaped one falls through to a
          // live compose rather than being returned in part.
          const shaped =
            cached?.empty === false && cached.bundle
              ? VaultContextOutput.safeParse(cached.bundle)
              : null;
          if (
            cached?.bundle &&
            shaped?.success &&
            prewarmBundlePaths(cached.bundle).every((rel) => readableRel(ctx.acl, rel))
          ) {
            return {
              ...shaped.data,
              prefetched: true as const,
              prefetch_generated_at: cached.generated_at,
            };
          }
        }
      }
      // Same front door as vault_graph_search: the class router when enabled, the measured
      // engine otherwise — vault_context adds composition, never a second retrieval path.
      const route = deps.classRouter
        ? routeQuery(ctx.db, v.id, query, {
            isReadable: (p) => readableRel(ctx.acl, p),
            // THE-694: the rare-term probe is only issued for callers who can read everything.
            readUnrestricted: readEnumerationUnrestricted(ctx.acl),
          })
        : { class: "standard" as const, signals: [] as string[] };
      const policy = capturePolicy(deps, v.id, route.class);
      let results: GraphSearchResult[];
      if (route.class === "lexical") {
        results = lexicalRouteResults(ctx.db, v.id, query, input.k, (rel) =>
          readableRel(ctx.acl, rel),
        );
      } else {
        results = await cachedGraphSearch(
          ctx.db,
          buildGraphSearchOptions(deps, {
            route,
            query,
            vaultId: v.id,
            finalTopK: input.k,
            reranker: deps.reranker,
            isReadable: (rel) => readableRel(ctx.acl, rel),
            onFusionWeights: policy.sink,
          }),
          () => retrieval.embedAll(query, query),
          cacheContextFor(deps, ctx, v.id, query),
        );
      }
      deps.retrievalLog?.({
        queryText: query,
        surfaceType: "vault_context",
        sessionId: ctx.sessionId ?? null,
        caller: ctx.caller ?? null,
        hits: retrievalHits(results),
        policy: policy.record(route.class === "lexical" ? "lexical-route" : "static"),
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
        v.id,
        notes.map((n) => n.path),
        (rel) => readableRel(ctx.acl, rel),
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
          // THE-632: ACL in, so unreadable chunks cannot consume slots of the 40 before the
          // lesson-path filter runs. The readableRel check below stays as defense-in-depth.
          for (const h of bm25Chunks(ctx.db, v.id, query, 40, (p) => readableRel(ctx.acl, p))) {
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
            prewarmPathFor(deps.prewarmDir, v.id, callerAclFingerprint(ctx.acl, ctx.grantedScopes)),
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
  });
}
