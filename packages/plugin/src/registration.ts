// Attaching (and releasing) the bridge routes on the Local REST API plugin. Kept free of value
// imports from `obsidian` so it runs under vitest; main.ts is the thin Plugin subclass that calls it.
//
// Lifecycle rules, all against LRA's extension surface:
//   - release() undoes the registration. main.ts calls it from onunload, so a reload or an in-place
//     update does not leave the old handlers mounted in front of the new ones.
//   - LRA 5.x hands back the EXISTING handle for a manifest id until that handle is unregistered.
//     Builds before this one never unregistered, so registration first releases whatever handle LRA
//     returns and then takes a fresh one: the routes mounted are always this build's.
//   - When LRA exposes getPublicApi but it throws (called before LRA finished loading), this
//     returns null rather than mounting on the legacy router; main.ts retries on LRA's loaded event.
import type { PluginManifest } from "obsidian";
import type { RouteDef } from "./routes/types";

/** The bridge route prefix. Part of the wire protocol: the server's DEFAULT_API_PREFIX. */
export const BRIDGE_PREFIX = "/obsidian-tc/v1";

type Handler = RouteDef["handler"];

interface AddRouteBuilder {
  get(handler: Handler): AddRouteBuilder;
  post(handler: Handler): AddRouteBuilder;
}
interface PublicApiHandle {
  addRoute(path: string): AddRouteBuilder;
  unregister?(): void;
}
type ExpressLayer = object;
interface ExtensionRouter {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
  stack?: ExpressLayer[];
}

/** The Local REST API plugin instance, duck-typed across the three extension shapes it has had. */
export interface LocalRestApiPlugin {
  getPublicApi?(manifest: PluginManifest): PublicApiHandle;
  requestHandler?: { apiExtensionRouter?: ExtensionRouter };
  api?: { addRoute?(path: string): AddRouteBuilder };
}

export interface BridgeRegistration {
  count: number;
  via: "public-api" | "extension-router" | "add-route";
  /** Remove every route this registration mounted (best effort on the legacy addRoute shape). */
  release(): void;
}

function acquirePublicApi(
  lra: LocalRestApiPlugin,
  manifest: PluginManifest,
): PublicApiHandle | null {
  try {
    const first = lra.getPublicApi?.(manifest);
    if (!first) return null;
    if (typeof first.unregister !== "function") return first;
    first.unregister();
    return lra.getPublicApi?.(manifest) ?? null;
  } catch {
    return null;
  }
}

export function registerBridgeRoutes(
  lra: LocalRestApiPlugin | undefined,
  manifest: PluginManifest,
  routes: RouteDef[],
): BridgeRegistration | null {
  if (!lra) return null;

  if (typeof lra.getPublicApi === "function") {
    const api = acquirePublicApi(lra, manifest);
    if (!api) return null;
    for (const r of routes) api.addRoute(BRIDGE_PREFIX + r.path)[r.method](r.handler);
    return { count: routes.length, via: "public-api", release: () => api.unregister?.() };
  }

  const router = lra.requestHandler?.apiExtensionRouter;
  if (router) {
    // Remember the exact layers this call mounted, so release() cannot touch a later registration
    // that reuses the same handler functions.
    const before = new Set(router.stack ?? []);
    for (const r of routes) router[r.method](BRIDGE_PREFIX + r.path, r.handler);
    const mounted = new Set((router.stack ?? []).filter((layer) => !before.has(layer)));
    return {
      count: routes.length,
      via: "extension-router",
      release: () => {
        const stack = router.stack;
        if (!stack) return;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (mounted.has(stack[i] as ExpressLayer)) stack.splice(i, 1);
        }
      },
    };
  }

  const api = lra.api;
  if (typeof api?.addRoute === "function") {
    for (const r of routes) api.addRoute(BRIDGE_PREFIX + r.path)[r.method](r.handler);
    // The legacy builder offers no removal; a restart of Obsidian clears it.
    return { count: routes.length, via: "add-route", release: () => {} };
  }

  return null;
}
