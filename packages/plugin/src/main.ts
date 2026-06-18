// obsidian-tc companion plugin entry point (THE-180, G2.2 §3.1). It does NOT open a
// port of its own: it attaches the /obsidian-tc/v1/* bridge routes onto the Local
// REST API plugin's HTTP server, reusing that plugin's TLS + bearer-token auth (the
// shared key the MCP server reads from config/env). If Local REST API is absent or
// exposes no extension surface, the routes are simply not registered — the server's
// probe then reports the companion unreachable and every bridge tool degrades. The
// plugin holds no secrets and logs none.
import { Plugin } from "obsidian";
import { type RouteDef, buildRoutes } from "./routes";

const LRA_ID = "obsidian-local-rest-api";

// Minimal models of the Local REST API extension surface (not in obsidian's d.ts).
// Two shapes are supported: the express extension router exposed on requestHandler,
// and the newer public addRoute() builder. We try them in that order.
interface ExtensionRouter {
  get(path: string, handler: RouteDef["handler"]): void;
  post(path: string, handler: RouteDef["handler"]): void;
}
interface AddRouteBuilder {
  get(handler: RouteDef["handler"]): AddRouteBuilder;
  post(handler: RouteDef["handler"]): AddRouteBuilder;
}
interface LocalRestApiPlugin {
  requestHandler?: { apiExtensionRouter?: ExtensionRouter };
  api?: { addRoute?(path: string): AddRouteBuilder };
}
interface AppWithPlugins {
  plugins?: { plugins: Record<string, LocalRestApiPlugin | undefined> };
}

export default class ObsidianTcCompanion extends Plugin {
  override async onload(): Promise<void> {
    const routes = buildRoutes(this.app, this.manifest.version);
    const count = this.registerBridgeRoutes(routes);
    if (count === null) {
      console.warn(
        "[obsidian-tc] Local REST API plugin not found (or no extension API); bridge routes not registered. Install/enable the Local REST API plugin.",
      );
    } else {
      console.info(`[obsidian-tc] registered ${count} bridge routes under /obsidian-tc/v1`);
    }
  }

  /** Attach the bridge routes to Local REST API. Returns the count, or null if LRA
   *  is unavailable / exposes no extension surface. */
  private registerBridgeRoutes(routes: RouteDef[]): number | null {
    const lra = (this.app as unknown as AppWithPlugins).plugins?.plugins?.[LRA_ID];
    if (!lra) return null;

    const router = lra.requestHandler?.apiExtensionRouter;
    if (router) {
      for (const r of routes) router[r.method](r.path, r.handler);
      return routes.length;
    }

    const addRoute = lra.api?.addRoute;
    if (addRoute) {
      for (const r of routes) addRoute.call(lra.api, r.path)[r.method](r.handler);
      return routes.length;
    }

    return null;
  }
}
