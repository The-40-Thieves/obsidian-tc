// THE-1131: `toolFacade.profile` ("full" | "core", default "full" — the default is UNCHANGED by
// this ticket) picks which registered tools are visible/callable — orthogonal to
// `toolFacade.mode` (what a SESSION is advertised). Registration is profile-invariant (every
// tool is always registered). Mirrors the THE-1098 (GH #964) pattern in tool-facade.test.ts: a
// hidden-but-registered tool answers `capability_hidden` with its reason, never `not_found`
// (which would read as "never existed") and never a silent dispatch — including direct-name
// dispatch (flat mode), which review round 2 closed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { FolderAcl } from "../src/acl";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { isNonCoreTool, NON_CORE_TOOL_NAMES } from "../src/mcp/tool-profiles";
import { ALLOW_ALL } from "../src/mcp/visibility";
import { REGISTERED_TOOL_COUNT } from "./registered-tool-count";

const CORE_TOOL_COUNT = REGISTERED_TOOL_COUNT - NON_CORE_TOOL_NAMES.length;

// A minimal caller with a full grant — the same shape connect()'s context() below uses — so
// listVisible reports the STATIC layer's verdict alone.
const FULL_GRANT = { grantedScopes: new Set(["*"]) };

function tool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: z.object({ x: z.string() }).strict(),
    requiredScopes: [],
    handler: (i: { x: string }) => ({ echo: i.x }),
    ...extra,
  } as unknown as ToolDefinition;
}

async function connect(registry: ToolRegistry, facadeMode?: "triad" | "domain" | "flat" | "auto") {
  const context = (): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db: {} as never,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  });
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    facadeMode,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return { client, server };
}

function textOf(res: unknown): unknown {
  const content = (res as { content: [{ text: string }] }).content;
  return JSON.parse(content[0].text);
}

describe("THE-1131 tool-profiles.ts — the single source of truth", () => {
  // Exact, not `<= 100` — a mutation test (deleting a name from tool-profiles.ts's arrays) must
  // fail THIS assertion too, not just check-version-coherence.mjs's headline gate.
  it(`core is exactly ${REGISTERED_TOOL_COUNT - NON_CORE_TOOL_NAMES.length} tools`, () => {
    expect(CORE_TOOL_COUNT).toBe(REGISTERED_TOOL_COUNT - NON_CORE_TOOL_NAMES.length);
    expect(CORE_TOOL_COUNT).toBe(97);
  });

  it("every non-core name is actually registered (no stale/typo'd entry)", () => {
    const registered = new Set(
      buildFullRegistry()
        .list()
        .map((d) => d.name),
    );
    const missing = NON_CORE_TOOL_NAMES.filter((n) => !registered.has(n));
    expect(missing).toEqual([]);
  });

  it("isNonCoreTool agrees with the list it is derived from", () => {
    expect(isNonCoreTool("read_note")).toBe(false);
    expect(isNonCoreTool(NON_CORE_TOOL_NAMES[0] as string)).toBe(true);
    expect(isNonCoreTool("no_such_tool")).toBe(false);
  });
});

describe("THE-1131 registry construction — core vs full profile", () => {
  it('profile "core": listVisible returns exactly the core count, not just >= something', () => {
    const registry = buildFullRegistry({
      toolVisibility: { ...ALLOW_ALL, disabledByProfile: NON_CORE_TOOL_NAMES },
    });
    expect(registry.list().length).toBe(REGISTERED_TOOL_COUNT); // registration is profile-invariant
    expect(registry.listVisible(FULL_GRANT).length).toBe(CORE_TOOL_COUNT);
  });

  it('profile "full": listVisible returns all 163', () => {
    const registry = buildFullRegistry({ toolVisibility: { ...ALLOW_ALL, disabledByProfile: [] } });
    expect(registry.listVisible(FULL_GRANT).length).toBe(REGISTERED_TOOL_COUNT);
  });

  it("absent disabledByProfile (a config predating THE-1131) behaves like full — nothing hidden", () => {
    const registry = buildFullRegistry();
    expect(registry.listVisible(FULL_GRANT).length).toBe(REGISTERED_TOOL_COUNT);
  });
});

describe("THE-1131 describe_capability / call_capability under profile: core", () => {
  function regCore(): ToolRegistry {
    const r = new ToolRegistry({
      toolVisibility: { ...ALLOW_ALL, disabledByProfile: ["create_excalidraw"] },
    });
    r.register(tool("read_note"));
    r.register(tool("create_excalidraw"));
    return r;
  }

  it("describe_capability on an extended-only tool answers capability_hidden naming the config key", async () => {
    const { client, server } = await connect(regCore(), "triad");
    const res = await client.callTool({
      name: "describe_capability",
      arguments: { name: "create_excalidraw" },
    });
    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body).toMatchObject({ code: "capability_hidden", reason: "disabled_by_profile" });
    expect((body as { message: string }).message).toContain("toolFacade.profile");
    await client.close();
    await server.close();
  });

  it("call_capability on an extended-only tool answers capability_hidden, never a silent dispatch", async () => {
    const { client, server } = await connect(regCore(), "triad");
    const res = await client.callTool({
      name: "call_capability",
      arguments: { name: "create_excalidraw", args: { x: "hi" } },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatchObject({ code: "capability_hidden", reason: "disabled_by_profile" });
    await client.close();
    await server.close();
  });

  it("a direct dispatch by name (flat mode) answers capability_hidden too, not a silent dispatch or bare not_found", async () => {
    // Review round 2: hidden must never read as absent through ANY door, so direct dispatch now
    // gets the same pre-check call_capability does, not the plain "disabled"-tier not_found.
    const { client, server } = await connect(regCore(), "flat");
    const res = await client.callTool({ name: "create_excalidraw", arguments: { x: "hi" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatchObject({ code: "capability_hidden", reason: "disabled_by_profile" });
    await client.close();
    await server.close();
  });

  it("find_capability never surfaces an extended-only tool under core", async () => {
    const { client, server } = await connect(regCore(), "triad");
    const res = await client.callTool({
      name: "find_capability",
      arguments: { query: "excalidraw" },
    });
    const body = textOf(res) as { matches: { name: string }[] };
    expect(body.matches.map((m) => m.name)).not.toContain("create_excalidraw");
    await client.close();
    await server.close();
  });

  it("a core tool is unaffected: describe_capability and call_capability both succeed", async () => {
    const { client, server } = await connect(regCore(), "triad");
    const described = await client.callTool({
      name: "describe_capability",
      arguments: { name: "read_note" },
    });
    expect(described.isError).not.toBe(true);
    const called = await client.callTool({
      name: "call_capability",
      arguments: { name: "read_note", args: { x: "hi" } },
    });
    expect(called.isError).not.toBe(true);
    await client.close();
    await server.close();
  });
});

describe("THE-1131 profile composes with facade mode", () => {
  function regCoreDomain(): ToolRegistry {
    const r = new ToolRegistry({
      toolVisibility: { ...ALLOW_ALL, disabledByProfile: ["create_excalidraw"] },
    });
    r.register(tool("read_note", { domain: "notes" } as Partial<ToolDefinition>));
    r.register(tool("create_excalidraw", { domain: "notes" } as Partial<ToolDefinition>));
    return r;
  }

  it('mode "auto" (resolves to triad for an unrecognized client) + profile "core": the core-hidden tool stays hidden', async () => {
    const context = (): CallerContext => ({
      caller: "stdio",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v1",
      db: {} as never,
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    });
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: regCoreDomain(),
      context,
      visibility: { grantedScopes: new Set(["*"]) },
      facadeMode: "auto",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "some-unrecognized-client", version: "0" });
    await client.connect(ct);
    const res = await client.callTool({
      name: "call_capability",
      arguments: { name: "create_excalidraw", args: { x: "hi" } },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatchObject({ code: "capability_hidden", reason: "disabled_by_profile" });
    await client.close();
    await server.close();
  });

  it('profile "full": the same tool is fully reachable', async () => {
    const r = new ToolRegistry({ toolVisibility: { ...ALLOW_ALL, disabledByProfile: [] } });
    r.register(tool("create_excalidraw"));
    const { client, server } = await connect(r, "triad");
    const res = await client.callTool({
      name: "call_capability",
      arguments: { name: "create_excalidraw", args: { x: "hi" } },
    });
    expect(res.isError).not.toBe(true);
    await client.close();
    await server.close();
  });
});

// Review round 2: the real stdio matrix — every {profile} x {facade mode} combination that
// matters, over the SAME registry both profiles share, not synthetic single-tool fixtures.
describe("THE-1131 real stdio matrix: profile x facade mode", () => {
  function registryFor(profile: "core" | "full"): ToolRegistry {
    return buildFullRegistry({
      toolVisibility: {
        ...ALLOW_ALL,
        disabledByProfile: profile === "core" ? NON_CORE_TOOL_NAMES : [],
      },
    });
  }

  it("core + triad: tools/list still advertises exactly the triad, core-hidden tools unreachable by name", async () => {
    const { client, server } = await connect(registryFor("core"), "triad");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["call_capability", "describe_capability", "find_capability"]);
    const res = await client.callTool({
      name: "call_capability",
      arguments: { name: "create_excalidraw", args: {} },
    });
    expect(textOf(res)).toMatchObject({ code: "capability_hidden", reason: "disabled_by_profile" });
    await client.close();
    await server.close();
  });

  it("full + triad: tools/list still advertises exactly the triad, every tool reachable by name", async () => {
    const { client, server } = await connect(registryFor("full"), "triad");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["call_capability", "describe_capability", "find_capability"]);
    const res = await client.callTool({
      name: "describe_capability",
      arguments: { name: "create_excalidraw" },
    });
    expect(res.isError).not.toBe(true);
    await client.close();
    await server.close();
  });

  it(`core + flat: tools/list advertises exactly ${97} tools (the core count, not >=)`, async () => {
    const { client, server } = await connect(registryFor("core"), "flat");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.length).toBe(CORE_TOOL_COUNT);
    expect(names).not.toContain("create_excalidraw");
    await client.close();
    await server.close();
  });

  it("full + flat: tools/list advertises all 163", async () => {
    const { client, server } = await connect(registryFor("full"), "flat");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.length).toBe(REGISTERED_TOOL_COUNT);
    await client.close();
    await server.close();
  });

  it("core + auto (unrecognized client -> triad): core-hidden tool stays hidden via call_capability", async () => {
    const { client, server } = await connect(registryFor("core"), "auto");
    const res = await client.callTool({
      name: "call_capability",
      arguments: { name: "create_excalidraw", args: {} },
    });
    expect(textOf(res)).toMatchObject({ code: "capability_hidden", reason: "disabled_by_profile" });
    await client.close();
    await server.close();
  });

  it("full + auto (unrecognized client -> triad): every tool reachable by name (no profile-hidden rejection)", async () => {
    const { client, server } = await connect(registryFor("full"), "auto");
    const res = await client.callTool({
      name: "describe_capability",
      arguments: { name: "create_excalidraw" },
    });
    expect(res.isError).not.toBe(true);
    await client.close();
    await server.close();
  });
});
