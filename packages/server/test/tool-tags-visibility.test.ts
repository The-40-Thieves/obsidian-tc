import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolVisibilityConfig } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { FolderAcl } from "../src/acl";
import type { CallerContext } from "../src/mcp/registry";
import { CATALOG_RESOURCE_URI } from "../src/mcp/resources";
import { createMcpServer } from "../src/mcp/server";
import { ALLOW_ALL, explainVisibility } from "../src/mcp/visibility";
import { VaultRegistry } from "../src/vault/registry";
import { makeTempDir, rmTemp } from "./tmp";

type Mode = "flat" | "domain" | "triad";
const MODES: Mode[] = ["flat", "domain", "triad"];
const FULL_GRANT = { grantedScopes: new Set(["*"]) };

const cfg = (over: Partial<ToolVisibilityConfig>): ToolVisibilityConfig => ({
  ...ALLOW_ALL,
  ...over,
});

const vaultDir = makeTempDir("otc-tool-tags-");
afterAll(() => rmTemp(vaultDir));

async function connect(toolVisibility: ToolVisibilityConfig, mode: Mode) {
  const registry = buildFullRegistry({ toolVisibility });
  const context = (): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "t",
    db: {} as never,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  });
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: FULL_GRANT,
    vaultRegistry: new VaultRegistry([{ id: "t", name: "t", path: vaultDir }]),
    facadeMode: mode,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return { client, server, registry };
}

const json = (res: unknown): Record<string, unknown> =>
  JSON.parse((res as { content: [{ text: string }] }).content[0].text);

/** Every tool name the client can discover in `mode`, by every route that mode offers. */
async function discoverable(client: Client, mode: Mode, probe: string): Promise<Set<string>> {
  const found = new Set<string>();
  const res = await client.readResource({ uri: CATALOG_RESOURCE_URI });
  const catalog = JSON.parse((res.contents[0] as { text: string }).text) as {
    tools: { name: string }[];
  };
  for (const t of catalog.tools) found.add(t.name);
  if (mode === "flat") for (const t of (await client.listTools()).tools) found.add(t.name);
  if (mode === "domain")
    for (const t of (await client.listTools()).tools) {
      const actions = (t.inputSchema as { properties?: { action?: { enum?: string[] } } })
        .properties?.action?.enum;
      for (const a of actions ?? []) found.add(a);
    }
  if (mode === "triad") {
    const res = json(
      await client.callTool({ name: "find_capability", arguments: { query: probe, limit: 50 } }),
    ) as { matches: { name: string }[] };
    for (const m of res.matches) found.add(m.name);
  }
  return found;
}

describe.each(MODES)("hiddenTags on real tools — %s mode", (mode) => {
  it("`destructive` removes delete_note and the other destructive tools from every discovery route, leaving read tools", async () => {
    const { client, server, registry } = await connect(cfg({ hiddenTags: ["destructive"] }), mode);
    const hidden = registry
      .list()
      .filter((t) => t.tags?.includes("destructive"))
      .map((t) => t.name);
    expect(hidden).toEqual(
      expect.arrayContaining(["delete_note", "reset_vault_cache", "write_note"]),
    );

    const seen = await discoverable(client, mode, "delete note vault cache write");
    for (const name of hidden) expect(seen.has(name), name).toBe(false);
    expect(seen.has("read_note")).toBe(true);
    expect(seen.has("list_notes")).toBe(true);
    await client.close();
    await server.close();
  });

  it("`bulk` removes the bulk_* tools, and nothing without a bulk scope", async () => {
    const { client, server, registry } = await connect(cfg({ hiddenTags: ["bulk"] }), mode);
    const bulk = registry
      .list()
      .filter((t) => t.tags?.includes("bulk"))
      .map((t) => t.name);
    expect(bulk.sort()).toEqual(["bulk_create_notes", "bulk_move_notes", "bulk_set_property"]);
    const seen = await discoverable(client, mode, "bulk create move set property notes");
    for (const name of bulk) expect(seen.has(name), name).toBe(false);
    expect(seen.has("write_note")).toBe(true);
    await client.close();
    await server.close();
  });
});

describe.each(MODES)("disabledTags on real tools — %s mode", (mode) => {
  it("`external-network` drops the tagged tools from discovery and refuses a call as unknown", async () => {
    const { client, server, registry } = await connect(
      cfg({ disabledTags: ["external-network"] }),
      mode,
    );
    const net = registry
      .list()
      .filter((t) => t.tags?.includes("external-network"))
      .map((t) => t.name);
    expect(net).toEqual(
      expect.arrayContaining(["search_semantic", "knowledge_search", "work_search"]),
    );

    const seen = await discoverable(client, mode, "semantic search knowledge embedding");
    for (const name of net) expect(seen.has(name), name).toBe(false);
    expect(seen.has("search_text")).toBe(true);

    const call =
      mode === "triad"
        ? await client.callTool({
            name: "call_capability",
            arguments: { name: "search_semantic", args: { vault: "t", query: "x" } },
          })
        : mode === "domain"
          ? await client.callTool({
              name: "search",
              arguments: { action: "search_semantic", args: { vault: "t", query: "x" } },
            })
          : await client.callTool({
              name: "search_semantic",
              arguments: { vault: "t", query: "x" },
            });
    expect(call.isError).toBe(true);
    expect(call.structuredContent).toMatchObject({
      code: "not_found",
      message: "unknown tool: search_semantic",
    });
    await client.close();
    await server.close();
  });
});

describe("tag verdicts on real definitions", () => {
  const registry = buildFullRegistry();
  const byName = (n: string) => {
    const t = registry.list().find((x) => x.name === n);
    if (!t) throw new Error(`no tool ${n}`);
    return t;
  };

  it("explainVisibility names the tag that hid or disabled a real tool", () => {
    expect(explainVisibility(byName("delete_note"), cfg({ hiddenTags: ["hitl"] }))).toMatchObject({
      visibility: "hidden",
      reason: "hidden_tag",
      matchedTag: "hitl",
    });
    expect(
      explainVisibility(byName("search_semantic"), cfg({ disabledTags: ["external-network"] })),
    ).toMatchObject({
      visibility: "disabled",
      reason: "disabled_tag",
      matchedTag: "external-network",
    });
  });

  it("hiding `writes` leaves exactly the `read-only` tools, and the two partition the registry", () => {
    const all = registry.list();
    const reg = buildFullRegistry({ toolVisibility: cfg({ hiddenTags: ["writes"] }) });
    const visible = reg
      .listVisible(FULL_GRANT)
      .map((t) => t.name)
      .sort();
    const readOnly = all
      .filter((t) => t.tags?.includes("read-only"))
      .map((t) => t.name)
      .sort();
    expect(visible).toEqual(readOnly);
    expect(readOnly.length + all.filter((t) => t.tags?.includes("writes")).length).toBe(all.length);
  });

  it("a hidden tag stays callable by name: `hidden` is not `disabled`", () => {
    const reg = buildFullRegistry({ toolVisibility: cfg({ hiddenTags: ["git"] }) });
    expect(reg.listVisible(FULL_GRANT).some((t) => t.name === "git_status")).toBe(true);
    const gitHidden = buildFullRegistry({ toolVisibility: cfg({ hiddenTags: ["domain:git"] }) });
    expect(gitHidden.listVisible(FULL_GRANT).some((t) => t.name.startsWith("git_"))).toBe(false);
    expect(gitHidden.has("git_status")).toBe(true);
  });
});
