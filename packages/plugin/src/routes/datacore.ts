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
const LINK_TYPES = new Set<unknown>(["file", "header", "block"]);

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
        // A Datacore Link becomes the object form of the note it resolves to, so the server's
        // read-ACL filter judges its path. Datacore's Link fields are getters on a class instance,
        // so they are read by name, never by own keys. An unresolvable Link names no note and keeps
        // its string form.
        const linkOf = (o: Record<string, unknown>, sourcePath: string): unknown => {
          const path = o.path;
          if (typeof path !== "string" || !LINK_TYPES.has(o.type)) return undefined;
          const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
          if (!file) return String(o);
          return {
            path: file.path,
            type: o.type,
            display: o.display ?? null,
            subpath: o.subpath ?? null,
            embed: o.embed === true,
          };
        };
        const plain = (val: unknown, sourcePath: string): unknown => {
          if (val === null || val === undefined) return val;
          const t = typeof val;
          if (t === "string" || t === "number" || t === "boolean") return val;
          if (Array.isArray(val)) return val.map((v) => plain(v, sourcePath));
          if (t === "object") {
            const o = val as Record<string, unknown>;
            const link = linkOf(o, sourcePath);
            if (link !== undefined) return link;
            if ("value" in o) return plain(o.value, sourcePath);
            return String(val);
          }
          return String(val);
        };
        const items = sliced.map((o) => {
          const sourcePath = o?.$path ?? "";
          return {
            path: o?.$path,
            name: o?.$name,
            tags: o?.$tags ?? [],
            types: o?.$types ?? [],
            fields:
              o?.$frontmatter && typeof o.$frontmatter === "object"
                ? Object.fromEntries(
                    Object.entries(o.$frontmatter).map(([k, val]) => [k, plain(val, sourcePath)]),
                  )
                : {},
          };
        });
        ok(res, { items, total: items.length, query: q });
      },
    },
  ];
}
