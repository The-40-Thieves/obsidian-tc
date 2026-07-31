// Excalidraw (WP6.2 extraction from routes.ts) — read returns raw scene text; write
// scaffolds/updates the note file. `write`'s overwrite safeguard is destructive-operation-
// sensitive: writing the content-free scaffold over an existing drawing DESTROYS the scene, so
// it must be preserved exactly, unchanged by this move.
import { normalizePath } from "obsidian";
import { body, fail, ok, str } from "./envelope";
import { communityPlugin, fileByPath, type InternalApp, type RouteDef } from "./types";

export function buildExcalidrawRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/excalidraw/read",
      handler: async (req, res) => {
        if (!communityPlugin(app, "excalidraw"))
          return fail(res, "plugin_missing", "excalidraw is not installed", {
            plugin: "excalidraw",
          });
        const rel = str(body(req), "path") ?? "";
        const file = fileByPath(app, rel);
        if (!file) return fail(res, "note_not_found", "drawing not found", { path: rel });
        const text = await app.vault.read(file);
        ok(res, { path: rel, text_content: text });
      },
    },
    {
      method: "post",
      path: "/excalidraw/write",
      handler: async (req, res) => {
        if (!communityPlugin(app, "excalidraw"))
          return fail(res, "plugin_missing", "excalidraw is not installed", {
            plugin: "excalidraw",
          });
        const b = body(req);
        const rel = str(b, "path") ?? "";
        const existing = fileByPath(app, rel);
        // The scaffold is content-free, so writing it over an existing drawing DESTROYS the
        // scene. Only ever scaffold a NEW file (or an explicit overwrite:true reset); never
        // silently clobber existing content — regardless of `mode` (a `mode:"update"` on a
        // populated drawing previously wiped it to boilerplate).
        if (existing && b.overwrite !== true) {
          if (b.mode === "create")
            return fail(res, "note_exists", "drawing already exists", { path: rel });
          return ok(res, { path: rel, plugin_used: true, unchanged: true });
        }
        const scaffold = "---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n";
        if (existing) await app.vault.modify(existing, scaffold);
        else await app.vault.create(normalizePath(rel), scaffold);
        ok(res, { path: rel, plugin_used: true });
      },
    },
  ];
}
