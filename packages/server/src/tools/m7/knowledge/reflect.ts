// WP2.2: the `reflect` tool factory, extracted verbatim out of buildKnowledgeTools. Takes the
// shared retrieval runtime constructed once in buildKnowledgeTools rather than building its own
// embedder, cache, or policy state — see RetrievalRuntime's doc comment in retrieval-runtime.ts.
// `persistGovernedNote` stays inside this handler, inside the governed-write boundary: it must
// never be lifted out to run unconditionally or outside the write:notes scope check below.
import { err, grantsAll, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import { challengeProposal } from "../../../plane/challenge";
import { isExcludedPath } from "../../../plane/egress-filter";
import { prompt } from "../../../plane/gateway";
import { buildEvidence, type EvidenceItem } from "../../../search/evidence";
import type { GraphSearchResult } from "../../../search/graph_search";
import { vaultExclusionFor, withVaultExclusion } from "../../../search/index-exclusion";
import { cachedGraphSearch } from "../../../search/query_cache";
import { lexicalRouteResults, routeQuery } from "../../../search/router";
import { enforcePathAcl } from "../../../vault/acl-path";
import { readableRel, readEnumerationUnrestricted } from "../../../vault/acl-read-filter";
import { persistGovernedNote } from "../../../vault/persist-note";
import { readableStoredRow } from "../../../vault/stored-acl-path";
import { defineTool } from "../../m1/define";
import type { M7Deps } from "./deps";
import {
  buildGraphSearchOptions,
  CHALLENGE_EXPANDED_RECALL,
  CHALLENGE_RECALL,
  cacheContextFor,
  capturePolicy,
  noteTagsByPath,
  openContradictionsForPaths,
  type ReflectCitationStyle,
  type ReflectDetail,
  type RetrievalRuntime,
  reflectSystemPrompt,
  renderWikilinkCitations,
  resolveAclWalkFilter,
  retrievalHits,
  SYNTHESIS_EVIDENCE_BUDGET,
  selectChallengeEvidence,
  shouldExpandChallengeRecall,
  withCitationCheck,
  withEgressCoverage,
} from "./retrieval-runtime";
import { ReflectOutput } from "./schemas";

export function createReflectTool(deps: M7Deps, retrieval: RetrievalRuntime): ToolDefinition {
  return defineTool({
    name: "reflect",
    domain: "knowledge",
    description:
      "The reflect verb (retain/recall/reflect): recall over the vault, then a gateway synthesis pass — one on-demand, query-scoped operation returning a grounded answer with source provenance. mode 'challenge' runs the adversarial red-team over the decision-bearing recall instead (the knowledge_challenge core) and returns a coverage object (recalled, decision_matched, filtered_out, kept, dropped, unresolved_evidence_paths). persist: true writes the answer as a derived note under the memory folder's reflections/ with source_model + chunk provenance (requires write:notes); it applies to mode 'synthesis' only and is rejected with mode 'challenge'. Degrades gracefully: without the inference gateway, recall still returns sources with available: false. The sleep-time half (episode-eligibility evaluator + preference profile) runs via the `obsidian-tc reflect` CLI command.",
    inputSchema: z
      .object({
        vault: VaultId,
        query: z.string().min(3).max(4000),
        mode: z.enum(["synthesis", "challenge"]).default("synthesis"),
        k: z.number().int().positive().max(60).default(20),
        scope: z.string().min(1).optional(),
        persist: z.boolean().default(false),
        // No schema default on these two: precedence is call argument > the vault's `reflect`
        // config > the shipped default (numeric / concise), and a zod default would make an
        // omitted argument indistinguishable from an explicit one.
        citation_style: z
          .enum(["numeric", "wikilink"])
          .optional()
          .describe(
            'How citations read in the answer and any persisted note. "numeric" (default) keeps the [n] markers; "wikilink" renders each [n] as [[path]] from the evidence it numbers, deterministically. An [n] with no matching evidence is left as written and listed in `unresolved_citations`. Omitted: the vault\'s `reflect.citationStyle`, else numeric.',
          ),
        detail: z
          .enum(["concise", "standard", "thorough"])
          .optional()
          .describe(
            'How much the synthesis says. "concise" (default), "standard", or "thorough"; a prompt instruction only, the evidence set is unchanged. Omitted: the vault\'s `reflect.detail`, else concise.',
          ),
      })
      .strict(),
    outputSchema: ReflectOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "external-network"],
    handler: async (input, ctx) => {
      // Persist is written only by the synthesis branch. Rejecting the combination here, before any
      // recall, is what stops it being silently ignored.
      if (input.mode === "challenge" && input.persist) {
        throw err.validation(
          "persist is not supported with mode 'challenge'; use mode 'synthesis'",
        );
      }
      const v = deps.vaultRegistry.resolve(input.vault);
      const exclusion = vaultExclusionFor(deps.vaultRegistry, v.id);
      const isReadable = withVaultExclusion(
        readableStoredRow(ctx.db, v.id, (a) => readableRel(ctx.acl, a, ctx.grantedScopes)),
        exclusion,
      );
      // Same front door as every knowledge surface: the class router when enabled, the
      // measured engine otherwise. reflect composes recall + a generative pass — it never
      // adds a retrieval mechanism.
      const route = deps.classRouter
        ? routeQuery(ctx.db, v.id, input.query, {
            isReadable,
            // THE-694: the rare-term probe is only issued for callers who can read everything.
            readUnrestricted: readEnumerationUnrestricted(ctx.acl, ctx.grantedScopes),
          })
        : { class: "standard" as const, signals: [] as string[] };
      const policy = capturePolicy(v.id, route.class);
      // `fetched` is the index's page size BEFORE the scope filter: whether a page came back full
      // is a fact about the index, not about the caller's scope.
      const recall = async (
        k: number,
      ): Promise<{ results: GraphSearchResult[]; fetched: number }> => {
        let recalled: GraphSearchResult[];
        if (route.class === "lexical") {
          const walkFilter = resolveAclWalkFilter(
            ctx.db,
            v.id,
            ctx.acl,
            ctx.grantedScopes,
            isReadable,
            exclusion.digest,
          );
          recalled = lexicalRouteResults(
            ctx.db,
            v.id,
            input.query,
            k,
            isReadable,
            walkFilter.aclSetId,
            walkFilter.aclWalkFilter?.blocked,
          );
        } else {
          recalled = await cachedGraphSearch(
            ctx.db,
            buildGraphSearchOptions(deps, {
              route,
              query: input.query,
              vaultId: v.id,
              finalTopK: k,
              // The seed streams default to 30, so a deeper challenge page needs them widened too.
              ...(input.mode === "challenge" && k > CHALLENGE_RECALL ? { seedCount: k } : {}),
              reranker: deps.reranker,
              isReadable,
              db: ctx.db,
              acl: ctx.acl,
              grantedScopes: ctx.grantedScopes,
              onFusionWeights: policy.sink,
            }),
            () => retrieval.embedAll(input.query, input.query),
            cacheContextFor(deps, ctx, v.id, input.query),
          );
        }
        return {
          results:
            input.scope === undefined
              ? recalled
              : recalled.filter((r) => r.path.startsWith(input.scope as string)),
          fetched: recalled.length,
        };
      };
      // Challenge recall only runs when the gateway exists: without it the handler returns early
      // below and no challenge can run, so a deeper page would be pure cost.
      const challenging = input.mode === "challenge" && Boolean(deps.roles);
      let page = await recall(challenging ? Math.max(CHALLENGE_RECALL, input.k) : input.k);
      let results = page.results;
      let challengeSelection: ReturnType<typeof selectChallengeEvidence> | undefined;
      if (challenging) {
        const select = (pool: GraphSearchResult[]) => {
          const tags = noteTagsByPath(ctx.db, v.id, [...new Set(pool.map((r) => r.path))]);
          return selectChallengeEvidence(
            pool.map((r) => ({
              path: r.path,
              chunkId: r.chunk_id,
              tags: tags.get(r.path) ?? null,
              content: r.content ?? "",
            })),
            deps.excludeFilter,
          );
        };
        challengeSelection = select(results);
        if (shouldExpandChallengeRecall(page.fetched, challengeSelection.coverage)) {
          page = await recall(CHALLENGE_EXPANDED_RECALL);
          results = page.results;
          challengeSelection = select(results);
        }
      }
      // The judge is shown exactly the evidence the selector kept: egress exclusion ran before the
      // cap (selectChallengeEvidence), so nothing withheld is in it. That evidence is returned and
      // logged alongside the top-k hits, and it is settled BEFORE the judge runs, so a judge call
      // that throws still leaves the retrieval logged and the log never credits a chunk the judge
      // was not shown.
      const judgedEvidence = challengeSelection && deps.roles ? challengeSelection.evidence : [];
      // Every top-k hit is returned and logged, egress-excluded ones included. `sources` and the
      // retrieval log carry ids, paths and scores, never content, so they are not egress: only the
      // text is withheld from a model (synthesis and challenge filter their evidence below).
      const returnedResults = results.slice(0, input.k);
      const excludeFilter = deps.excludeFilter;
      // excluded_count has one meaning in every arm: the returned top-k sources whose content was
      // withheld from the model by egress exclusion. Degraded mode makes no model call, so there it
      // counts the hits that would have been withheld.
      const excludedCount = returnedResults.filter(
        (result) => excludeFilter !== undefined && isExcludedPath(excludeFilter, result.path),
      ).length;
      const excludedField = excludedCount > 0 ? { excluded_count: excludedCount } : {};
      if (judgedEvidence.length > 0) {
        const returnedIds = new Set(returnedResults.map((result) => result.chunk_id));
        const resultById = new Map(results.map((result) => [result.chunk_id, result]));
        for (const item of judgedEvidence) {
          if (item.chunkId === undefined || returnedIds.has(item.chunkId)) continue;
          const result = resultById.get(item.chunkId);
          if (result === undefined) continue;
          returnedResults.push(result);
          returnedIds.add(item.chunkId);
        }
      }
      deps.retrievalLog?.({
        queryText: input.query,
        surfaceType: "reflect",
        sessionId: ctx.sessionId ?? null,
        caller: ctx.caller ?? null,
        hits: retrievalHits(returnedResults),
        policy: policy.record(route.class === "lexical" ? "lexical-route" : "static"),
      });
      const sources = returnedResults.map((r) => ({
        chunk_id: r.chunk_id,
        path: r.path,
        score: r.rerank_score,
      }));
      let challenged: Awaited<ReturnType<typeof challengeProposal<EvidenceItem>>> | undefined;
      if (challengeSelection && judgedEvidence.length > 0 && deps.roles) {
        const contradictions = openContradictionsForPaths(
          ctx.db,
          v.id,
          [...new Set(judgedEvidence.map((e) => e.path))],
          (rel) => isReadable(rel),
        );
        challenged = await challengeProposal(
          deps.roles,
          input.query,
          judgedEvidence,
          contradictions,
          deps.excludeFilter,
        );
      }
      if (!deps.roles) {
        return {
          vault: v.id,
          mode: input.mode,
          route: route.signals,
          available: false,
          message: "inference gateway not configured (set OBSIDIAN_TC_GATEWAY_URL)",
          answer: null,
          sources,
          ...excludedField,
        };
      }
      if (input.mode === "challenge") {
        const { evidence, coverage } = challengeSelection as ReturnType<
          typeof selectChallengeEvidence
        >;
        // Same refusal as knowledge_challenge: no decision evidence means no judge call, not an
        // unsupported "proceed".
        if (evidence.length === 0) {
          return {
            vault: v.id,
            mode: "challenge",
            route: route.signals,
            available: true,
            // Chunks withheld by egress are gone before selection, so an empty set can be egress's doing.
            message:
              (coverage.dropped.egress ?? 0) > 0
                ? `no decision evidence remained after egress exclusion (${coverage.recalled} recalled, ${coverage.dropped.egress} excluded)`
                : `no decision-bearing chunks matched this proposal (${coverage.recalled} recalled, ${coverage.filtered_out} failed the decision filter)`,
            coverage,
            sources,
            ...excludedField,
          };
        }
        const run = challenged as NonNullable<typeof challenged>;
        const { output, model, citations, keptEvidence } = run;
        const egressCoverage = withEgressCoverage(
          coverage,
          keptEvidence.length,
          keptEvidence.filter((e) => e.truncated).length,
        );
        // Egress exclusion can empty an evidence set that was non-empty above; same refusal, no judge.
        if (!run.judged) {
          return {
            vault: v.id,
            mode: "challenge",
            route: route.signals,
            available: true,
            message: `no decision evidence remained after egress exclusion (${coverage.recalled} recalled, ${run.excludedCount} excluded)`,
            coverage: egressCoverage,
            sources,
            ...excludedField,
          };
        }
        return {
          vault: v.id,
          mode: "challenge",
          route: route.signals,
          available: true,
          model,
          challenge: output,
          coverage: withCitationCheck(egressCoverage, citations),
          sources,
          ...excludedField,
        };
      }
      // THE-934 fix round 1 (Blocking-3): an excluded chunk is dropped BEFORE it can become
      // synthesis evidence — reflect retrieves through the ordinary (lexical-inclusive) recall
      // path, so an excluded chunk is a first-class hit here even though semantic_search never
      // surfaces it.
      const notExcludedResults =
        excludeFilter === undefined
          ? results
          : results.filter((r) => !isExcludedPath(excludeFilter, r.path));
      // Selection through the shared builder; the RENDER stays this path's terse
      // `[n] path\ncontent` shape rather than adopting challenge's `path:/headings:/tags:/content:`
      // envelope. Unifying the two prompts' wording would change what the synthesis model reads,
      // and prompt wording is an evaluated change here — the builder unifies WHICH chunks are shown
      // and how they are numbered, not how they are phrased.
      const synthesis = buildEvidence(
        notExcludedResults.map((r) => ({
          path: r.path,
          chunkId: r.chunk_id,
          content: r.content ?? "",
        })),
        SYNTHESIS_EVIDENCE_BUDGET,
      );
      const evidenceBlock = synthesis.items
        .map((e) => `[${e.citation}] ${e.path}\n${e.content}`)
        .join("\n\n");
      const vaultStyle = deps.reflectDefaults?.(v.id);
      const citationStyle: ReflectCitationStyle =
        input.citation_style ?? vaultStyle?.citationStyle ?? "numeric";
      const detail: ReflectDetail = input.detail ?? vaultStyle?.detail ?? "concise";
      const res = await deps.roles.synthesize({
        ...prompt(
          reflectSystemPrompt({ citationStyle, detail }),
          `Question:\n${input.query}\n\nEvidence chunks:\n${evidenceBlock}`,
        ),
        // THE-934: the egress guard's backstop check — every path here already cleared
        // notExcludedResults above.
        sourcePaths: synthesis.items.map((e) => e.path),
      });
      // Wikilink mode rewrites the model's [n] markers from the evidence list it was shown; the
      // rewritten text is what BOTH the caller and the persisted note receive.
      const rendered =
        citationStyle === "wikilink"
          ? renderWikilinkCitations(res.text, synthesis.items)
          : { text: res.text, unresolved: [] as number[] };
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
        enforcePathAcl(ctx.acl, "write", rel, v.root, ctx.grantedScopes);
        const content = [
          "---",
          `generated_at: ${new Date(nowMs).toISOString()}`,
          `source_model: ${res.model}`,
          `query: ${JSON.stringify(input.query)}`,
          // Provenance is exactly what the model was shown (synthesis.items), not everything recalled:
          // a chunk the evidence budget or the per-note quota dropped informed nothing, and an
          // excluded chunk never appears in it.
          `source_chunks: ${JSON.stringify(synthesis.items.flatMap((e) => (e.chunkId === undefined ? [] : [e.chunkId])))}`,
          `source_paths: ${JSON.stringify([...new Set(synthesis.items.map((e) => e.path))])}`,
          "---",
          "",
          rendered.text,
          "",
        ].join("\n");
        persistGovernedNote(
          ctx.db,
          {
            snapshots: deps.snapshots,
            reindex: deps.reindex,
            now: ctx.now ?? Date.now,
            // reflect.persist writes a model-synthesized note — nothing upstream of this
            // call has scanned it — so unlike write_note (which pre-scans before calling this same
            // primitive) this is the FIRST and only scan point for this write.
            memoryDefense: deps.memoryDefense?.(v.id),
            metrics: deps.metrics,
          },
          { vaultId: v.id, root: v.root, rel, content, op: "reflect_persist", createDirs: true },
        );
        persisted = { path: rel };
      }
      return {
        vault: v.id,
        mode: "synthesis",
        route: route.signals,
        available: true,
        answer: rendered.text,
        model: res.model,
        sources,
        ...(persisted ? { persisted } : {}),
        ...(rendered.unresolved.length > 0 ? { unresolved_citations: rendered.unresolved } : {}),
        ...excludedField,
      };
    },
  });
}
