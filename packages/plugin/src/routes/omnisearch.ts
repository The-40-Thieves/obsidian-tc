// Omnisearch (WP6.2 extraction from routes.ts) — ranked full-text search via the plugin's
// public search() API. Public API at plugin.api: search(query) -> ranked ResultNoteApi[]
// ({score, path, basename, foundWords, matches:{match,offset}[], excerpt}). Read-only; no
// vault mutation.
import { body, fail, ok, requireApi, str } from "./envelope";
import type { InternalApp, RouteDef } from "./types";

interface OmnisearchMatchApi {
  match: string;
  offset: number;
}
interface OmnisearchResultApi {
  score: number;
  path: string;
  basename: string;
  excerpt: string;
  foundWords?: string[];
  matches?: OmnisearchMatchApi[];
}
interface OmnisearchApi {
  search?(query: string): Promise<OmnisearchResultApi[]>;
}

export function buildOmnisearchRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/omnisearch/search",
      handler: async (req, res) => {
        const api = requireApi<OmnisearchApi>(app, res, "omnisearch");
        if (!api) return;
        if (!api.search)
          return fail(res, "plugin_unreachable", "omnisearch search API unavailable", {
            plugin: "omnisearch",
          });
        const b = body(req);
        const query = str(b, "query") ?? "";
        if (!query) return fail(res, "invalid_input", "query is required");
        const raw = await api.search(query);
        const limit = typeof b.limit === "number" && b.limit > 0 ? b.limit : undefined;
        const sliced = limit ? raw.slice(0, limit) : raw;
        const items = sliced.map((r) => ({
          path: r.path,
          basename: r.basename,
          score: r.score,
          excerpt: r.excerpt,
          found_words: r.foundWords ?? [],
          matches: (r.matches ?? []).map((m) => ({ match: m.match, offset: m.offset })),
        }));
        ok(res, { items, total: items.length, query });
      },
    },
  ];
}
