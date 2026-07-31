// Daily Notes (core) (WP6.2 extraction from routes.ts) — resolve the daily note for a date via
// the core plugin's folder+format.
import { moment, normalizePath } from "obsidian";
import { body, fail, ok, str } from "./envelope";
import { fileByPath, type InternalApp, internalPlugin, type RouteDef } from "./types";

// Obsidian re-exports moment.js at runtime but its bundled d.ts types the export without a
// call signature; alias to a minimal callable to construct dates for the daily-notes bridge.
type MomentLike = { isValid(): boolean; format(fmt: string): string };
const makeMoment = moment as unknown as (input?: string) => MomentLike;

export function buildDailyNotesRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/daily-notes/resolve",
      handler: (req, res) => {
        const dn = internalPlugin(app, "daily-notes");
        if (!dn?.enabled)
          return fail(res, "plugin_unreachable", "core Daily Notes plugin is not enabled", {
            plugin: "daily-notes",
          });
        const opts = dn.instance?.options ?? {};
        const folder = typeof opts.folder === "string" ? opts.folder : "";
        const format = typeof opts.format === "string" && opts.format ? opts.format : "YYYY-MM-DD";
        const dateStr = str(body(req), "date");
        const m = dateStr ? makeMoment(dateStr) : makeMoment();
        if (!m.isValid())
          return fail(res, "invalid_input", "date is not a valid date", { date: dateStr });
        const rel = normalizePath(
          folder ? `${folder}/${m.format(format)}.md` : `${m.format(format)}.md`,
        );
        const file = fileByPath(app, rel);
        ok(res, { date: m.format("YYYY-MM-DD"), folder, format, path: rel, exists: !!file });
      },
    },
  ];
}
