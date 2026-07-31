// OCR / Text Extractor (WP6.2 extraction from routes.ts). `attachment` extracts one file;
// `bulk` extracts a batch, isolating each path's failure so one bad path doesn't abort the rest.
import type { TFile } from "obsidian";
import { body, fail, ok, requireApi, str } from "./envelope";
import { fileByPath, type InternalApp, type RouteDef } from "./types";

interface TextExtractorApi {
  extractText?(file: TFile): Promise<string>;
  isInCache?(file: TFile): Promise<boolean>;
}

export function buildOcrRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/ocr/attachment",
      handler: async (req, res) => {
        const api = requireApi<TextExtractorApi>(app, res, "text-extractor");
        if (!api) return;
        if (!api.extractText)
          return fail(res, "plugin_unreachable", "text-extractor API unavailable", {
            plugin: "text-extractor",
          });
        const rel = str(body(req), "path") ?? "";
        const file = fileByPath(app, rel);
        if (!file) return fail(res, "note_not_found", "attachment not found", { path: rel });
        const cached = (await api.isInCache?.(file)) ?? false;
        const start = Date.now();
        const text = await api.extractText(file);
        ok(res, { path: rel, text, cached, duration_ms: Date.now() - start });
      },
    },
    {
      method: "post",
      path: "/ocr/bulk",
      handler: async (req, res) => {
        const api = requireApi<TextExtractorApi>(app, res, "text-extractor");
        if (!api) return;
        if (!api.extractText)
          return fail(res, "plugin_unreachable", "text-extractor API unavailable", {
            plugin: "text-extractor",
          });
        const raw = body(req).paths;
        const paths = Array.isArray(raw) ? (raw as unknown[]) : [];
        const start = Date.now();
        const results: { path: string; ok: boolean; text?: string; error?: string }[] = [];
        for (const rel of paths) {
          // Validate per-item so one non-string element yields a per-path error instead of
          // throwing out of fileByPath and aborting the whole batch.
          if (typeof rel !== "string") {
            results.push({ path: String(rel), ok: false, error: "path must be a string" });
            continue;
          }
          const file = fileByPath(app, rel);
          if (!file) {
            results.push({ path: rel, ok: false, error: "not found" });
            continue;
          }
          try {
            results.push({ path: rel, ok: true, text: await api.extractText(file) });
          } catch (e) {
            results.push({ path: rel, ok: false, error: (e as Error).message });
          }
        }
        ok(res, { processed: results.length, results, total_duration_ms: Date.now() - start });
      },
    },
  ];
}
