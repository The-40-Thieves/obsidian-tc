// obsidian-tc companion plugin entry point (THE-180, G2.2 §3.1). It does NOT open a
// port of its own: it attaches the /obsidian-tc/v1/* bridge routes onto the Local
// REST API plugin's HTTP server, reusing that plugin's TLS + bearer-token auth (the
// shared key the MCP server reads from config/env). If Local REST API is absent or
// exposes no extension surface, the routes are simply not registered — the server's
// probe then reports the companion unreachable and every bridge tool degrades. The
// plugin holds no secrets and logs none.
import { Plugin, type PluginManifest } from "obsidian";
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
  plugins?: { plugins: Record<string, LocalRestApiPlugin | undefined> };
}

export default class ObsidianTcCompanion extends Plugin {
  override async onload(): Promise<void> {
    // THE-282: startup shape self-check over the Obsidian internals this plugin duck-types.
    // A failed check degrades honestly (one console.warn + surfaced on /probe) instead of
    // throwing route-level TypeErrors when internals move between Obsidian versions.
    const shapeWarnings: string[] = [];
    const anyApp = this.app as unknown as {
      commands?: { listCommands?: unknown };
      plugins?: { plugins?: unknown };
    };
    if (typeof anyApp.commands?.listCommands !== "function")
      shapeWarnings.push("app.commands.listCommands is not a function");
    if (typeof anyApp.plugins?.plugins !== "object" || anyApp.plugins?.plugins === null)
      shapeWarnings.push("app.plugins.plugins is not an object");
    const routes = buildRoutes(this.app, this.manifest.version, shapeWarnings);
    const count = this.registerBridgeRoutes(routes);
    if (count === null) {
      // NOTE: when registration fails, /probe was never attached either — console is the only
      // surface for this failure mode (documented, THE-282).
      console.warn(
        "[obsidian-tc] Local REST API plugin not found (or no extension API); bridge routes not registered. Install/enable the Local REST API plugin.",
      );
    } else {
      if (shapeWarnings.length)
        console.warn(
          `[obsidian-tc] degraded: ${shapeWarnings.join("; ")} — Obsidian internals may have moved; some bridges will degrade.`,
        );
      console.info(`[obsidian-tc] registered ${count} bridge routes under /obsidian-tc/v1`);
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
