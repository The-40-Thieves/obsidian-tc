import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import {
  buildCatalog,
  MAX_INSTRUCTIONS_CHARS,
  renderCatalogResource,
  renderInstructions,
} from "../src/mcp/facade";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { CATALOG_RESOURCE_URI } from "../src/mcp/resources";
import { createMcpServer } from "../src/mcp/server";
import { VaultRegistry } from "../src/vault/registry";
import { rmTemp } from "./tmp";

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // Best-effort teardown, same posture as mcp-resources-prompts.test.ts.
    }
  }
});

function tool(
  name: string,
  domain: string,
  description: string,
  scopes: string[] = [],
): ToolDefinition {
  return {
    name,
    domain,
    description,
    inputSchema: z.object({ x: z.string() }).strict(),
    requiredScopes: scopes,
    handler: (i: { x: string }) => ({ echo: i.x }),
  } as unknown as ToolDefinition;
}

function fixtureTools(): ToolDefinition[] {
  return [
    tool("read_note", "notes", "Read a note from the vault by path."),
    tool("write_note", "notes", "Create or overwrite a note at the given path."),
    tool("search_text", "search", "Full-text search over the vault.", ["read:secrets"]),
  ];
}

describe("buildCatalog (THE-937)", () => {
  it("groups the caller-visible catalog by domain as {domain, name, summary}", () => {
    const groups = buildCatalog(fixtureTools());
    expect(groups.map((g) => g.domain)).toEqual(["notes", "search"]);
    const notes = groups.find((g) => g.domain === "notes");
    expect(notes?.tools.map((t) => t.name)).toEqual(["read_note", "write_note"]);
    expect(notes?.tools[0]).toMatchObject({
      name: "read_note",
      summary: "Read a note from the vault by path.",
    });
  });

  it("drops a domain with no members and skips a def with no domain", () => {
    const noDomain = { ...fixtureTools()[0], domain: undefined } as ToolDefinition;
    const groups = buildCatalog([noDomain]);
    expect(groups).toEqual([]);
  });

  it("renderCatalogResource flattens to one {domain, name, summary} row per tool", () => {
    const entries = renderCatalogResource(buildCatalog(fixtureTools()));
    expect(entries).toEqual([
      { domain: "notes", name: "read_note", summary: "Read a note from the vault by path." },
      {
        domain: "notes",
        name: "write_note",
        summary: "Create or overwrite a note at the given path.",
      },
      { domain: "search", name: "search_text", summary: "Full-text search over the vault." },
    ]);
  });
});

describe("renderInstructions (THE-937)", () => {
  it("lists all 13 domains, one line each", () => {
    const text = renderInstructions(buildCatalog(fixtureTools()));
    const lines = text.split("\n");
    expect(lines).toHaveLength(13);
    for (const line of lines) expect(line.startsWith("- ")).toBe(true);
  });

  it("names only tool names present in the caller-visible catalog", () => {
    const text = renderInstructions(buildCatalog(fixtureTools()));
    expect(text).toContain("read_note");
    expect(text).toContain("write_note");
    // search_text is caller-visible here (fixtureTools includes it) — a domain with NOTHING
    // visible must not name it; asserted properly in the ACL-filtering test below.
    expect(text).toContain("search_text");
  });

  it("a domain with nothing caller-visible still gets its blurb line with no names", () => {
    // Only a "notes" tool is visible; every other domain (including "search") has zero members.
    const text = renderInstructions(buildCatalog(fixtureTools().slice(0, 1)));
    const searchLine = text.split("\n").find((l) => l.startsWith("- Search:"));
    expect(searchLine).toBeDefined();
    expect(searchLine).not.toContain("search_text");
  });

  // Gate 2: "capped by a test at 500 tokens" — approximated as chars/4, so the cap is stated in
  // chars (MAX_INSTRUCTIONS_CHARS = 2,000) rather than depending on a tokenizer.
  it("stays under the 500-token (2,000-char) budget for the FULL real registry", () => {
    const full = buildFullRegistry().listVisible();
    const text = renderInstructions(buildCatalog(full));
    expect(text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
  });

  it("every TOP_TOOLS_BY_DOMAIN name is a real, currently-registered tool in that domain", () => {
    // Guards the static allowlist against a rename or a domain move: if a name in the allowlist
    // no longer exists (or moved domains), it silently stops appearing in the instructions text
    // rather than failing loudly — this test is the loud failure.
    const full = buildFullRegistry();
    const byName = new Map(full.list().map((t) => [t.name, t.domain]));
    const text = renderInstructions(buildCatalog(full.listVisible()));
    // Every "(e.g. ...)" name mentioned must resolve to a real tool whose domain matches the line
    // it appears on.
    for (const line of text.split("\n")) {
      const m = line.match(/^- ([^:]+): .*\(e\.g\. (.+)\)$/);
      if (!m) continue; // a domain whose allowlist entries are all absent from the real registry
      const names = m[2]?.split(", ") ?? [];
      for (const n of names) expect(byName.has(n), `${n} is not a registered tool`).toBe(true);
    }
  });
});

describe("catalog discovery — ACL filtering and resource wiring (integration)", () => {
  function tempVault(): VaultRegistry {
    const dir = tmpDir("otc-catalog-");
    writeFileSync(join(dir, "a.md"), "# A\nhello");
    writeFileSync(join(dir, "b.md"), "# B\nworld");
    const cfg = ServerConfigSchema.parse({ vaults: [{ id: "main", path: dir }] });
    return new VaultRegistry(cfg.vaults);
  }

  function reg(): ToolRegistry {
    const r = new ToolRegistry();
    for (const t of fixtureTools()) r.register(t);
    return r;
  }

  async function connect(scopes: string[], vaultRegistry?: VaultRegistry) {
    const context = (): CallerContext => ({
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(scopes),
      vaultId: "main",
      db: {} as never,
    });
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: reg(),
      context,
      vaultRegistry,
      facadeMode: "triad",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    return { client, server };
  }

  it("find_capability's description names the obsidian-tc://catalog resource", async () => {
    const { client, server } = await connect(["*"]);
    const tools = (await client.listTools()).tools;
    const find = tools.find((t) => t.name === "find_capability");
    expect(find?.description).toContain("obsidian-tc://catalog");
    await client.close();
    await server.close();
  });

  it("a caller lacking a tool's scope does not see it in the catalog resource", async () => {
    const { client, server } = await connect(["read:notes"], tempVault());
    const res = await client.readResource({ uri: CATALOG_RESOURCE_URI });
    const c = res.contents[0];
    if (!c || !("text" in c) || typeof c.text !== "string") throw new Error("expected text");
    const body = JSON.parse(c.text) as { tools: { name: string }[] };
    const names = body.tools.map((t) => t.name);
    expect(names).toContain("read_note");
    expect(names).toContain("write_note");
    // search_text requires read:secrets, which this caller was not granted.
    expect(names).not.toContain("search_text");
    await client.close();
    await server.close();
  });

  it("resources/list lists the catalog FIRST, ahead of the paginated vault notes", async () => {
    const { client, server } = await connect(["*"], tempVault());
    const res = await client.listResources();
    expect(res.resources[0]?.uri).toBe(CATALOG_RESOURCE_URI);
    const names = res.resources
      .slice(1)
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(["a.md", "b.md"]);
    await client.close();
    await server.close();
  });

  it("resources/read of the catalog URI returns the grouped {domain, name, summary} JSON", async () => {
    const { client, server } = await connect(["*"], tempVault());
    const res = await client.readResource({ uri: CATALOG_RESOURCE_URI });
    const c = res.contents[0];
    expect(c?.uri).toBe(CATALOG_RESOURCE_URI);
    expect(c?.mimeType).toBe("application/json");
    if (!c || !("text" in c) || typeof c.text !== "string") throw new Error("expected text");
    const body = JSON.parse(c.text) as {
      tools: { domain: string; name: string; summary: string }[];
    };
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: "notes", name: "read_note" }),
        expect.objectContaining({ domain: "notes", name: "write_note" }),
        expect.objectContaining({ domain: "search", name: "search_text" }),
      ]),
    );
    await client.close();
    await server.close();
  });

  it("a caller without read:notes cannot list or read the catalog either", async () => {
    const { client, server } = await connect([], tempVault());
    // resources/list is scope-gated on read:notes for the WHOLE surface, catalog included.
    const res = await client.listResources();
    expect(res.resources).toHaveLength(0);
    await expect(client.readResource({ uri: CATALOG_RESOURCE_URI })).rejects.toThrow();
    await client.close();
    await server.close();
  });

  it("legacy initialize's instructions carry the domain catalog summary", async () => {
    // The SDK v1 client only ever produces the legacy 2025-11-25 handshake (initialize), whose
    // `instructions` is the Server constructor's static option — mcp/server.ts computes it once
    // from `registry.listVisible()`. getInstructions() is populated from that handshake response.
    const { client, server } = await connect(["*"]);
    expect(client.getInstructions()).toContain("Capabilities by domain");
    expect(client.getInstructions()).toContain("obsidian-tc://catalog");
    await client.close();
    await server.close();
  });
});
