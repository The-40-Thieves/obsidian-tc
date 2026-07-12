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
import { type App, apiVersion, moment, normalizePath, type TFile } from "obsidian";

/** Bridge protocol version reported by /probe (matches the server's expectation). */
const API_VERSION = "1";

// Obsidian re-exports moment.js at runtime but its bundled d.ts types the export without a
// call signature; alias to a minimal callable to construct dates for the daily-notes bridge.
type MomentLike = { isValid(): boolean; format(fmt: string): string };
const makeMoment = moment as unknown as (input?: string) => MomentLike;

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
  omnisearch: "omnisearch",
  datacore: "datacore",
  "metadata-menu": "metadata-menu",
  git: "obsidian-git",
  "remotely-save": "remotely-save",
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
// Core (internal) plugins live under app.internalPlugins, separate from community plugins.
interface InternalPluginLite {
  enabled?: boolean;
  instance?: { options?: Record<string, unknown> };
}
type InternalApp = App & {
  plugins?: PluginRegistry;
  commands?: CommandsRegistry;
  internalPlugins?: { plugins?: Record<string, InternalPluginLite | undefined> };
};

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

// A handler that throws (or rejects) must still answer: LRA's express router does not
// catch async rejections, so an unanswered request hangs the bridge client until its
// timeout and surfaces as a cause-less plugin_unreachable. Every registered handler is
// wrapped at buildRoutes' boundary.
const safeHandler = (h: RouteHandler): RouteHandler => {
  return async (req, res) => {
    try {
      await h(req, res);
    } catch (e) {
      try {
        fail(res, "bridge_error", e instanceof Error ? e.message : String(e));
      } catch {
        // response already committed — nothing more to send
      }
    }
  };
};

const body = (req: BridgeReq): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
const str = (o: Record<string, unknown>, k: string): string | undefined =>
  typeof o[k] === "string" ? (o[k] as string) : undefined;

function communityPlugin(app: InternalApp, capKey: string): CommunityPlugin | undefined {
  const id = CAP_IDS[capKey];
  return id ? app.plugins?.plugins?.[id] : undefined;
}

/** Access a core (internal) plugin by id, e.g. "daily-notes". */
function internalPlugin(app: InternalApp, id: string): InternalPluginLite | undefined {
  return app.internalPlugins?.plugins?.[id];
}

// Duck-typed view of obsidian-git's gitManager (THE-378) — it exposes no stable `api`, so
// every method is probed before use and absence degrades, never throws.
interface GitManagerLite {
  status?: () => Promise<unknown>;
  getDiffString?: (path: string, staged?: boolean) => Promise<unknown>;
  log?: (file: undefined, relativeToVault: boolean, limit: number) => Promise<unknown>;
  stage?: (path: string, relativeToVault: boolean) => Promise<unknown>;
  commit?: (opts: { message: string }) => Promise<unknown>;
}

/** Resolve obsidian-git's gitManager, mapping absence onto the error taxonomy. */
function gitManagerOf(app: InternalApp, res: BridgeRes): GitManagerLite | null {
  const plugin = communityPlugin(app, "git") as
    | (CommunityPlugin & { gitManager?: GitManagerLite })
    | undefined;
  if (!plugin) {
    fail(res, "plugin_missing", "obsidian-git is not installed", { plugin: "git" });
    return null;
  }
  if (!plugin.gitManager) {
    fail(res, "plugin_unreachable", "obsidian-git exposes no gitManager", { plugin: "git" });
    return null;
  }
  return plugin.gitManager;
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
  // evaluate() takes a variable-context OBJECT — not a file path; page(path) builds the
  // per-note context so `file.*` and frontmatter fields resolve inside the expression.
  evaluate?(
    expr: string,
    context?: Record<string, unknown>,
  ): Promise<DataviewEvalResult> | DataviewEvalResult;
  page?(path: string): Record<string, unknown> | undefined;
}

// --- QuickAdd / Text Extractor adapters --------------------------------------------
interface QuickAddApi {
  executeChoice?(name: string, vars?: Record<string, unknown>): Promise<unknown>;
}
interface TextExtractorApi {
  extractText?(file: TFile): Promise<string>;
  isInCache?(file: TFile): Promise<boolean>;
}

// --- Omnisearch adapter. Public API at plugin.api: search(query) -> ranked
// ResultNoteApi[] ({score, path, basename, foundWords, matches:{match,offset}[],
// excerpt}). Read-only; no vault mutation.
interface OmnisearchMatchApi {
  match: string;
  offset: number;
}
interface OmnisearchResultApi {
  score: number;
  path: string;
  basename: string;
  excerpt: string;
  foundWords?: string[];
  matches?: OmnisearchMatchApi[];
}
interface OmnisearchApi {
  search?(query: string): Promise<OmnisearchResultApi[]>;
}

// --- Datacore adapter. Public API at plugin.api (DatacoreApi): tryQuery(q) ->
// Result<Indexable[], string> ({successful, value?, error?}) using datacore's own
// query language (e.g. "@page and #tag"). Result objects expose
// $path/$name/$tags/$types/$frontmatter. Read-only.
interface DatacoreObject {
  $path?: string;
  $name?: string;
  $tags?: string[];
  $types?: string[];
  $frontmatter?: Record<string, unknown>;
}
interface DatacoreApi {
  tryQuery?(query: string): unknown;
}

// --- Metadata Menu adapter. Public API at plugin.api (IMetadataMenuApi):
// namedFileFields(file) -> Promise<Record<fieldName, IFieldInfo{value, type, isValid,
// sourceType}>>. Read-only field introspection.
interface MetadataMenuFieldInfo {
  value?: unknown;
  type?: unknown;
  isValid?: unknown;
  sourceType?: unknown;
}
interface MetadataMenuApi {
  namedFileFields?(file: TFile | string): Promise<Record<string, MetadataMenuFieldInfo>>;
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
  const defs: RouteDef[] = [
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

    // Obsidian Git (THE-378). The git plugin exposes no stable `api`; we duck-type its
    // gitManager defensively and map any shape miss onto plugin_unreachable. Every git
    // operation is wrapped so a git failure comes back as git_error, never a 500.
    {
      method: "post",
      path: "/git/status",
      handler: async (_req, res) => {
        const gm = gitManagerOf(app, res);
        if (!gm) return;
        if (typeof gm.status !== "function")
          return fail(res, "plugin_unreachable", "obsidian-git exposes no status()", {
            plugin: "git",
          });
        try {
          const s = (await gm.status()) as {
            changed?: Array<{ path?: string; working_dir?: string; index?: string }>;
            staged?: Array<{ path?: string; index?: string }>;
            conflicted?: string[];
          };
          ok(res, {
            changed: (s.changed ?? []).map((f) => ({
              path: f.path ?? "",
              working_dir: f.working_dir ?? "",
              index: f.index ?? "",
            })),
            staged: (s.staged ?? []).map((f) => ({ path: f.path ?? "", index: f.index ?? "" })),
            conflicted: s.conflicted ?? [],
          });
        } catch (e) {
          fail(res, "git_error", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "post",
      path: "/git/diff",
      handler: async (req, res) => {
        const gm = gitManagerOf(app, res);
        if (!gm) return;
        if (typeof gm.getDiffString !== "function")
          return fail(res, "plugin_unreachable", "obsidian-git exposes no getDiffString()", {
            plugin: "git",
          });
        const path = str(body(req), "path");
        if (!path) return fail(res, "invalid_input", "path is required");
        const staged = body(req).staged === true;
        try {
          const diff = await gm.getDiffString(path, staged);
          ok(res, { diff: typeof diff === "string" ? diff : "" });
        } catch (e) {
          fail(res, "git_error", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "post",
      path: "/git/log",
      handler: async (req, res) => {
        const gm = gitManagerOf(app, res);
        if (!gm) return;
        if (typeof gm.log !== "function")
          return fail(res, "plugin_unreachable", "obsidian-git exposes no log()", {
            plugin: "git",
          });
        const rawLimit = Number(body(req).limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
        try {
          const entries = (await gm.log(undefined, false, limit)) as Array<{
            hash?: string;
            message?: string;
            date?: string;
            author?: { name?: string } | string;
          }>;
          ok(res, {
            entries: (entries ?? []).map((e) => ({
              hash: e.hash ?? "",
              message: e.message ?? "",
              date: e.date ?? "",
              author: typeof e.author === "string" ? e.author : (e.author?.name ?? ""),
            })),
          });
        } catch (e) {
          fail(res, "git_error", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "post",
      path: "/git/stage",
      handler: async (req, res) => {
        const gm = gitManagerOf(app, res);
        if (!gm) return;
        if (typeof gm.stage !== "function")
          return fail(res, "plugin_unreachable", "obsidian-git exposes no stage()", {
            plugin: "git",
          });
        const paths = body(req).paths;
        if (
          !Array.isArray(paths) ||
          paths.length === 0 ||
          !paths.every((p) => typeof p === "string")
        )
          return fail(res, "invalid_input", "paths must be a non-empty string array");
        try {
          for (const p of paths as string[]) await gm.stage(p, true);
          ok(res, { staged: paths.length });
        } catch (e) {
          fail(res, "git_error", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "post",
      path: "/git/commit",
      handler: async (req, res) => {
        const gm = gitManagerOf(app, res);
        if (!gm) return;
        if (typeof gm.commit !== "function")
          return fail(res, "plugin_unreachable", "obsidian-git exposes no commit()", {
            plugin: "git",
          });
        const message = str(body(req), "message");
        if (!message) return fail(res, "invalid_input", "message is required");
        try {
          const committed = await gm.commit({ message });
          ok(res, {
            committed: typeof committed === "number" ? committed : null,
            fired_at: new Date().toISOString(),
          });
        } catch (e) {
          fail(res, "git_error", e instanceof Error ? e.message : String(e));
        }
      },
    },

    // Remotely Save (THE-381): an independent backup-verification signal. Status duck-types
    // the plugin's fields; trigger fires the public start-sync command.
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
        const path = str(b, "path");
        let context: Record<string, unknown> | undefined;
        if (path) {
          const page = dv.page?.(path);
          if (!page)
            return fail(res, "note_not_found", `dataview has no indexed page for: ${path}`);
          context = page;
        }
        try {
          const r = await dv.evaluate(str(b, "expression") ?? "", context);
          if (!r.successful) return fail(res, "dql_error", r.error ?? "evaluation failed");
          ok(res, { value: r.value, type: typeof r.value });
        } catch (e) {
          fail(res, "dql_error", e instanceof Error ? e.message : String(e));
        }
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

    // Omnisearch — ranked full-text search via the plugin's public search() API.
    {
      method: "post",
      path: "/omnisearch/search",
      handler: async (req, res) => {
        const api = requireApi<OmnisearchApi>(app, res, "omnisearch");
        if (!api) return;
        if (!api.search)
          return fail(res, "plugin_unreachable", "omnisearch search API unavailable", {
            plugin: "omnisearch",
          });
        const b = body(req);
        const query = str(b, "query") ?? "";
        if (!query) return fail(res, "invalid_input", "query is required");
        const raw = await api.search(query);
        const limit = typeof b.limit === "number" && b.limit > 0 ? b.limit : undefined;
        const sliced = limit ? raw.slice(0, limit) : raw;
        const items = sliced.map((r) => ({
          path: r.path,
          basename: r.basename,
          score: r.score,
          excerpt: r.excerpt,
          found_words: r.foundWords ?? [],
          matches: (r.matches ?? []).map((m) => ({ match: m.match, offset: m.offset })),
        }));
        ok(res, { items, total: items.length, query });
      },
    },

    // Datacore — query via the Datacore plugin's own query language (Dataview's successor).
    {
      method: "post",
      path: "/datacore/query",
      handler: async (req, res) => {
        const api = requireApi<DatacoreApi>(app, res, "datacore");
        if (!api) return;
        if (!api.tryQuery)
          return fail(res, "plugin_unreachable", "datacore query API unavailable", {
            plugin: "datacore",
          });
        const b = body(req);
        const q = str(b, "query") ?? "";
        if (!q) return fail(res, "invalid_input", "query is required");
        const rRaw = await api.tryQuery(q);
        const r = rRaw as { successful?: boolean; value?: unknown; error?: unknown } | undefined;
        if (r && r.successful === false)
          return fail(res, "dql_error", String(r.error ?? "datacore query failed"));
        const rows: DatacoreObject[] = Array.isArray(r?.value)
          ? (r.value as DatacoreObject[])
          : Array.isArray(rRaw)
            ? (rRaw as DatacoreObject[])
            : [];
        const limit = typeof b.limit === "number" && b.limit > 0 ? b.limit : undefined;
        const sliced = limit ? rows.slice(0, limit) : rows;
        const plain = (val: unknown): unknown => {
          if (val === null || val === undefined) return val;
          const t = typeof val;
          if (t === "string" || t === "number" || t === "boolean") return val;
          if (Array.isArray(val)) return val.map(plain);
          if (t === "object") {
            const o = val as Record<string, unknown>;
            if ("value" in o) return plain(o.value);
            return String(val);
          }
          return String(val);
        };
        const items = sliced.map((o) => ({
          path: o?.$path,
          name: o?.$name,
          tags: o?.$tags ?? [],
          types: o?.$types ?? [],
          fields:
            o?.$frontmatter && typeof o.$frontmatter === "object"
              ? Object.fromEntries(
                  Object.entries(o.$frontmatter).map(([k, val]) => [k, plain(val)]),
                )
              : {},
        }));
        ok(res, { items, total: items.length, query: q });
      },
    },

    // Metadata Menu — read a note's typed fields (name -> value/type/validity/source).
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

    // Daily Notes (core) — resolve the daily note for a date via the plugin's folder+format.
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
  return defs.map((d) => ({ ...d, handler: safeHandler(d.handler) }));
}
