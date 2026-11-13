// Route registration lifecycle against the Local REST API extension surface. The fake LRA below
// reproduces LRA 5.x's registerApiExtension: a second getPublicApi() for the same manifest id
// returns the EXISTING handle (and its router) until that handle is unregister()ed. Without
// releasing, a reload of TC Bridge appends a second copy of every route behind the first, and the
// first copy (the old code) keeps answering.
import { describe, expect, it } from "vitest";
import { BRIDGE_PREFIX, registerBridgeRoutes } from "../src/registration";
import type { RouteDef } from "../src/routes/types";

const MANIFEST = { id: "tc-bridge", name: "TC Bridge", version: "2.0.2" } as never;

function routes(tag: string): RouteDef[] {
  return [
    { method: "get", path: "/probe", handler: () => tag as never },
    { method: "post", path: "/commands/list", handler: () => tag as never },
  ];
}

interface Mounted {
  path: string;
  method: string;
  handler: RouteDef["handler"];
}

/** LRA 5.x public-API host: one live handle per manifest id, first-registered route wins. */
function fakePublicApiLra(opts: { throwOnGet?: boolean } = {}) {
  const live = new Map<string, { mounted: Mounted[] }>();
  const routers: { mounted: Mounted[] }[] = [];
  let created = 0;
  return {
    get created() {
      return created;
    },
    /** What a request would hit: the first matching route across mounted routers. */
    resolve(method: string, path: string): RouteDef["handler"] | undefined {
      for (const r of routers) {
        const hit = r.mounted.find((m) => m.method === method && m.path === path);
        if (hit) return hit.handler;
      }
      return undefined;
    },
    countMounted(): number {
      return routers.reduce((n, r) => n + r.mounted.length, 0);
    },
    // A legacy router is present on LRA 5.x as well; registration must not fall back to it.
    requestHandler: { apiExtensionRouter: { get() {}, post() {} } },
    getPublicApi(manifest: { id: string }) {
      if (opts.throwOnGet) throw new Error("settings not loaded");
      const existing = live.get(manifest.id);
      if (existing) return (existing as unknown as { handle: unknown }).handle;
      created++;
      const router = { mounted: [] as Mounted[] };
      routers.push(router);
      const handle = {
        apiVersion: 4,
        addRoute(path: string) {
          const b = {
            get(h: RouteDef["handler"]) {
              router.mounted.push({ path, method: "get", handler: h });
              return b;
            },
            post(h: RouteDef["handler"]) {
              router.mounted.push({ path, method: "post", handler: h });
              return b;
            },
          };
          return b;
        },
        unregister() {
          live.delete(manifest.id);
          routers.splice(routers.indexOf(router), 1);
        },
      };
      live.set(manifest.id, Object.assign(router, { handle }));
      return handle;
    },
  };
}

describe("registerBridgeRoutes — LRA public API (5.x)", () => {
  it("mounts every route under the bridge prefix and release() unregisters them", () => {
    const lra = fakePublicApiLra();
    const reg = registerBridgeRoutes(lra as never, MANIFEST, routes("v1"));
    expect(reg?.count).toBe(2);
    expect(reg?.via).toBe("public-api");
    expect(lra.resolve("get", `${BRIDGE_PREFIX}/probe`)).toBeDefined();
    reg?.release();
    expect(lra.countMounted()).toBe(0);
  });

  it("a reload after release() serves the NEW handlers, not the old ones", () => {
    const lra = fakePublicApiLra();
    registerBridgeRoutes(lra as never, MANIFEST, routes("old"))?.release();
    registerBridgeRoutes(lra as never, MANIFEST, routes("new"));
    expect(lra.resolve("get", `${BRIDGE_PREFIX}/probe`)?.({}, {} as never)).toBe("new");
    expect(lra.countMounted()).toBe(2);
  });

  it("clears a registration an older build left behind (no release on unload)", () => {
    const lra = fakePublicApiLra();
    // 1.34.0 / 2.0.1 never called unregister(): its handle is still live in LRA.
    registerBridgeRoutes(lra as never, MANIFEST, routes("stale"));
    registerBridgeRoutes(lra as never, MANIFEST, routes("new"));
    expect(lra.resolve("get", `${BRIDGE_PREFIX}/probe`)?.({}, {} as never)).toBe("new");
    expect(lra.countMounted()).toBe(2);
  });

  it("returns null when getPublicApi throws, without falling back to the legacy router", () => {
    const lra = fakePublicApiLra({ throwOnGet: true });
    expect(registerBridgeRoutes(lra as never, MANIFEST, routes("v1"))).toBeNull();
  });

  it("returns null when Local REST API is not loaded", () => {
    expect(registerBridgeRoutes(undefined, MANIFEST, routes("v1"))).toBeNull();
  });
});

describe("registerBridgeRoutes — legacy LRA shapes", () => {
  it("express extension router: mounts with the prefix and release() removes only our layers", () => {
    const foreign = () => undefined;
    const stack: { route?: { path: string; stack: { handle: unknown }[] } }[] = [
      { route: { path: "/other", stack: [{ handle: foreign }] } },
    ];
    const mount = (path: string, h: unknown) =>
      stack.push({ route: { path, stack: [{ handle: h }] } });
    const lra = { requestHandler: { apiExtensionRouter: { get: mount, post: mount, stack } } };
    const reg = registerBridgeRoutes(lra as never, MANIFEST, routes("v1"));
    expect(reg?.via).toBe("extension-router");
    expect(stack.map((l) => l.route?.path)).toEqual([
      "/other",
      `${BRIDGE_PREFIX}/probe`,
      `${BRIDGE_PREFIX}/commands/list`,
    ]);
    reg?.release();
    expect(stack.map((l) => l.route?.path)).toEqual(["/other"]);
  });

  it("express extension router: releasing an older registration leaves a newer one that reuses the same handlers", () => {
    const stack: { route?: { path: string; stack: { handle: unknown }[] } }[] = [];
    const mount = (path: string, h: unknown) =>
      stack.push({ route: { path, stack: [{ handle: h }] } });
    const lra = { requestHandler: { apiExtensionRouter: { get: mount, post: mount, stack } } };
    const shared = routes("v1");
    const older = registerBridgeRoutes(lra as never, MANIFEST, shared);
    registerBridgeRoutes(lra as never, MANIFEST, shared);
    older?.release();
    expect(stack).toHaveLength(2);
  });

  it("addRoute builder: mounts with the prefix, calling addRoute on its own object", () => {
    const paths: string[] = [];
    const builder = { get: () => builder, post: () => builder };
    const lra = {
      api: {
        paths,
        // A method that needs its receiver, as a class method on LRA's api object would.
        addRoute(this: { paths: string[] }, p: string) {
          this.paths.push(p);
          return builder;
        },
      },
    };
    const reg = registerBridgeRoutes(lra as never, MANIFEST, routes("v1"));
    expect(reg?.via).toBe("add-route");
    expect(paths).toEqual([`${BRIDGE_PREFIX}/probe`, `${BRIDGE_PREFIX}/commands/list`]);
    expect(() => reg?.release()).not.toThrow();
  });
});
