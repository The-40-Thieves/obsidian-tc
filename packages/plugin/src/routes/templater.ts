// Templater (WP6.2 extraction from routes.ts) — expansion is performed by the plugin; verified
// live.
import type { TFile } from "obsidian";
import { body, fail, ok, str } from "./envelope";
import { communityPlugin, fileByPath, type InternalApp, type RouteDef } from "./types";

export function buildTemplaterRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/templater/list",
      handler: (_req, res) => {
        const plugin = communityPlugin(app, "templater");
        if (!plugin)
          return fail(res, "plugin_missing", "templater is not installed", { plugin: "templater" });
        const settings = plugin.settings as { templates_folder?: string } | undefined;
        const folder = settings?.templates_folder;
        const items = folder
          ? app.vault
              .getMarkdownFiles()
              .filter((f) => f.path.startsWith(`${folder}/`))
              .map((f) => ({ path: f.path, name: f.basename }))
          : [];
        ok(res, { items });
      },
    },
    {
      method: "post",
      path: "/templater/execute",
      handler: async (req, res) => {
        const plugin = communityPlugin(app, "templater") as
          | { templater?: { create_new_note_from_template?: unknown } }
          | undefined;
        if (!plugin)
          return fail(res, "plugin_missing", "templater is not installed", { plugin: "templater" });
        if (!plugin.templater?.create_new_note_from_template)
          return fail(res, "plugin_unreachable", "templater expansion API unavailable", {
            plugin: "templater",
          });
        const b = body(req);
        const template = str(b, "template") ?? "";
        const target = str(b, "target") ?? "";
        const tmpl = fileByPath(app, template);
        if (!tmpl) return fail(res, "note_not_found", "template not found", { path: template });
        // THE-289: honor overwrite — create_new_note_from_template clobbers/dups an existing
        // target, so refuse when the resolved target already exists and overwrite is not set.
        const targetMd = target.endsWith(".md") ? target : `${target}.md`;
        if (b.overwrite !== true && fileByPath(app, targetMd))
          return fail(res, "note_exists", "target already exists; set overwrite", {
            path: targetMd,
          });
        const create = plugin.templater.create_new_note_from_template as (
          t: TFile,
          folder: string,
          filename: string,
          open: boolean,
        ) => Promise<TFile | undefined>;
        const slash = target.lastIndexOf("/");
        const folder = slash > 0 ? target.slice(0, slash) : "";
        const filename = (slash >= 0 ? target.slice(slash + 1) : target).replace(/\.md$/, "");
        const out = await create(tmpl, folder, filename, false);
        ok(res, { template, target: out?.path ?? target, created_at: new Date().toISOString() });
      },
    },
  ];
}
