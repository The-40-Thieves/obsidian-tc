// QuickAdd (WP6.2 extraction from routes.ts). `actions` lists configured choices straight from
// settings (no API required); `trigger` fires a named choice through the plugin's api.
import { body, fail, ok, requireApi, str } from "./envelope";
import { communityPlugin, type InternalApp, type RouteDef } from "./types";

interface QuickAddApi {
  executeChoice?(name: string, vars?: Record<string, unknown>): Promise<unknown>;
}

export function buildQuickAddRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/quickadd/actions",
      handler: (_req, res) => {
        const plugin = communityPlugin(app, "quickadd");
        if (!plugin)
          return fail(res, "plugin_missing", "quickadd is not installed", { plugin: "quickadd" });
        const settings = plugin.settings as
          | { choices?: { name: string; type?: string }[] }
          | undefined;
        const items = (settings?.choices ?? []).map((c) => ({
          name: c.name,
          type: c.type ?? "unknown",
        }));
        ok(res, { items });
      },
    },
    {
      method: "post",
      path: "/quickadd/trigger",
      handler: async (req, res) => {
        const api = requireApi<QuickAddApi>(app, res, "quickadd");
        if (!api) return;
        if (!api.executeChoice)
          return fail(res, "plugin_unreachable", "quickadd execute API unavailable", {
            plugin: "quickadd",
          });
        const b = body(req);
        const name = str(b, "action_name");
        if (!name) return fail(res, "invalid_input", "action_name is required");
        const args =
          typeof b.args === "object" && b.args !== null
            ? (b.args as Record<string, unknown>)
            : undefined;
        await api.executeChoice(name, args);
        ok(res, { action_name: name, fired_at: new Date().toISOString() });
      },
    },
  ];
}
