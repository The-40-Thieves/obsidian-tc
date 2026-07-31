// Dataview (WP6.2 extraction from routes.ts). DQL queries and expression evaluation against the
// Dataview plugin's own index; an absent plugin or API degrades to plugin_missing /
// plugin_unreachable, and a query/evaluate failure degrades to dql_error — never a thrown 500.
import { body, fail, ok, requireApi, str } from "./envelope";
import type { InternalApp, RouteDef } from "./types";

interface DataviewQueryResult {
  successful: boolean;
  value?: { headers?: string[]; values?: unknown[][] };
  error?: string;
}
interface DataviewEvalResult {
  successful: boolean;
  value?: unknown;
  error?: string;
}
interface DataviewApi {
  query?(source: string): Promise<DataviewQueryResult>;
  // evaluate() takes a variable-context OBJECT — not a file path; page(path) builds the
  // per-note context so `file.*` and frontmatter fields resolve inside the expression.
  evaluate?(
    expr: string,
    context?: Record<string, unknown>,
  ): Promise<DataviewEvalResult> | DataviewEvalResult;
  page?(path: string): Record<string, unknown> | undefined;
}

export function buildDataviewRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/dataview/dql",
      handler: async (req, res) => {
        const dv = requireApi<DataviewApi>(app, res, "dataview");
        if (!dv) return;
        if (!dv.query)
          return fail(res, "plugin_unreachable", "dataview query API unavailable", {
            plugin: "dataview",
          });
        const r = await dv.query(str(body(req), "dql") ?? "");
        if (!r.successful) return fail(res, "dql_error", r.error ?? "DQL query failed");
        ok(res, { headers: r.value?.headers ?? [], rows: r.value?.values ?? [], note_paths: [] });
      },
    },
    {
      method: "post",
      path: "/dataview/validate",
      handler: async (req, res) => {
        const dv = requireApi<DataviewApi>(app, res, "dataview");
        if (!dv) return;
        if (!dv.query)
          return fail(res, "plugin_unreachable", "dataview query API unavailable", {
            plugin: "dataview",
          });
        const r = await dv.query(str(body(req), "dql") ?? "");
        ok(res, {
          valid: r.successful,
          ...(r.successful ? {} : { error: { message: r.error ?? "parse error" } }),
        });
      },
    },
    {
      method: "post",
      path: "/dataview/eval",
      handler: async (req, res) => {
        const dv = requireApi<DataviewApi>(app, res, "dataview");
        if (!dv) return;
        if (!dv.evaluate)
          return fail(res, "plugin_unreachable", "dataview evaluate API unavailable", {
            plugin: "dataview",
          });
        const b = body(req);
        const path = str(b, "path");
        let context: Record<string, unknown> | undefined;
        if (path) {
          const page = dv.page?.(path);
          if (!page)
            return fail(res, "note_not_found", `dataview has no indexed page for: ${path}`);
          context = page;
        }
        try {
          const r = await dv.evaluate(str(b, "expression") ?? "", context);
          if (!r.successful) return fail(res, "dql_error", r.error ?? "evaluation failed");
          ok(res, { value: r.value, type: typeof r.value });
        } catch (e) {
          fail(res, "dql_error", e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}
