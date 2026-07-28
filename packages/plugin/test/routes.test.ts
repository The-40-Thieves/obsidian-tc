// First tests in packages/plugin. The package had ZERO despite src/routes.ts being 953 lines and
// one of the largest files in the repo — TREE.md records that it was invisible to the module map
// as well, so nothing was looking at it from any direction.
//
// The reason it had none is mechanical, not cultural: routes.ts imports `obsidian`, a package that
// only functions inside the Obsidian runtime, so a test importing it failed at module load before
// any assertion could run. vitest.config.ts aliases that import to test/__mocks__/obsidian.ts,
// which is what makes any of this possible.
//
// The load-bearing test here is `every handler answers, even when the app throws`. routes.ts:98
// documents why safeHandler exists — "LRA's express router does not catch async rejections, so an
// unanswered request hangs the bridge client until its timeout and surfaces as a cause-less
// plugin_unreachable" — and routes.ts:952 applies it to the whole table in one `.map`. That is
// exactly the kind of invariant that holds until someone adds a route and returns early, so it is
// asserted over EVERY route rather than a sampled few.
import { describe, expect, it } from "vitest";
import { type BridgeReq, type BridgeRes, buildRoutes, type RouteDef } from "../src/routes";

/** Records what a handler answered. `status()` returns `this` because BridgeRes is chainable. */
function makeRes() {
  const seen: { status?: number; body?: unknown; calls: number } = { calls: 0 };
  const res: BridgeRes = {
    status(code: number) {
      seen.status = code;
      return res;
    },
    json(body: unknown) {
      seen.body = body;
      seen.calls += 1;
    },
  };
  return { res, seen };
}

const req = (body?: unknown): BridgeReq => ({ body });

/**
 * An `App` whose every property access throws. Used to prove the wrapper contains failures from
 * ANY depth, not just the ones a handler thought to guard — the plugins it bridges to (obsidian-git,
 * dataview, tasks) are third-party and duck-typed, so "the shape changed under us" is the expected
 * failure, not an exotic one.
 */
function hostileApp(): never {
  const boom = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined; // not a thenable; do not confuse await
        throw new Error(`hostile app: touched ${String(prop)}`);
      },
    },
  );
  return boom as never;
}

/**
 * A benign app. `vault.adapter.getBasePath` and `vault.getName` are NOT decoration: probeResult
 * (routes.ts:184) reads both, and a fake missing them makes /probe answer `ok:false` — which the
 * first draft of this file did, and which safeHandler dutifully hid behind a bridge_error instead
 * of an exception. A too-thin fake produces a plausible failure, not an obvious one.
 */
function fakeApp(commands: { id: string; name: string }[] = [], fired = true) {
  return {
    commands: {
      listCommands: () => commands,
      executeCommandById: (_id: string) => fired,
    },
    plugins: { plugins: {} },
    internalPlugins: { plugins: {} },
    vault: {
      getAbstractFileByPath: () => null,
      getName: () => "TestVault",
      adapter: { getBasePath: () => "/tmp/TestVault" },
    },
  } as never;
}

const routes = (): RouteDef[] => buildRoutes(fakeApp(), "1.13.1", []);

describe("buildRoutes — route table", () => {
  it("exposes a non-empty table with unique method+path pairs", () => {
    const defs = routes();
    // Floored: a table that came back empty would make every other assertion here vacuously true.
    expect(defs.length).toBeGreaterThan(0);
    const keys = defs.map((d) => `${d.method} ${d.path}`);
    expect(new Set(keys).size, `duplicate route(s): ${keys.join(", ")}`).toBe(keys.length);
  });

  it("declares only get/post and rooted paths", () => {
    for (const d of routes()) {
      expect(["get", "post"]).toContain(d.method);
      expect(d.path.startsWith("/"), `unrooted path: ${d.path}`).toBe(true);
    }
  });
});

describe("buildRoutes — every handler answers, even when the app throws", () => {
  // The whole point of safeHandler (routes.ts:98) and of wrapping the table at routes.ts:952.
  it.each(buildRoutes(fakeApp(), "1.13.1", []).map((d) => [`${d.method} ${d.path}`, d] as const))(
    "%s neither rejects nor leaves the request unanswered",
    async (_label, def) => {
      // Rebuild against the hostile app so the handler under test is bound to it.
      const hostileDefs = buildRoutes(hostileApp(), "1.13.1", []);
      const target = hostileDefs.find((d) => d.method === def.method && d.path === def.path);
      expect(target, "route disappeared between builds").toBeDefined();

      const { res, seen } = makeRes();
      // Must not reject. An unhandled rejection here is the hung-bridge bug in production.
      await expect(target?.handler(req({}), res)).resolves.not.toThrow();
      expect(seen.calls, "handler returned without answering the request").toBeGreaterThan(0);
      // safeHandler answers 200 with `ok:false`; the bridge protocol carries errors in the body,
      // never as an HTTP status. A 500 here would surface as plugin_unreachable with no cause.
      expect(seen.status).toBe(200);
    },
  );
});

describe("POST /commands/execute", () => {
  const handlerFor = (path: string, app = fakeApp()) => {
    const d = buildRoutes(app, "1.13.1", []).find((r) => r.path === path);
    if (!d) throw new Error(`no route ${path}`);
    return d.handler;
  };

  it("rejects a missing command_id as invalid_input", async () => {
    const { res, seen } = makeRes();
    await handlerFor("/commands/execute")(req({}), res);
    expect(seen.body).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("reports a command that did not fire, echoing the id", async () => {
    const { res, seen } = makeRes();
    await handlerFor("/commands/execute", fakeApp([], false))(req({ command_id: "nope" }), res);
    expect(seen.body).toMatchObject({
      ok: false,
      code: "invalid_input",
      details: { command_id: "nope" },
    });
  });

  it("acknowledges a command that fired", async () => {
    const { res, seen } = makeRes();
    await handlerFor("/commands/execute", fakeApp([], true))(req({ command_id: "app:go" }), res);
    expect(seen.body).toMatchObject({ ok: true, result: { command_id: "app:go" } });
  });

  it("ignores a non-string command_id rather than coercing it", async () => {
    // `str()` (routes.ts:114) is a typeof guard, not a cast — a numeric id must be treated as
    // absent, not stringified into a lookup that could match an unrelated command.
    const { res, seen } = makeRes();
    await handlerFor("/commands/execute")(req({ command_id: 42 }), res);
    expect(seen.body).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("POST /commands/list", () => {
  const listHandler = (cmds: { id: string; name: string }[]) => {
    const d = buildRoutes(fakeApp(cmds), "1.13.1", []).find((r) => r.path === "/commands/list");
    if (!d) throw new Error("no /commands/list route");
    return d.handler;
  };
  const cmds = [
    { id: "editor:toggle-bold", name: "Toggle bold" },
    { id: "app:go-back", name: "Navigate back" },
  ];

  it("returns every command when unfiltered, with a matching total", async () => {
    const { res, seen } = makeRes();
    await listHandler(cmds)(req({}), res);
    expect(seen.body).toMatchObject({ ok: true, result: { total: 2 } });
  });

  it("filters on id OR name, case-insensitively", async () => {
    for (const filter of ["BOLD", "toggle-bold", "Toggle"]) {
      const { res, seen } = makeRes();
      await listHandler(cmds)(req({ filter }), res);
      const result = (seen.body as { result: { items: { id: string }[]; total: number } }).result;
      expect(result.total, `filter ${filter}`).toBe(1);
      expect(result.items[0]?.id).toBe("editor:toggle-bold");
    }
  });

  it("returns an empty set rather than everything when nothing matches", async () => {
    // A filter that silently degrades to "no filter" is worse than one that returns nothing:
    // the caller cannot tell the difference between "no matches" and "filter ignored".
    const { res, seen } = makeRes();
    await listHandler(cmds)(req({ filter: "zzz-no-such-command" }), res);
    expect(seen.body).toMatchObject({ ok: true, result: { items: [], total: 0 } });
  });
});

describe("GET /probe", () => {
  it("reports the plugin version it was built with and the obsidian apiVersion", async () => {
    const d = buildRoutes(fakeApp(), "9.9.9", []).find((r) => r.path === "/probe");
    const { res, seen } = makeRes();
    await d?.handler(req(), res);
    const body = seen.body as { ok: boolean; result: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.result.plugin_version).toBe("9.9.9");
    // Comes from the mocked obsidian module — asserts the value is threaded through, not that
    // Obsidian returns any particular version.
    expect(body.result.obsidian_version).toBe("1.13.1");
  });

  it("surfaces shape warnings it was handed", async () => {
    const d = buildRoutes(fakeApp(), "1.0.0", ["dataview: api shape changed"]).find(
      (r) => r.path === "/probe",
    );
    const { res, seen } = makeRes();
    await d?.handler(req(), res);
    const body = seen.body as { result: Record<string, unknown> };
    expect(JSON.stringify(body.result)).toContain("dataview: api shape changed");
  });
});
