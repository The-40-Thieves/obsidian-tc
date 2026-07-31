// Metadata Menu (WP6.2 extraction from routes.ts) — read a note's typed fields (name ->
// value/type/validity/source). Public API at plugin.api (IMetadataMenuApi):
// namedFileFields(file) -> Promise<Record<fieldName, IFieldInfo{value, type, isValid,
// sourceType}>>. Read-only field introspection.
import type { TFile } from "obsidian";
import { body, fail, ok, requireApi, str } from "./envelope";
import { fileByPath, type InternalApp, type RouteDef } from "./types";

interface MetadataMenuFieldInfo {
  value?: unknown;
  type?: unknown;
  isValid?: unknown;
  sourceType?: unknown;
}
interface MetadataMenuApi {
  namedFileFields?(file: TFile | string): Promise<Record<string, MetadataMenuFieldInfo>>;
}

export function buildMetadataMenuRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/metadata-menu/fields",
      handler: async (req, res) => {
        const api = requireApi<MetadataMenuApi>(app, res, "metadata-menu");
        if (!api) return;
        if (!api.namedFileFields)
          return fail(res, "plugin_unreachable", "metadata-menu fields API unavailable", {
            plugin: "metadata-menu",
          });
        const rel = str(body(req), "path") ?? "";
        if (!rel) return fail(res, "invalid_input", "path is required");
        const file = fileByPath(app, rel);
        if (!file) return fail(res, "note_not_found", "note not found", { path: rel });
        const raw = await api.namedFileFields(file);
        const fields: Record<string, unknown> = {};
        for (const [name, info] of Object.entries(raw ?? {})) {
          fields[name] = {
            value: info?.value ?? null,
            type: typeof info?.type === "string" ? info.type : undefined,
            is_valid: typeof info?.isValid === "boolean" ? info.isValid : undefined,
            source_type: typeof info?.sourceType === "string" ? info.sourceType : undefined,
          };
        }
        ok(res, { path: rel, fields, total: Object.keys(fields).length });
      },
    },
  ];
}
