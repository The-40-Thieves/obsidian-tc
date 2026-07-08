// Bridge route handlers for the obsidian-tc companion plugin (THE-180, G2.2 §3.1).
// Each handler returns the bridge envelope the server's transport expects:
//   success: { ok: true, result }   failure: { ok: false, code, message, details? }
// `/probe` and `/commands/*` run against deterministic Obsidian internals and are
// the load-bearing contract (the server's auto-probe + command palette depend on
// them). The community-plugin domain handlers (dataview/excalidraw/tasks/templater/
// quickadd/ocr/makemd) invoke each plugin's runtime API and are the MANUAL-
// verification surface: CI builds + typechecks this file, but their live behavior
// against installed community plugins is validated against a real vault, not in CI.
// Any absent API or thrown error degrades to a typed envelope the server already
// handles (plugin_missing / plugin_unreachable / invalid_input / dql_error).
import { type App, apiVersion, normalizePath, type TFile } from "obsidian";

/** Bridge protocol version reported by /probe (matches the server's expectation). */
const API_VERSION = "1";

// Server capability key -> the community plugin's Obsidian id. The server addresses
// plugins by the left-hand name (e.g. "excalidraw"); the right-hand is the real id.
const CAP_IDS: Record<string, string> = {
  excalidraw: "obsidian-excalidraw-plugin",
  dataview: "dataview",
  tasks: "obsidian-tasks-plugin",
  templater: "templater-obsidian",
  quickadd: "quickadd",
  "text-extractor": "text-extractor",
  "make-md": "make-md",
};

export interface BridgeReq {
  body?: unknown;
  query?: Record<string, unknown>;
}
export interface BridgeRes {
  status(code: number): BridgeRes;
  json(body: unknown): void;
}
export type RouteHandler = (req: BridgeReq, res: BridgeRes) => void | Promise<void>;
export interface RouteDef {
  method: "get" | "post";
  path: string;
  handler: RouteHandler;
}

// --- Minimal models of Obsidian/community internals not in the public obsidian d.ts.
interface CommunityPlugin {
  manifest?: { version?: string };
  api?: unknown;
  settings?: unknown;
}
interface PluginRegistry {
  plugins: Record<string, CommunityPlugin | undefined>;
}
interface CommandLite {
  id: string;
  name: string;
}
interface CommandsRegistry {
  listCommands(): CommandLite[];
  executeCommandById(id: string): boolean;
}
type InternalApp = App & { plugins?: PluginRegistry; commands?: CommandsRegistry };

const ok = (res: BridgeRes, result: unknown): void => {
  res.status(200).json({ ok: true, result });
};
const fail = (
  res: BridgeRes,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void => {
  res.status(200).json({ ok: false, code, message, ...(details ? { details } : {}) });
};

const body = (req: BridgeReq): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
const str = (o: Record<string, unknown>, k: string): string | undefined =>
  typeof o[k] === "string" ? (o[k] as string) : undefined;

function communityPlugin(app: InternalApp, capKey: string): CommunityPlugin | undefined {
  const id = CAP_IDS[capKey];
  return id ? app.plugins?.plugins?.[id] : undefined;
}

// Resolve a community plugin's `api`, mapping absence onto the error taxonomy: the
// plugin not installed -> plugin_missing; installed but exposing no usable api ->
// plugin_unreachable. Returns the api on success, or null after sending the failure.
function requireApi<T>(app: InternalApp, res: BridgeRes, capKey: string): T | null {
  const plugin = communityPlugin(app, capKey);
  if (!plugin) {
    fail(res, "plugin_missing", `${capKey} is not installed`, { plugin: capKey });
    return null;
  }
  if (!plugin.api) {
    fail(res, "plugin_unreachable", `${capKey} exposes no programmatic API`, { plugin: capKey });
    return null;
  }
  return plugin.api as T;
}

// --- /probe: deterministic capability discovery. -----------------------------------
function probeResult(app: InternalApp, pluginVersion: string, shapeWarnings: string[]): unknown {
  const capabilities: Record<string, { installed: boolean; version?: string }> = {};
  for (const [key, id] of Object.entries(CAP_IDS)) {
    const p = app.plugins?.plugins?.[id];
    capabilities[key] = p
      ? { installed: true, ...(p.manifest?.version ? { version: p.manifest.version } : {}) }
      : { installed: false };
  }
  return {
    plugin_version: pluginVersion,
    obsidian_version: apiVersion,
    obsidianTcApiVersion: API_VERSION,
    vault_path: app.vault.getName(),
    capabilities,
    // THE-282: startup shape self-check results (Obsidian internals this plugin duck-types).
    shape_ok: shapeWarnings.length === 0,
    ...(shapeWarnings.length ? { shape_warnings: shapeWarnings } : {}),
  };
}

// --- Dataview adapters -------------------------------------------------------------
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
  evaluate?(expr: string, file?: string): Promise<DataviewEvalResult> | DataviewEvalResult;
}

// --- QuickAdd / Text Extractor adapters --------------------------------------------
interface QuickAddApi {
  executeChoice?(name: string, vars?: Record<string, unknown>): Promise<unknown>;
}
interface TextExtractorApi {
  extractText?(file: TFile): Promise<string>;
  isInCache?(file: TFile): Promise<boolean>;
}

function fileByPath(app: App, rel: string): TFile | null {
  const f = app.vault.getAbstractFileByPath(normalizePath(rel));
  // TFile is the leaf type; folders lack the `extension` field we duck-check here.
  return f && "extension" in f ? (f as TFile) : null;
}

export function buildRoutes(
  appArg: App,
  pluginVersion: string,
  shapeWarnings: string[] = [],
): RouteDef[] {
  const app = appArg as unknown as InternalApp;
  return [
    {
      method: "get",
      path: "/probe",
      handler: (_req, res) => ok(res, probeResult(app, pluginVersion, shapeWarnings)),
    },

    // Command palette — core Obsidian, fully implemented.
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

    // Dataview.
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
        const r = await dv.evaluate(str(b, "expression") ?? "", str(b, "path"));
        if (!r.successful) return fail(res, "dql_error", r.error ?? "evaluation failed");
        ok(res, { value: r.value, type: typeof r.value });
      },
    },

    // QuickAdd.
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

    // OCR / Text Extractor.
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
        const paths = Array.isArray(raw) ? (raw as string[]) : [];
        const start = Date.now();
        const results: { path: string; ok: boolean; text?: string; error?: string }[] = [];
        for (const rel of paths) {
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

    // Excalidraw — read returns raw scene text; write scaffolds/updates the note file.
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
        if (b.mode === "create" && existing && b.overwrite !== true)
          return fail(res, "note_exists", "drawing already exists", { path: rel });
        // The companion persists the file; rich element merging is performed by the
        // Excalidraw plugin when the note is next opened. Verified live.
        const scaffold = "---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n";
        if (existing) await app.vault.modify(existing, scaffold);
        else await app.vault.create(normalizePath(rel), scaffold);
        ok(res, { path: rel, plugin_used: true });
      },
    },

    // make.md.
    {
      method: "post",
      path: "/makemd/spaces",
      handler: (_req, res) => {
        const api = requireApi<{ spaces?: () => unknown[] }>(app, res, "make-md");
        if (!api) return;
        ok(res, { spaces: typeof api.spaces === "function" ? api.spaces() : [] });
      },
    },
    {
      method: "post",
      path: "/makemd/query",
      handler: (req, res) => {
        const api = requireApi<{ query?: (id: string, filter?: unknown) => unknown }>(
          app,
          res,
          "make-md",
        );
        if (!api) return;
        if (!api.query)
          return fail(res, "plugin_unreachable", "make-md query API unavailable", {
            plugin: "make-md",
          });
        const b = body(req);
        const items = api.query(str(b, "space_id") ?? "", b.filter);
        ok(res, {
          items: Array.isArray(items) ? items : [],
          total: Array.isArray(items) ? items.length : 0,
        });
      },
    },

    // Templater — expansion is performed by the plugin; verified live.
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

    // Tasks — the Tasks plugin exposes no stable programmatic filter API, so the DSL
    // filter degrades honestly; list_tasks/update_task (server, filesystem) cover the
    // rest without the plugin.
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
