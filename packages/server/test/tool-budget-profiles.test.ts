// Tool-budget profiles: a flat middle profile ("essentials") sized for clients that cap the tools
// they accept, selectable per URL (`/mcp/<surface>`) and per config (`toolFacade.advertise`).
//
// What is under test, and why each is a separate describe:
//   1. the curated list itself (real, registered, bounded, about one tool per domain);
//   2. what tools/list advertises per profile (cap, order, stability, nothing hidden is dropped
//      from dispatch);
//   3. URL routing on the HTTP transport (including the prototype-key names an object lookup would
//      wrongly accept);
//   4. the `instructions` bounds Codex (512) and Claude Code (2,048) truncate at;
//   5. the `_meta` key Claude Code reads to keep the triad out of deferred loading.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ServerConfigSchema } from "@the-40-thieves/reliquary-tc-shared";
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import {
  buildInstructions,
  TRIAD_DIRECT_TOOLS,
  TRIAD_HOT_PATH_TOOLS,
  triadTools,
} from "../src/mcp/facade";
import { instructionsSurfaceOf } from "../src/mcp/instructions-routing";
import type { CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer, type McpServerOptions } from "../src/mcp/server";
import {
  type AdvertiseSubset,
  ESSENTIALS_RESERVED_SLOTS,
  ESSENTIALS_TOOL_NAMES,
  NON_CORE_TOOL_NAMES,
  urlSurfaceFor,
} from "../src/mcp/tool-profiles";
import { ALLOW_ALL } from "../src/mcp/visibility";
import { createHttpApp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";
import { listToolsRaw } from "./list-tools-raw";
import { REGISTERED_TOOL_COUNT } from "./registered-tool-count";
import { stallTimeout } from "./stall-timeouts";

const FULL = { grantedScopes: new Set(["*"]) };
const HOT_PATH = TRIAD_HOT_PATH_TOOLS;
const HOT_ON = { facadeMode: "triad", triadHotPath: true } as const;

const context = (): CallerContext => ({
  caller: "stdio",
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: "v1",
  db: {} as never,
  acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
});

async function listNames(
  registry: ToolRegistry,
  opts: {
    facadeMode?: "triad" | "domain" | "flat";
    advertise?: AdvertiseSubset;
    triadHotPath?: boolean;
  },
): Promise<string[]> {
  return withClient(registry, opts, async (client) =>
    (await listToolsRaw(client)).map((t) => t.name),
  );
}

// One connected in-memory client over a server built with `opts`, closed when `fn` settles.
async function withClient<T>(
  registry: ToolRegistry,
  opts: Partial<McpServerOptions>,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: FULL,
    ...opts,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("the essentials list", () => {
  const registered = new Set(
    buildFullRegistry()
      .list()
      .map((d) => d.name),
  );
  const byName = new Map(
    buildFullRegistry()
      .list()
      .map((d) => [d.name, d]),
  );

  it("names only registered tools, once each (no stale or typo'd entry)", () => {
    expect(ESSENTIALS_TOOL_NAMES.filter((n) => !registered.has(n))).toEqual([]);
    expect(new Set(ESSENTIALS_TOOL_NAMES).size).toBe(ESSENTIALS_TOOL_NAMES.length);
  });

  it("is a middle profile: 25-40 tools once the reserved slots are counted", () => {
    const slots = ESSENTIALS_RESERVED_SLOTS.filter((n) => registered.has(n));
    const total = ESSENTIALS_TOOL_NAMES.length + slots.length;
    expect(total).toBeGreaterThanOrEqual(25);
    expect(total).toBeLessThanOrEqual(40);
  });

  it("covers about one tool per domain: at least 12 of the 13", () => {
    const domains = new Set(ESSENTIALS_TOOL_NAMES.map((n) => byName.get(n)?.domain));
    expect(domains.size).toBeGreaterThanOrEqual(12);
  });

  it("does not hold generic executors or the triad (flat, named, schema-resolved tools only)", () => {
    for (const banned of [
      "execute_command",
      "call_capability",
      "find_capability",
      "eval_dataview_field",
    ])
      expect(ESSENTIALS_TOOL_NAMES).not.toContain(banned);
  });

  // Slot for the sibling PR that adds `search` and `fetch`. Whichever PR lands second: this is the
  // assertion that goes live. It is vacuous while neither tool is registered (stated, not hidden).
  it.each([...ESSENTIALS_RESERVED_SLOTS])(
    "advertises %s in essentials as soon as it is registered",
    async (name) => {
      const advertised = await listNames(buildFullRegistry(), { advertise: "essentials" });
      if (registered.has(name)) expect(advertised).toContain(name);
      else expect(advertised).not.toContain(name);
    },
  );
});

describe("tools/list per profile", () => {
  it("essentials advertises exactly the curated list, flat, in registry order", async () => {
    const registry = buildFullRegistry();
    const names = await listNames(registry, { advertise: "essentials" });
    const want = new Set<string>([...ESSENTIALS_TOOL_NAMES, ...ESSENTIALS_RESERVED_SLOTS]);
    const registryOrder = registry
      .list()
      .map((d) => d.name)
      .filter((n) => want.has(n));
    expect(names).toEqual(registryOrder);
    expect(names.length).toBeLessThanOrEqual(40);
    expect(names).not.toContain("find_capability");
  });

  it("core (the existing curation) advertises exactly the non-NON_CORE tools, flat", async () => {
    const names = await listNames(buildFullRegistry(), { advertise: "core" });
    expect(names.length).toBe(REGISTERED_TOOL_COUNT - NON_CORE_TOOL_NAMES.length);
    expect(names.filter((n) => NON_CORE_TOOL_NAMES.includes(n))).toEqual([]);
  });

  it("every profile is under its cap; the two over 100 are named and bounded", async () => {
    const registry = buildFullRegistry();
    const sizes = {
      triad: (await listNames(registry, { facadeMode: "triad" })).length,
      essentials: (await listNames(registry, { advertise: "essentials" })).length,
      core: (await listNames(registry, { advertise: "core" })).length,
      full: (await listNames(registry, { facadeMode: "flat" })).length,
    };
    // The three meta-tools plus the standard `search` and `fetch` advertised beside them.
    expect(sizes.triad).toBe(3 + TRIAD_DIRECT_TOOLS.length);
    expect(sizes.essentials).toBeLessThanOrEqual(40);
    // core: 101 on purpose (update_observation stays core; see docgen-stats.test.ts). It fits the
    // 128-per-request clients (VS Code, Copilot Studio, Vertex) but NOT the 100-total ones, which
    // is what essentials is for. full is every registered tool: only for clients without a cap
    // (Claude Code and claude.ai defer-load), and bounded here so growth past 128 is a decision.
    expect(sizes.core).toBeLessThanOrEqual(128);
    expect(sizes.full).toBe(REGISTERED_TOOL_COUNT);
  });

  it("is deterministic: two fresh registries and two servers list the same order", async () => {
    const a = await listNames(buildFullRegistry(), { advertise: "essentials" });
    const b = await listNames(buildFullRegistry(), { advertise: "essentials" });
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(25);
  });

  it("a profile narrows what is advertised, never what the caller may be granted", async () => {
    const registry = buildFullRegistry();
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry,
      context: () => ({ ...context(), grantedScopes: new Set(["read:notes"]) }),
      visibility: { grantedScopes: new Set(["read:notes"]) },
      advertise: "essentials",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    expect(names).toContain("read_note");
    expect(names).not.toContain("write_note");
    expect(names).not.toContain("delete_note");
  });
});

describe("URL routing on the HTTP transport", () => {
  function app(extra: { triadHotPath?: boolean } = {}) {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const auth = ServerConfigSchema.parse({
      vaults: [{ id: "alpha", path: "/tmp/alpha" }],
      auth: { mode: "none" },
    }).auth;
    return createHttpApp({
      name: "reliquary-tc",
      version: "0.0.0-test",
      // What transport-wiring passes from the default config: `/mcp` stays the triad.
      facadeMode: "triad",
      ...extra,
      registry: buildFullRegistry(),
      auth,
      db,
      vaultId: "alpha",
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    });
  }

  async function listAt(
    a: ReturnType<typeof app>,
    path: string,
    method = "tools/list",
  ): Promise<{ status: number; names: string[]; raw: string }> {
    const res = await a.app.request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        host: "127.0.0.1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    let names: string[] = [];
    try {
      const body = JSON.parse(line ? line.slice(6) : text) as {
        result?: { tools?: { name: string }[] };
      };
      names = (body.result?.tools ?? []).map((t) => t.name);
    } catch {
      // non-JSON error body: names stays empty, status carries the verdict
    }
    return { status: res.status, names, raw: text };
  }

  it("HTTP /mcp with triadHotPath lists the four hot-path tools after search and fetch", async () => {
    const r = await listAt(app({ triadHotPath: true }), "/mcp");
    expect(r.status).toBe(200);
    expect(r.names).toEqual([
      "find_capability",
      "describe_capability",
      "call_capability",
      "search",
      "fetch",
      ...HOT_PATH,
    ]);
  });

  it("/mcp is the unchanged default (triad)", async () => {
    const a = app();
    const r = await listAt(a, "/mcp");
    expect(r.status).toBe(200);
    expect(r.names).toEqual([
      "find_capability",
      "describe_capability",
      "call_capability",
      ...TRIAD_DIRECT_TOOLS,
    ]);
    await a.close();
  });

  it("/mcp/essentials serves the middle profile", async () => {
    const a = app();
    const r = await listAt(a, "/mcp/essentials");
    expect(r.status).toBe(200);
    expect(r.names).toEqual(await listNames(buildFullRegistry(), { advertise: "essentials" }));
    await a.close();
  });

  // Three HTTP tools/list round trips, one of them the whole flat surface: 6.5s on macos-15-intel,
  // past the 5s default there.
  it(
    "/mcp/full serves the whole flat surface and /mcp/core the existing core curation",
    async () => {
      const a = app();
      expect((await listAt(a, "/mcp/full")).names.length).toBe(REGISTERED_TOOL_COUNT);
      expect((await listAt(a, "/mcp/core")).names.length).toBe(
        REGISTERED_TOOL_COUNT - NON_CORE_TOOL_NAMES.length,
      );
      expect((await listAt(a, "/mcp/triad")).names.length).toBe(3 + TRIAD_DIRECT_TOOLS.length);
      await a.close();
    },
    stallTimeout(20_000),
  );

  it("an unknown or inherited-key surface is a 404, never a silent default", async () => {
    const a = app();
    for (const bad of ["nope", "constructor", "__proto__", "toString", "hasOwnProperty", "FULL"]) {
      const r = await listAt(a, `/mcp/${bad}`);
      expect(r.status, bad).toBe(404);
    }
    await a.close();
  });

  it("a non-POST on a surface path is 405 like /mcp itself", async () => {
    const a = app();
    const res = await a.app.request("http://127.0.0.1/mcp/essentials", {
      method: "GET",
      headers: { host: "127.0.0.1" },
    });
    expect(res.status).toBe(405);
    await a.close();
  });

  it("urlSurfaceFor is the one lookup and rejects inherited keys", () => {
    expect(urlSurfaceFor("essentials")).toEqual({ mode: "flat", advertise: "essentials" });
    expect(urlSurfaceFor("full")).toEqual({ mode: "flat", advertise: "all" });
    expect(urlSurfaceFor("constructor")).toBeUndefined();
  });
});

describe("config selection", () => {
  it("toolFacade.advertise defaults to all and accepts the two profiles", () => {
    const base = { vaults: [{ id: "a", path: "/tmp/a" }] };
    expect(ServerConfigSchema.parse(base).toolFacade.advertise).toBe("all");
    for (const v of ["core", "essentials"])
      expect(
        ServerConfigSchema.parse({ ...base, toolFacade: { advertise: v } }).toolFacade.advertise,
      ).toBe(v);
    expect(() =>
      ServerConfigSchema.parse({ ...base, toolFacade: { advertise: "tiny" } }),
    ).toThrow();
  });

  it("config advertise narrows a stdio-style server with no URL at all", async () => {
    const names = await listNames(buildFullRegistry(), {
      facadeMode: "triad",
      advertise: "essentials",
    });
    expect(names.length).toBeGreaterThan(25);
    expect(names).not.toContain("find_capability");
  });
});

describe("instructions bounds", () => {
  const surfaces = ["triad", "triad-core", "flat", "subset", "generic"] as const;
  const render = (surface: (typeof surfaces)[number]) =>
    buildInstructions("reliquary-tc", "9.9.9", buildFullRegistry(), FULL, true, true, surface);
  // The routing sentence is what a client must receive intact; it is asserted by content, so a
  // reword that pushes it past the bound fails here rather than silently getting truncated.
  const routing: Record<(typeof surfaces)[number], RegExp> = {
    triad: /find_capability[^.]*describe_capability[^.]*call_capability[^.]*\./,
    "triad-core":
      /read_note[^.]*search_vault[^.]*find_capability[^.]*describe_capability[^.]*call_capability[^.]*\./,
    flat: /Every tool is listed directly: call it by name\./,
    subset: /A curated subset; other tools are still callable by name[^.]*\./,
    generic: /If find_capability is listed[^.]*\./,
  };

  for (const s of surfaces) {
    it(`${s}: complete routing guidance sits inside the first 512 characters (Codex)`, () => {
      const text = render(s);
      const head = text.slice(0, 512);
      const m = routing[s].exec(head);
      expect(m, head).not.toBeNull();
      // Whole sentence, not a cut one: it must END inside the window.
      expect((m?.index ?? 0) + (m?.[0].length ?? 0)).toBeLessThanOrEqual(512);
    });

    // The full text is longer than 2,048 (the per-domain reference list is deliberately complete),
    // so Claude Code's cut lands inside that list. What must survive it: everything before the list
    // (routing, authorization note, feedback clause) and most of the list as WHOLE lines, so the
    // cut costs trailing reference lines, never half of the guidance.
    it(`${s}: Claude Code's 2,048-character cut keeps the guidance and 10+ whole domain lines`, () => {
      const text = render(s);
      const head = text.slice(0, 2048);
      const listStart = text.indexOf("\n\nCapabilities by domain");
      expect(listStart).toBeGreaterThan(0);
      expect(listStart).toBeLessThan(1024);
      expect(routing[s].test(head)).toBe(true);
      const wholeLines = head
        .split("\n")
        .slice(0, -1)
        .filter((l) => l.startsWith("- "));
      expect(wholeLines.length).toBeGreaterThanOrEqual(10);
    });
  }

  it("no routing text names a tool the profile does not advertise", async () => {
    const names = new Set(await listNames(buildFullRegistry(), { advertise: "essentials" }));
    const text = render("flat").slice(0, 512);
    for (const n of text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])
      if (n !== "mcp_server") expect(names.has(n) || n.startsWith("obsidian"), n).toBe(true);
  });

  // GH #1457: the cheapest route (one resource read, then search) leads the triad text, so an agent
  // reads a known note in one call instead of three.
  it("triad: leads with the one-call resource read, and names search before find_capability", () => {
    const text = buildInstructions(
      "reliquary-tc",
      "9.9.9",
      buildFullRegistry(),
      FULL,
      true,
      true,
      "triad",
    );
    const resource = text.indexOf("reliquary-tc://<vault>/<path>");
    const search = text.indexOf("search(query)");
    expect(resource).toBeGreaterThan(0);
    expect(search).toBeGreaterThan(0);
    expect(resource).toBeLessThan(text.indexOf("find_capability("));
    expect(search).toBeLessThan(text.indexOf("find_capability("));
  });

  it("triad: names no resource URI when resources are off", () => {
    const text = buildInstructions(
      "reliquary-tc",
      "9.9.9",
      buildFullRegistry(),
      FULL,
      false,
      true,
      "triad",
    );
    expect(text).not.toContain("reliquary-tc://");
    expect(text).toContain("search(query)");
  });

  it("triad and triad-core: the routing head names only tools that surface advertises", () => {
    const listed = new Set<string>([...triadTools(true).map((t) => t.name), ...TRIAD_DIRECT_TOOLS]);
    for (const s of ["triad", "triad-core"] as const) {
      const advertised = s === "triad" ? listed : new Set([...listed, ...HOT_PATH]);
      const head = render(s).slice(0, 512);
      const named = [...head.matchAll(/\b([a-z]+(?:_[a-z]+)*)\(/g)].map((m) => m[1] ?? "");
      expect(named.length).toBeGreaterThan(0);
      for (const n of named) expect(advertised.has(n), n).toBe(true);
    }
  });

  // GH #1457 slice 2: the triad-core variant names the hot-path reads before the gateway.
  it("triad-core: names read_note and search_vault before find_capability", () => {
    const text = render("triad-core");
    const find = text.indexOf("find_capability(");
    expect(text.indexOf("read_note(")).toBeGreaterThan(0);
    expect(text.indexOf("read_note(")).toBeLessThan(find);
    expect(text.indexOf("search_vault(")).toBeGreaterThan(0);
    expect(text.indexOf("search_vault(")).toBeLessThan(find);
  });
});

describe("Claude Code alwaysLoad", () => {
  it('marks every triad tool with _meta "anthropic/alwaysLoad": true', () => {
    for (const t of triadTools(true)) expect(t._meta?.["anthropic/alwaysLoad"], t.name).toBe(true);
    for (const t of triadTools(false)) expect(t._meta?.["anthropic/alwaysLoad"], t.name).toBe(true);
  });

  it("marks the triad's direct tools too: they are part of the default surface", async () => {
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: buildFullRegistry(),
      context,
      visibility: FULL,
      facadeMode: "triad",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const tools = (await client.listTools()).tools;
    await client.close();
    expect(tools.map((t) => t.name)).toEqual([
      ...triadTools(true).map((t) => t.name),
      ...TRIAD_DIRECT_TOOLS,
    ]);
    for (const t of tools) expect(t._meta?.["anthropic/alwaysLoad"], t.name).toBe(true);
  });

  it("does not mark flat tools (they are the deferred ones)", async () => {
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: buildFullRegistry(),
      context,
      visibility: FULL,
      facadeMode: "flat",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const tools = (await client.listTools()).tools;
    await client.close();
    expect(tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] !== undefined)).toEqual([]);
  });
});

describe("triadHotPath: the hot-path tools join the triad surface (GH #1457 slice 2)", () => {
  it("adds read_note, search_vault, write_note and list_notes after search and fetch", async () => {
    expect(
      await listNames(buildFullRegistry(), { facadeMode: "triad", triadHotPath: true }),
    ).toEqual([
      "find_capability",
      "describe_capability",
      "call_capability",
      "search",
      "fetch",
      ...HOT_PATH,
    ]);
  });

  it("without triadHotPath the triad surface is unchanged", async () => {
    expect(await listNames(buildFullRegistry(), { facadeMode: "triad" })).toEqual([
      "find_capability",
      "describe_capability",
      "call_capability",
      "search",
      "fetch",
    ]);
  });

  it("is inert on a flat surface", async () => {
    expect(
      await listNames(buildFullRegistry(), { facadeMode: "flat", triadHotPath: true }),
    ).toEqual(await listNames(buildFullRegistry(), { facadeMode: "flat" }));
  });

  // Drives the real tools/call route (not registry.dispatch), so a direct call that skipped the
  // ACL would fail here while the call_capability route still refused it.
  it("refuses a vault-bound caller on tools/call read_note, as call_capability does", async () => {
    const bound = { ...context(), vaultBound: true, vaultId: "a" };
    await withClient(buildFullRegistry(), { ...HOT_ON, context: () => bound }, async (client) => {
      const args = { vault: "b", path: "note.md" };
      const direct = await client.callTool({ name: "read_note", arguments: args });
      const viaFacade = await client.callTool({
        name: "call_capability",
        arguments: { name: "read_note", args },
      });
      expect(direct.isError).toBe(true);
      expect(JSON.stringify(direct.content)).toContain("forbidden");
      expect(direct.content).toEqual(viaFacade.content);
    });
  });

  it("the instructions name read_note(path) before find_capability on a triadHotPath server", async () => {
    await withClient(buildFullRegistry(), HOT_ON, async (client) => {
      const text = (await client.getInstructions()) ?? "";
      expect(text.indexOf("read_note(path)")).toBeGreaterThan(0);
      expect(text.indexOf("read_note(path)")).toBeLessThan(text.indexOf("find_capability("));
    });
  });

  it("routing text names no hidden read_note when a visibility mask hides it", async () => {
    const visibility = { ...FULL, toolVisibility: { ...ALLOW_ALL, hidden: ["read_note"] } };
    await withClient(buildFullRegistry(), { ...HOT_ON, visibility }, async (client) => {
      const names = (await client.listTools()).tools.map((t) => t.name);
      const text = (await client.getInstructions()) ?? "";
      expect(names).not.toContain("read_note");
      expect(text).not.toContain("read_note(");
      expect(text).toContain("find_capability(");
    });
  });

  it("marks each hot-path tool alwaysLoad on the wire tools/list", async () => {
    await withClient(buildFullRegistry(), HOT_ON, async (client) => {
      const tools = (await client.listTools()).tools;
      for (const n of HOT_PATH) {
        expect(tools.find((t) => t.name === n)?._meta?.["anthropic/alwaysLoad"], n).toBe(true);
      }
    });
  });
});

describe("instructionsSurfaceOf: triad-core needs triad mode, no advertise subset, and the flag", () => {
  it("picks triad-core only for the triad surface with triadHotPath on", () => {
    expect(instructionsSurfaceOf("triad", undefined, true)).toBe("triad-core");
    expect(instructionsSurfaceOf("triad", "all", true)).toBe("triad-core");
    expect(instructionsSurfaceOf("triad", undefined, false)).toBe("triad");
    expect(instructionsSurfaceOf("triad", "essentials", true)).toBe("subset");
    expect(instructionsSurfaceOf("flat", undefined, true)).toBe("flat");
    expect(instructionsSurfaceOf("domain", undefined, true)).toBe("generic");
  });
});
