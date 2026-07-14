// Domain 6 — Search (G2.1 r2). Six tools, all read-side, all pure, all dispatched
// through the M0 pipeline (validate -> auth -> scope/ACL -> execute -> governor ->
// audit). Every tool is ACL-filtered to the read-visible note set, so search never
// leaks across the folder ACL. search_vault is the mode router; auto routes a
// string query text -> semantic (fallback on zero hits) and an object query to
// jsonlogic. search_dql is surfaced but reports plugin_missing until the Dataview
// bridge (REST hybrid, THE-196) lands — honest rather than a silent empty result.
import {
  err,
  grantsAll,
  ObsidianTcError,
  VaultId,
  VaultPath,
} from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { FolderAcl } from "../../acl";
import type { Database } from "../../db/types";
import type { ToolDefinition } from "../../mcp/registry";
import { evaluatesTruthy } from "../../search/jsonlogic";
import { type SemanticHit, semanticSearch } from "../../search/semantic";
import { searchRegex, searchText, searchTextIndexed } from "../../search/text";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel, readEnumerationUnrestricted } from "../../vault/acl-read-filter";
import { parseNote } from "../../vault/frontmatter";
import { readNote } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M2Deps } from "./index";

interface UnifiedHit {
  path: string;
  score: number;
  mode_used: string;
  chunk_id?: string;
  snippet?: string;
  line?: number;
}

interface Page<T> {
  items: T[];
  total: number;
  next_cursor?: string;
}

function underRoot(rel: string, sub: string | undefined): boolean {
  return sub === undefined || rel === sub || rel.startsWith(`${sub}/`);
}

function paginate<T>(items: T[], limit?: number, cursor?: string): Page<T> {
  const size = limit ?? 50;
  const start = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
  const slice = items.slice(start, start + size);
  const nextStart = start + slice.length;
  const next = nextStart < items.length ? String(nextStart) : undefined;
  return { items: slice, total: items.length, ...(next ? { next_cursor: next } : {}) };
}

function jsonlogicMatches(
  root: string,
  sub: string | undefined,
  readable: (rel: string) => boolean,
  logic: unknown,
): string[] {
  const out: string[] = [];
  for (const rel of walkVault(root, { sub, extensions: [".md"] })
    .map((e) => e.relPath)
    .filter(readable)) {
    const { frontmatter, body } = parseNote(readNote(resolveVaultPath(root, rel)).raw);
    const data = { ...(frontmatter ?? {}), path: rel, content: body };
    if (evaluatesTruthy(logic, data)) out.push(rel);
  }
  return out;
}

interface DqlResult {
  headers?: string[];
  rows: unknown[][];
  note_paths: string[];
}

// Execute a DQL query via the shared Dataview bridge (wired by cli.ts). Absent
// bridge => plugin_missing (honest "not configured"); a live but degraded bridge
// surfaces plugin_missing / plugin_unreachable / dql_error from openBridge + the
// transport. Read-only by contract; the companion rejects non-read DQL.
async function runDql(
  deps: M2Deps,
  vaultId: string,
  dql: string,
  format: string,
): Promise<DqlResult> {
  if (!deps.dataviewBridge)
    throw err.pluginMissing(
      "DQL requires the Dataview companion-plugin bridge, which is not configured",
      { plugin: "dataview" },
    );
  const { client, timeoutMs } = deps.dataviewBridge(vaultId);
  return client.request<DqlResult>({
    method: "POST",
    path: "/dataview/dql",
    body: { dql, format },
    plugin: "dataview",
    timeoutMs,
  });
}

const Cursor = {
  limit: z.number().int().positive().max(1000).optional(),
  cursor: z.string().optional(),
};

// THE-251: opt-in terse projection — collapse each hit to path + score + snippet
// (whichever are present), dropping heavy per-hit fields (line/col/chunk_id/content)
// to cut agent prompt cost. Default stays "full" for back-compat.
const Verbosity = {
  verbosity: z.enum(["full", "terse"]).default("full"),
};

function projectHits(
  items: ReadonlyArray<{ path: string; score?: number; snippet?: string }>,
  verbosity: "full" | "terse",
): unknown[] {
  if (verbosity !== "terse") return items as unknown[];
  return items.map((h) => {
    const out: { path: string; score?: number; snippet?: string } = { path: h.path };
    if (h.score !== undefined) out.score = h.score;
    if (h.snippet !== undefined) out.snippet = h.snippet;
    return out;
  });
}

export function buildSearchTools(deps: M2Deps): ToolDefinition[] {
  // Resolve vault + (optional) read-gated root folder, plus a readable predicate
  // that also confines results to that root.
  const scope = (
    ctx: { acl?: FolderAcl },
    vault: string,
    root?: string,
  ): { id: string; rootPath: string; sub?: string; readable: (rel: string) => boolean } => {
    const v = deps.vaultRegistry.resolve(vault);
    const sub = root ? normalizeVaultPath(root) : undefined;
    if (sub) enforcePathAcl(ctx.acl, "read", sub, v.root);
    return {
      id: v.id,
      rootPath: v.root,
      sub,
      readable: (rel) => readableRel(ctx.acl, rel) && underRoot(rel, sub),
    };
  };

  const embedQuery = async (query: string): Promise<number[]> => {
    const [vec] = await deps.embeddingProvider.embed([query], { input: "query" });
    return vec ?? [];
  };

  const semantic = async (
    ctx: { acl?: FolderAcl; db: Database; sessionId?: string },
    s: ReturnType<typeof scope>,
    query: string,
    k: number,
    minScore: number | undefined,
    returnContent: boolean,
    surface: string,
  ): Promise<SemanticHit[]> => {
    const hits = semanticSearch(ctx.db, s.id, await embedQuery(query), {
      k,
      minScore,
      returnContent,
      isReadable: s.readable,
    });
    // THE-230: serve-path retrieval telemetry (best-effort; the logger never throws).
    deps.retrievalLog?.({
      queryText: query,
      surfaceType: surface,
      sessionId: ctx.sessionId ?? null,
      hits: hits.map((h, i) => ({ chunkId: h.chunk_id, rank: i + 1, score: h.score })),
    });
    return hits;
  };

  return [
    defineTool({
      name: "search_text",
      description:
        "Literal text search across vault notes (BM25-ranked). Supports case_sensitive and whole_word; scoped to an optional root folder.",
      inputSchema: z
        .object({
          vault: VaultId,
          query: z.string().min(1),
          case_sensitive: z.boolean().default(false),
          whole_word: z.boolean().default(false),
          root: VaultPath.optional(),
          ...Cursor,
          ...Verbosity,
        })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const s = scope(ctx, input.vault, input.root);
        const textOpts = {
          query: input.query,
          caseSensitive: input.case_sensitive,
          wholeWord: input.whole_word,
          sub: s.sub,
          isReadable: s.readable,
          limit: 5000,
        };
        // THE-291 (3B): FTS candidates + disk re-verify when the index is ready; null (short
        // query / cap overflow / no FTS) falls back to the exhaustive disk scan.
        const idx = deps.metadataIndex;
        const hits =
          (idx?.hasFts && idx.ready()
            ? searchTextIndexed(ctx.db, s.id, s.rootPath, textOpts)
            : null) ?? searchText(s.rootPath, textOpts);
        return {
          vault: s.id,
          mode_used: "text",
          ...paginate(projectHits(hits, input.verbosity), input.limit, input.cursor),
        };
      },
    }),

    defineTool({
      name: "search_regex",
      description:
        "Regular-expression search across vault notes. Each match returns line/col + the matched text; capped per file. Pattern length is bounded, patterns with nested quantifiers are rejected, and execution is time-budgeted (governor.regexTimeoutMs) to prevent catastrophic backtracking; flags may only be i, m, s, u.",
      inputSchema: z
        .object({
          vault: VaultId,
          pattern: z.string().min(1).max(1000),
          flags: z
            .string()
            .regex(/^[imsu]*$/, "flags may only contain i, m, s, u")
            .max(8)
            .default("i"),
          root: VaultPath.optional(),
          max_matches_per_file: z.number().int().positive().max(1000).default(10),
          ...Cursor,
          ...Verbosity,
        })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: async (input, ctx) => {
        const s = scope(ctx, input.vault, input.root);
        const hits = await searchRegex(s.rootPath, {
          pattern: input.pattern,
          flags: input.flags,
          sub: s.sub,
          maxPerFile: input.max_matches_per_file,
          isReadable: s.readable,
          timeoutMs: deps.regexTimeoutMs,
          limit: 5000,
        });
        return {
          vault: s.id,
          mode_used: "regex",
          ...paginate(projectHits(hits, input.verbosity), input.limit, input.cursor),
        };
      },
    }),

    defineTool({
      name: "search_semantic",
      description:
        "Dense-vector retrieval over the chunk store (run index_vault first). Returns the top-k chunks by cosine similarity. verbosity=terse drops chunk content/metadata, returning path/score only.",
      inputSchema: z
        .object({
          vault: VaultId,
          query: z.string().min(1),
          k: z.number().int().positive().max(100).default(10),
          root: VaultPath.optional(),
          min_score: z.number().optional(),
          return_content: z.boolean().default(true),
          ...Verbosity,
        })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: async (input, ctx) => {
        const s = scope(ctx, input.vault, input.root);
        const items = await semantic(
          ctx,
          s,
          input.query,
          input.k,
          input.min_score,
          input.return_content,
          "search_semantic",
        );
        return { vault: s.id, mode_used: "semantic", items: projectHits(items, input.verbosity) };
      },
    }),

    defineTool({
      name: "search_jsonlogic",
      description:
        "Filter notes with a JSONLogic expression over frontmatter + { path, content }. Returns matching note paths.",
      inputSchema: z
        .object({
          vault: VaultId,
          logic: z.record(z.string(), z.unknown()),
          root: VaultPath.optional(),
          ...Cursor,
          ...Verbosity,
        })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const s = scope(ctx, input.vault, input.root);
        const matched = jsonlogicMatches(s.rootPath, s.sub, s.readable, input.logic).map(
          (path) => ({
            path,
            matched: true as const,
          }),
        );
        return {
          vault: s.id,
          mode_used: "jsonlogic",
          ...paginate(projectHits(matched, input.verbosity), input.limit, input.cursor),
        };
      },
    }),

    defineTool({
      name: "search_dql",
      description:
        "Run a Dataview DQL query via the companion plugin bridge. Returns headers/rows and the matched note paths. Requires the Dataview bridge; reports plugin_missing when it is not configured.",
      inputSchema: z
        .object({
          vault: VaultId,
          dql: z.string().min(1),
          format: z.enum(["table", "list", "task", "calendar"]).default("table"),
        })
        .strict(),
      requiredScopes: ["read:notes", "read:dataview"],
      handler: async (input, ctx) => {
        const s = scope(ctx, input.vault);
        if (!readEnumerationUnrestricted(ctx.acl))
          throw err.aclDenied(
            "search_dql enumerates the whole vault and cannot be read-ACL filtered; refused",
            { tool: "search_dql" },
          );
        const result = await runDql(deps, s.id, input.dql, input.format);
        return { vault: s.id, ...result };
      },
    }),

    defineTool({
      name: "search_vault",
      description:
        "Unified search dispatch. mode=auto routes a string query text->semantic (fallback on zero hits) and an object query to jsonlogic; or force text/regex/semantic/jsonlogic/dql. Set verbosity=terse to compact each hit to path/score/snippet.",
      inputSchema: z
        .object({
          vault: VaultId,
          query: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
          mode: z.enum(["auto", "text", "regex", "dql", "jsonlogic", "semantic"]).default("auto"),
          root: VaultPath.optional(),
          explain: z.boolean().default(false),
          ...Cursor,
          ...Verbosity,
        })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: async (input, ctx) => {
        const s = scope(ctx, input.vault, input.root);
        const asString = (): string => {
          if (typeof input.query !== "string")
            throw err.invalidInput("this search mode requires a string query");
          return input.query;
        };
        const asObject = (): Record<string, unknown> => {
          if (typeof input.query === "string")
            throw err.invalidInput("this search mode requires an object query");
          return input.query;
        };
        const textHits = (): UnifiedHit[] => {
          const textOpts = { query: asString(), sub: s.sub, isReadable: s.readable, limit: 5000 };
          const idx = deps.metadataIndex;
          return (
            (idx?.hasFts && idx.ready()
              ? searchTextIndexed(ctx.db, s.id, s.rootPath, textOpts)
              : null) ?? searchText(s.rootPath, textOpts)
          ).map((h) => ({
            path: h.path,
            score: h.score,
            mode_used: "text",
            snippet: h.snippet,
            line: h.line,
          }));
        };
        const semanticHits = async (): Promise<UnifiedHit[]> =>
          (
            await semantic(ctx, s, asString(), input.limit ?? 50, undefined, false, "search_vault")
          ).map((h) => ({
            path: h.path,
            score: h.score,
            mode_used: "semantic",
            chunk_id: h.chunk_id,
          }));

        const tried: string[] = [];
        let items: UnifiedHit[] = [];
        let chosen = input.mode;

        switch (input.mode) {
          case "text":
            tried.push("text");
            items = textHits();
            break;
          case "regex":
            tried.push("regex");
            items = (
              await searchRegex(s.rootPath, {
                pattern: asString(),
                sub: s.sub,
                isReadable: s.readable,
                timeoutMs: deps.regexTimeoutMs,
                limit: 5000,
              })
            ).map((h) => ({
              path: h.path,
              score: 1,
              mode_used: "regex",
              snippet: h.snippet,
              line: h.line,
            }));
            break;
          case "semantic":
            tried.push("semantic");
            items = await semanticHits();
            break;
          case "jsonlogic":
            tried.push("jsonlogic");
            items = jsonlogicMatches(s.rootPath, s.sub, s.readable, asObject()).map((path) => ({
              path,
              score: 1,
              mode_used: "jsonlogic",
            }));
            break;
          case "dql": {
            // The router's static scope is read:notes; the dql path additionally
            // touches the Dataview bridge, so enforce read:dataview inline
            // (deny-by-default) rather than weakening every other mode's scope.
            if (!grantsAll(ctx.grantedScopes, ["read:dataview"]))
              throw new ObsidianTcError(
                "forbidden",
                "search mode 'dql' requires the read:dataview scope",
                { required: ["read:dataview"] },
              );
            tried.push("dql");
            if (!readEnumerationUnrestricted(ctx.acl))
              throw err.aclDenied(
                "search mode dql enumerates the whole vault and cannot be read-ACL filtered; refused",
                { tool: "search_vault" },
              );
            const dql = await runDql(deps, s.id, asString(), "table");
            return { vault: s.id, mode_used: "dql", ...dql };
          }
          default: {
            // auto: object -> jsonlogic; string -> text, then semantic on zero hits.
            if (typeof input.query !== "string") {
              tried.push("jsonlogic");
              chosen = "jsonlogic";
              items = jsonlogicMatches(s.rootPath, s.sub, s.readable, input.query).map((path) => ({
                path,
                score: 1,
                mode_used: "jsonlogic",
              }));
            } else {
              tried.push("text");
              chosen = "text";
              items = textHits();
              if (items.length === 0) {
                tried.push("semantic");
                chosen = "semantic";
                items = await semanticHits();
              }
            }
          }
        }

        const explain = input.explain
          ? {
              _explain: {
                modes_tried: tried,
                chosen,
                reason:
                  input.mode === "auto" && chosen === "semantic"
                    ? "text returned no hits; fell back to semantic"
                    : `mode ${input.mode}`,
              },
            }
          : {};
        return {
          vault: s.id,
          mode_used: chosen,
          ...paginate(projectHits(items, input.verbosity), input.limit, input.cursor),
          ...explain,
        };
      },
    }),
  ];
}
