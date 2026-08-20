// make.md (WP6.2 extraction from routes.ts).
//
// THE-860: make.md's own published `IAPI` (github.com/Make-md/makemd, `src/shared/types/api.ts`,
// implemented by `class API implements IAPI` in `src/core/superstate/api.ts`) has had NO `spaces()`
// or `query()` method since at least v1.0.1 (2024-12-27) through the current release, v1.3.5
// (`main` @ cb9ca90, 2026-07-09) — verified directly against the repo 2026-08-20. IAPI instead
// exposes `frame`, `properties`, `path`, `commands`, `buttonCommand`, `table`, `context`, `date`.
// This is not a rename: no method on the current (or year-plus-old) API corresponds to "enumerate
// spaces" or "query a space's contents", so there is nothing to rewrite these two handlers to call.
// Both routes are therefore dead against every make.md version this bridge could plausibly be
// talking to, and stay dead-but-legible (typed `plugin_unreachable`, not a silent empty result)
// until make.md restores a runtime API for this, or an owner decides to drop the routes (a product
// decision out of scope here — THE-749's contract fixture pinned the prior silent-`[]` behavior on
// /spaces; this is the fix for that gap).
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
        if (typeof api.spaces !== "function")
          return fail(res, "plugin_unreachable", "make-md spaces API unavailable", {
            plugin: "make-md",
          });
        ok(res, { spaces: api.spaces() });
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
