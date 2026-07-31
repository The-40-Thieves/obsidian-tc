// Command palette — core Obsidian, fully implemented (WP6.1 extraction from routes.ts).
import { body, fail, ok, str } from "./envelope";
import type { InternalApp, RouteDef } from "./types";

export function buildCommandsRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/commands/list",
      handler: (req, res) => {
        const filter = str(body(req), "filter")?.toLowerCase();
        const items = (app.commands?.listCommands() ?? [])
          .map((c) => ({ id: c.id, name: c.name }))
          .filter(
            (c) =>
              !filter ||
              c.id.toLowerCase().includes(filter) ||
              c.name.toLowerCase().includes(filter),
          );
        ok(res, { items, total: items.length });
      },
    },
    {
      method: "post",
      path: "/commands/execute",
      handler: (req, res) => {
        const id = str(body(req), "command_id");
        if (!id) return fail(res, "invalid_input", "command_id is required");
        const fired = app.commands?.executeCommandById(id) ?? false;
        if (!fired)
          return fail(res, "invalid_input", "command not found or did not run", { command_id: id });
        ok(res, { command_id: id, fired_at: new Date().toISOString() });
      },
    },
  ];
}
