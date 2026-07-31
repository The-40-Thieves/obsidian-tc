// Remotely Save (THE-381, WP6.1 extraction from routes.ts): an independent backup-verification
// signal. Status duck-types the plugin's fields; trigger fires the public start-sync command.
import { fail, ok } from "./envelope";
import { type CommunityPlugin, communityPlugin, type InternalApp, type RouteDef } from "./types";

export function buildRemotelySaveRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/remotely-save/status",
      handler: (_req, res) => {
        const plugin = communityPlugin(app, "remotely-save") as
          | (CommunityPlugin & { syncStatus?: unknown; settings?: { lastSuccessSync?: unknown } })
          | undefined;
        if (!plugin)
          return fail(res, "plugin_missing", "remotely-save is not installed", {
            plugin: "remotely-save",
          });
        ok(res, {
          sync_status: typeof plugin.syncStatus === "string" ? plugin.syncStatus : "unknown",
          last_success_sync:
            typeof plugin.settings?.lastSuccessSync === "number"
              ? plugin.settings.lastSuccessSync
              : null,
        });
      },
    },
    {
      method: "post",
      path: "/remotely-save/trigger",
      handler: (_req, res) => {
        const plugin = communityPlugin(app, "remotely-save");
        if (!plugin)
          return fail(res, "plugin_missing", "remotely-save is not installed", {
            plugin: "remotely-save",
          });
        const fired = app.commands?.executeCommandById("remotely-save:start-sync") ?? false;
        if (!fired)
          return fail(res, "plugin_unreachable", "start-sync command did not fire", {
            plugin: "remotely-save",
          });
        ok(res, { triggered: true, fired_at: new Date().toISOString() });
      },
    },
  ];
}
