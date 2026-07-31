// Datacore (WP6.2 extraction from routes.ts) — query via the Datacore plugin's own query
// language (Dataview's successor). Public API at plugin.api (DatacoreApi): tryQuery(q) ->
// Result<Indexable[], string> ({successful, value?, error?}) using datacore's own query
// language (e.g. "@page and #tag"). Result objects expose
// $path/$name/$tags/$types/$frontmatter. Read-only.
import { body, fail, ok, requireApi, str } from "./envelope";
import type { InternalApp, RouteDef } from "./types";

interface DatacoreObject {
  $path?: string;
  $name?: string;
  $tags?: string[];
  $types?: string[];
  $frontmatter?: Record<string, unknown>;
}
interface DatacoreApi {
  tryQuery?(query: string): unknown;
}

export function buildDatacoreRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/datacore/query",
      handler: async (req, res) => {
        const api = requireApi<DatacoreApi>(app, res, "datacore");
        if (!api) return;
        if (!api.tryQuery)
          return fail(res, "plugin_unreachable", "datacore query API unavailable", {
            plugin: "datacore",
          });
        const b = body(req);
        const q = str(b, "query") ?? "";
        if (!q) return fail(res, "invalid_input", "query is required");
        const rRaw = await api.tryQuery(q);
        const r = rRaw as { successful?: boolean; value?: unknown; error?: unknown } | undefined;
        if (r && r.successful === false)
          return fail(res, "dql_error", String(r.error ?? "datacore query failed"));
        const rows: DatacoreObject[] = Array.isArray(r?.value)
          ? (r.value as DatacoreObject[])
          : Array.isArray(rRaw)
            ? (rRaw as DatacoreObject[])
            : [];
        const limit = typeof b.limit === "number" && b.limit > 0 ? b.limit : undefined;
        const sliced = limit ? rows.slice(0, limit) : rows;
        const plain = (val: unknown): unknown => {
          if (val === null || val === undefined) return val;
          const t = typeof val;
          if (t === "string" || t === "number" || t === "boolean") return val;
          if (Array.isArray(val)) return val.map(plain);
          if (t === "object") {
            const o = val as Record<string, unknown>;
            if ("value" in o) return plain(o.value);
            return String(val);
          }
          return String(val);
        };
        const items = sliced.map((o) => ({
          path: o?.$path,
          name: o?.$name,
          tags: o?.$tags ?? [],
          types: o?.$types ?? [],
          fields:
            o?.$frontmatter && typeof o.$frontmatter === "object"
              ? Object.fromEntries(
                  Object.entries(o.$frontmatter).map(([k, val]) => [k, plain(val)]),
                )
              : {},
        }));
        ok(res, { items, total: items.length, query: q });
      },
    },
  ];
}
