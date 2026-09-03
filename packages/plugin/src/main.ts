// TC Bridge (id tc-bridge, formerly obsidian-tc / "Obsidian Turbocharged" — renamed THE-943 so
// the plugin can list in the community directory, whose rules ban "obsidian" in a plugin id) —
// companion plugin entry point (THE-180, G2.2 §3.1). It does NOT open a port of its own: it
// attaches the /obsidian-tc/v1/* bridge routes onto the Local REST API plugin's HTTP server,
// reusing that plugin's TLS + bearer-token auth (the shared key the MCP server reads from
// config/env). If Local REST API is absent or exposes no extension surface, the routes are simply
// not registered — the server's probe then reports the companion unreachable and every bridge
// tool degrades. The plugin holds no secrets and logs none.
//
// NOTE: the bridge route prefix (/obsidian-tc/v1, below) is the SERVER's DEFAULT_API_PREFIX
// (packages/server) and is NOT part of the Obsidian manifest id/name the rename covers — changing
// it is a server-side wire-protocol change out of THE-943's scope, not a leftover.
import { Notice, Plugin, type PluginManifest } from "obsidian";
import { OLD_PLUGIN_ID, runMigrationAndConflictGuard } from "./migration";
import { buildRoutes, type RouteDef } from "./routes";

const LRA_ID = "obsidian-local-rest-api";

// Minimal models of the Local REST API extension surface (not in obsidian's d.ts).
// Three shapes are supported, tried in order: the current getPublicApi(manifest)
// extension object (LRA v4.x), the legacy express extension router on requestHandler,
// and the legacy public addRoute() builder.
interface ExtensionRouter {
  get(path: string, handler: RouteDef["handler"]): void;
  post(path: string, handler: RouteDef["handler"]): void;
}
interface AddRouteBuilder {
  get(handler: RouteDef["handler"]): AddRouteBuilder;
  post(handler: RouteDef["handler"]): AddRouteBuilder;
}
// The public extension object returned by LRA v4.x's plugin.getPublicApi(manifest).
interface LocalRestApiPublicApi {
  addRoute(path: string): AddRouteBuilder;
}
interface LocalRestApiPlugin {
  // Current LRA (v4.x): documented integration point. Older builds expose one of the two below.
  getPublicApi?(manifest: PluginManifest): LocalRestApiPublicApi;
  requestHandler?: { apiExtensionRouter?: ExtensionRouter };
  api?: { addRoute?(path: string): AddRouteBuilder };
}
interface AppWithPlugins {
  plugins?: {
    plugins: Record<string, LocalRestApiPlugin | undefined>;
    // Undocumented Obsidian internal (not in the public d.ts, same as `plugins.plugins` above):
    // the set of currently-ENABLED plugin ids, keyed the same as `plugins.plugins`. Used only by
    // the conflict guard (THE-943) to detect the old `obsidian-tc` id still running alongside
    // this one. Duck-typed with the same fail-open posture as the rest of this file: if the shape
    // has moved, isOldPluginEnabled() below reports "not enabled" rather than blocking startup.
    enabledPlugins?: { has(id: string): boolean };
  };
}

export default class TcBridge extends Plugin {
  override async onload(): Promise<void> {
    // THE-282: startup shape self-check over the Obsidian internals this plugin duck-types.
    // A failed check degrades honestly (one console.warn + surfaced on /probe) instead of
    // throwing route-level TypeErrors when internals move between Obsidian versions.
    const shapeWarnings: string[] = [];
    const anyApp = this.app as unknown as {
      commands?: { listCommands?: unknown };
      plugins?: { plugins?: unknown; enabledPlugins?: unknown };
    };
    if (typeof anyApp.commands?.listCommands !== "function")
      shapeWarnings.push("app.commands.listCommands is not a function");
    if (typeof anyApp.plugins?.plugins !== "object" || anyApp.plugins?.plugins === null)
      shapeWarnings.push("app.plugins.plugins is not an object");
    const enabledPluginsOk =
      typeof (anyApp.plugins?.enabledPlugins as { has?: unknown } | undefined)?.has === "function";
    if (!enabledPluginsOk) shapeWarnings.push("app.plugins.enabledPlugins is not a Set-like");

    // THE-943: rename settings migration + old-id conflict guard. Runs before route registration
    // so a detected conflict never registers duplicate bridge routes.
    const proceed = await runMigrationAndConflictGuard({
      adapter: this.app.vault.adapter,
      configDir: this.app.vault.configDir,
      pluginDir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
      notice: (message) => new Notice(message, 0),
      isOldPluginEnabled: () =>
        enabledPluginsOk &&
        ((this.app as unknown as AppWithPlugins).plugins?.enabledPlugins?.has(OLD_PLUGIN_ID) ??
          false),
    });
    if (!proceed) return;

    const routes = buildRoutes(this.app, this.manifest.version, shapeWarnings);
    const count = this.registerBridgeRoutes(routes);
    if (count === null) {
      // NOTE: when registration fails, /probe was never attached either — console is the only
      // surface for this failure mode (documented, THE-282).
      console.warn(
        "[tc-bridge] Local REST API plugin not found (or no extension API); bridge routes not registered. Install/enable the Local REST API plugin.",
      );
    } else {
      if (shapeWarnings.length)
        console.warn(
          `[tc-bridge] degraded: ${shapeWarnings.join("; ")} — Obsidian internals may have moved; some bridges will degrade.`,
        );
      console.info(`[tc-bridge] registered ${count} bridge routes under /obsidian-tc/v1`);
    }
  }

  /** Attach the bridge routes to Local REST API. Returns the count, or null if LRA
   *  is unavailable / exposes no extension surface. */
  private registerBridgeRoutes(routes: RouteDef[]): number | null {
    const lra = (this.app as unknown as AppWithPlugins).plugins?.plugins?.[LRA_ID];
    if (!lra) return null;

    // Namespace every bridge route under the prefix the server actually requests
    // (packages/server DEFAULT_API_PREFIX). LRA mounts extension routers at its own
    // root, so without this the routes land at "/" and every server call 404s.
    const PREFIX = "/obsidian-tc/v1";

    // Current LRA (v4.x): the documented integration point is plugin.getPublicApi(manifest),
    // which returns an extension object exposing addRoute(). Neither legacy shape below
    // exists on this build. getPublicApi() can throw if called before LRA finishes
    // loadSettings() (upstream load-order race), so degrade honestly rather than throw.
    let publicApi: LocalRestApiPublicApi | undefined;
    try {
      publicApi = lra.getPublicApi?.(this.manifest);
    } catch {
      publicApi = undefined;
    }
    if (publicApi) {
      for (const r of routes) publicApi.addRoute(PREFIX + r.path)[r.method](r.handler);
      return routes.length;
    }

    // Legacy express extension router (older LRA).
    const router = lra.requestHandler?.apiExtensionRouter;
    if (router) {
      for (const r of routes) router[r.method](PREFIX + r.path, r.handler);
      return routes.length;
    }

    // Legacy public addRoute() builder (older LRA).
    const addRoute = lra.api?.addRoute;
    if (addRoute) {
      for (const r of routes) addRoute.call(lra.api, PREFIX + r.path)[r.method](r.handler);
      return routes.length;
    }

    return null;
  }
}
