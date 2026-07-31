// Tasks (WP6.2 extraction from routes.ts) — the Tasks plugin exposes no stable programmatic
// filter API, so the DSL filter degrades honestly; list_tasks/update_task (server, filesystem)
// cover the rest without the plugin.
import { fail } from "./envelope";
import { communityPlugin, type InternalApp, type RouteDef } from "./types";

export function buildTasksRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/tasks/filter",
      handler: (_req, res) => {
        if (!communityPlugin(app, "tasks"))
          return fail(res, "plugin_missing", "tasks is not installed", { plugin: "tasks" });
        fail(
          res,
          "plugin_unreachable",
          "Tasks exposes no programmatic filter API; use list_tasks",
          {
            plugin: "tasks",
          },
        );
      },
    },
  ];
}
