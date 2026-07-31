// make.md (WP6.2 extraction from routes.ts).
import { body, fail, ok, requireApi, str } from "./envelope";
import type { InternalApp, RouteDef } from "./types";

export function buildMakemdRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/makemd/spaces",
      handler: (_req, res) => {
        const api = requireApi<{ spaces?: () => unknown[] }>(app, res, "make-md");
        if (!api) return;
        ok(res, { spaces: typeof api.spaces === "function" ? api.spaces() : [] });
      },
    },
    {
      method: "post",
      path: "/makemd/query",
      handler: (req, res) => {
        const api = requireApi<{ query?: (id: string, filter?: unknown) => unknown }>(
          app,
          res,
          "make-md",
        );
        if (!api) return;
        if (!api.query)
          return fail(res, "plugin_unreachable", "make-md query API unavailable", {
            plugin: "make-md",
          });
        const b = body(req);
        const items = api.query(str(b, "space_id") ?? "", b.filter);
        ok(res, {
          items: Array.isArray(items) ? items : [],
          total: Array.isArray(items) ? items.length : 0,
        });
      },
    },
  ];
}
