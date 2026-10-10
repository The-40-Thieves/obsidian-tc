// The standard `search(query)` and `fetch(id)` tools ChatGPT deep research / company knowledge
// require, over the existing hybrid search (search_vault mode=auto), with absolute citation urls.
//
// DOCUMENTED SHAPES (fetched 2026-10-09):
//   https://developers.openai.com/api/docs/mcp  ("Build a remote MCP server" -> search / fetch)
//   search({query: string}) -> {results: [{id, title, url}]}
//   fetch({id: string})     -> {id, title, text, url, metadata?}
//   "return this object as structuredContent and include the same value as a JSON-encoded string
//   in the content array"; "Declare an output schema for each tool"; "ChatGPT creates citation
//   metadata only when url is a non-empty string".
// `search` additionally carries a `text` snippet per result (additive; the page lists id/title/url).
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VaultConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { isNonCoreTool } from "../src/mcp/tool-profiles";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM2Tools } from "../src/tools/m2";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTestVault } from "./m1-helpers";
import { makeTempDir, rmTemp } from "./tmp";

// ---- the documented shapes, as validators -------------------------------------------------------
const DocumentedSearch = z.object({
  results: z.array(
    z.object({ id: z.string().min(1), title: z.string(), url: z.string().min(1) }).passthrough(),
  ),
});
const DocumentedFetch = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    text: z.string(),
    url: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const NOTES = {
  "projects/zebra.md":
    "---\ntitle: Zebra Plan\n---\n\n# Heading\n\nThe zebra migration plan covers stripes.\n",
  "Daily/2026 10 09.md": "# Daily log\n\nA quokka appeared near the zebra crossing.\n",
  "private/secret.md": "# Secret\n\nThe zebra vault combination is hidden here.\n",
};

/** M1 (read_note, the reference refusal) + M2 (the tools under test) on one real temp vault, with
 *  dispatch's central folder-ACL stage wired as production wires it. */
function vault(opts: Parameters<typeof makeTestVault>[0] = {}) {
  const v = makeTestVault({ files: NOTES, centralAcl: true, ...opts });
  cleanups.push(() => v.cleanup());
  const provider = fakeEmbeddingProvider({ dimensions: 32 });
  registerM2Tools(v.registry, {
    vaultRegistry: v.vaultRegistry,
    embeddingProvider: provider,
    representation: buildRepresentationManifest(provider, {}),
  });
  return v;
}

async function ok(p: Promise<unknown>): Promise<Record<string, any>> {
  const res = (await p) as { ok: boolean; data?: Record<string, any>; error?: unknown };
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res.data as Record<string, any>;
}
async function fail(
  p: Promise<unknown>,
): Promise<{ code: string; message: string; details?: any }> {
  const res = (await p) as { ok: boolean; error?: any };
  expect(res.ok, "expected a refusal").toBe(false);
  return res.error;
}

describe("search", () => {
  it("returns documented {results:[{id,title,url}]} with text snippets, over the hybrid router", async () => {
    const v = vault();
    const data = await ok(v.call("search", { vault: "test", query: "zebra" }));
    const parsed = DocumentedSearch.parse(data);
    expect(parsed.results.length).toBeGreaterThanOrEqual(2);
    const byId = Object.fromEntries(parsed.results.map((r) => [r.id, r]));
    const zebra = byId["test:projects/zebra.md"] as Record<string, unknown>;
    expect(zebra).toBeDefined();
    expect(zebra.title).toBe("Zebra Plan");
    expect(String(zebra.text)).toMatch(/zebra/i);
    expect(Object.keys(data)).toEqual(["results"]);
    // one result per note even though the text leg returns one hit per matching line
    expect(new Set(parsed.results.map((r) => r.id)).size).toBe(parsed.results.length);
  });

  it("falls back to the first heading, then the file name, for a title", async () => {
    const v = vault();
    const data = await ok(v.call("search", { vault: "test", query: "quokka" }));
    expect(data.results[0].title).toBe("Daily log");
    v.write("plain.md", "just words about okapi\n");
    const plain = await ok(v.call("search", { vault: "test", query: "okapi" }));
    expect(plain.results[0].title).toBe("plain");
  });

  it("every result carries a non-empty absolute url (obsidian:// form by default, encoded)", async () => {
    const v = vault();
    const data = await ok(v.call("search", { vault: "test", query: "quokka" }));
    expect(data.results[0].url).toBe("obsidian://open?vault=test&file=Daily%2F2026%2010%2009.md");
  });

  it("uses an absolute https url when the vault configures publicUrl (segments encoded, .md dropped)", async () => {
    const v = vault();
    v.vaultRegistry.register({
      id: "pub",
      path: v.root,
      publicUrl: "https://notes.example.com/base/",
    });
    const data = await ok(v.call("search", { vault: "pub", query: "quokka" }));
    expect(data.results[0].id).toBe("pub:Daily/2026 10 09.md");
    expect(data.results[0].url).toBe("https://notes.example.com/base/Daily/2026%2010%2009");
  });

  it("does not return a note the read ACL denies", async () => {
    const v = vault({ acl: { readPaths: ["projects", "projects/**", "Daily", "Daily/**"] } });
    const data = await ok(v.call("search", { vault: "test", query: "zebra" }));
    const ids = data.results.map((r: { id: string }) => r.id);
    expect(ids).toContain("test:projects/zebra.md");
    expect(ids).not.toContain("test:private/secret.md");
    expect(JSON.stringify(data)).not.toContain("combination");
  });

  it("limit bounds the number of results", async () => {
    const v = vault();
    const data = await ok(v.call("search", { vault: "test", query: "zebra", limit: 1 }));
    expect(data.results).toHaveLength(1);
  });

  it("is read-only: needs only read:notes", async () => {
    const v = vault();
    const data = await ok(
      v.call(
        "search",
        { vault: "test", query: "zebra" },
        { grantedScopes: new Set(["read:notes"]) },
      ),
    );
    expect(data.results.length).toBeGreaterThan(0);
    const e = await fail(
      v.call(
        "search",
        { vault: "test", query: "zebra" },
        { grantedScopes: new Set(["read:vault"]) },
      ),
    );
    expect(e.code).toBe("forbidden");
  });
});

describe("fetch", () => {
  it("returns documented {id,title,text,url,metadata} for an id search returned", async () => {
    const v = vault();
    const search = await ok(v.call("search", { vault: "test", query: "zebra" }));
    const hit = search.results.find((r: { id: string }) => r.id === "test:projects/zebra.md");
    const data = await ok(v.call("fetch", { id: hit.id }));
    const parsed = DocumentedFetch.parse(data);
    expect(parsed.id).toBe("test:projects/zebra.md");
    expect(parsed.title).toBe("Zebra Plan");
    expect(parsed.text).toBe(NOTES["projects/zebra.md"]);
    expect(parsed.url).toBe(hit.url);
    expect(parsed.metadata).toMatchObject({ vault: "test", path: "projects/zebra.md" });
    expect(typeof parsed.metadata?.content_hash).toBe("string");
  });

  it("refuses a read-ACL-denied note with the same error as read_note", async () => {
    const v = vault({ acl: { readPaths: ["projects", "projects/**"] } });
    const viaFetch = await fail(v.call("fetch", { id: "test:private/secret.md" }));
    const viaRead = await fail(v.call("read_note", { vault: "test", path: "private/secret.md" }));
    expect(viaFetch.code).toBe("acl_denied");
    expect(viaFetch).toEqual(viaRead);
  });

  it("reports note_not_found like read_note for a missing note", async () => {
    const v = vault();
    const viaFetch = await fail(v.call("fetch", { id: "test:nope.md" }));
    const viaRead = await fail(v.call("read_note", { vault: "test", path: "nope.md" }));
    expect(viaFetch.code).toBe("note_not_found");
    expect(viaFetch).toEqual(viaRead);
  });

  it.each([
    ["no vault prefix", "projects/zebra.md"],
    ["traversal", "test:../outside.md"],
    ["nested traversal", "test:projects/../../outside.md"],
    ["absolute path", "test:/etc/passwd"],
    ["windows drive", "test:C:\\x.md"],
    ["bad vault slug", "Te St:projects/zebra.md"],
    ["empty path", "test:"],
  ])("rejects a malformed id (%s) before touching the filesystem", async (_n, id) => {
    const v = vault();
    const e = await fail(v.call("fetch", { id }));
    expect(["validation_error", "invalid_input", "path_traversal", "invalid_path"]).toContain(
      e.code,
    );
  });

  it("an unknown vault in the id is vault_not_found", async () => {
    const v = vault();
    const e = await fail(v.call("fetch", { id: "ghost:projects/zebra.md" }));
    expect(e.code).toBe("vault_not_found");
  });

  it("a vault-bound caller cannot fetch another vault's note through the id", async () => {
    const v = vault();
    v.vaultRegistry.register({ id: "other", path: v.root });
    const e = await fail(v.call("fetch", { id: "other:projects/zebra.md" }, { vaultBound: true }));
    expect(e.code).toBe("forbidden");
    await ok(v.call("fetch", { id: "test:projects/zebra.md" }, { vaultBound: true }));
  });

  it("runs under the NAMED vault's own ACL, not the caller's default one", async () => {
    const v = vault({ aclByVault: { locked: { readPaths: ["nothing"] } } });
    v.vaultRegistry.register({ id: "locked", path: v.root });
    await ok(v.call("fetch", { id: "test:projects/zebra.md" }));
    const e = await fail(v.call("fetch", { id: "locked:projects/zebra.md" }));
    expect(e.code).toBe("acl_denied");
  });
});

describe("citation url", () => {
  it("builds the https form from publicUrl and rejects unsafe values in the config schema", () => {
    const base = { id: "v", path: "/tmp/v" };
    expect(
      VaultConfigSchema.safeParse({ ...base, publicUrl: "https://notes.example.com" }).success,
    ).toBe(true);
    for (const bad of [
      "http://notes.example.com",
      "https://u:p@notes.example.com",
      "https://notes.example.com/?q=1",
      "https://notes.example.com/#frag",
      "javascript:alert(1)",
      "notes.example.com",
    ])
      expect(VaultConfigSchema.safeParse({ ...base, publicUrl: bad }).success, bad).toBe(false);
  });

  it("encodes characters that would otherwise change the url's meaning", async () => {
    const v = vault();
    v.vaultRegistry.register({ id: "pub", path: v.root, publicUrl: "https://notes.example.com" });
    v.write("a b/c#d?e%f&g.md", "# Odd\n\nunusualtoken\n");
    const data = await ok(v.call("search", { vault: "pub", query: "unusualtoken" }));
    expect(data.results[0].url).toBe("https://notes.example.com/a%20b/c%23d%3Fe%25f%26g");
    const plain = await ok(v.call("search", { vault: "test", query: "unusualtoken" }));
    expect(plain.results[0].url).toBe(
      "obsidian://open?vault=test&file=a%20b%2Fc%23d%3Fe%25f%26g.md",
    );
  });
});

describe("stored ACL identity (acl_path), fail closed", () => {
  const PATH = "wiki/x.md";
  async function world(acls: { chunks: string | null; notes: string | null }) {
    const root = makeTempDir("obtc-sf-ident-");
    cleanups.push(() => rmTemp(root));
    mkdirSync(dirname(join(root, PATH)), { recursive: true });
    writeFileSync(join(root, PATH), "# X\n\nzebra marker body\n");
    const db = openMemoryDb();
    provisionCacheDb(db);
    const provider = fakeEmbeddingProvider({ dimensions: 32 });
    const representation = buildRepresentationManifest(provider, {});
    await indexVault({ db, provider, representation, vaultId: "v", root, isReadable: () => true });
    db.prepare("UPDATE chunks SET acl_path = ? WHERE vault_id = ? AND path = ?").run(
      acls.chunks,
      "v",
      PATH,
    );
    db.prepare("UPDATE notes SET acl_path = ? WHERE vault_id = ? AND path = ?").run(
      acls.notes,
      "v",
      PATH,
    );
    const registry = new ToolRegistry({});
    registerM2Tools(registry, {
      vaultRegistry: new VaultRegistry([{ id: "v", path: root }]),
      embeddingProvider: provider,
      representation,
      metadataIndex: { hasFts: true, ready: () => true },
    });
    return async (readPaths: string[]) => {
      const ctx: CallerContext = {
        caller: "t",
        authenticated: true,
        grantedScopes: new Set(["read:notes"]),
        vaultId: "v",
        db,
        acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths }),
      };
      const data = await ok(registry.dispatch("search", { vault: "v", query: "zebra" }, ctx));
      return data.results.map((r: { id: string }) => r.id) as string[];
    };
  }
  const WIKI = ["wiki", "wiki/**"];
  const PRIVATE = ["private", "private/**"];

  it("an agreeing self identity is returned to its reader", async () => {
    expect(await (await world({ chunks: PATH, notes: PATH }))(WIKI)).toEqual([`v:${PATH}`]);
  });
  it("chunks/notes disagreement is hidden from both readers", async () => {
    const call = await world({ chunks: PATH, notes: "private/x.md" });
    expect(await call(PRIVATE)).toEqual([]);
    expect(await call(WIKI)).toEqual([]);
  });
  it("an unresolved identity (NULL or empty) is never returned", async () => {
    expect(await (await world({ chunks: null, notes: null }))(WIKI)).toEqual([]);
    expect(await (await world({ chunks: "", notes: "" }))(WIKI)).toEqual([]);
  });
  it.skipIf(process.platform === "win32")(
    "a symlink alias is judged on its target: fetch refuses it exactly as read_note does",
    async () => {
      const v = vault({
        files: { "private/x.md": "# X\n\nzebra marker body\n" },
        setup: (root) => symlinkSync(join(root, "private"), join(root, "wiki")),
        acl: { readPaths: ["wiki", "wiki/**"] },
      });
      const viaRead = await fail(v.call("read_note", { vault: "test", path: "wiki/x.md" }));
      const viaFetch = await fail(v.call("fetch", { id: "test:wiki/x.md" }));
      expect(viaRead.code).toBe("acl_denied");
      expect(viaFetch).toEqual(viaRead);
      const found = await ok(v.call("search", { vault: "test", query: "zebra" }));
      expect(found.results).toEqual([]);
    },
  );
});

describe("wire shape and surfaces", () => {
  async function connect(
    facadeMode: "triad" | "domain" | "flat",
    over: Partial<CallerContext> = {},
  ) {
    const v = vault({ registryOpts: { visibleVaultIds: () => ["test"] } });
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: v.registry,
      vaultRegistry: v.vaultRegistry,
      context: () => v.ctx(over),
      visibility: { grantedScopes: new Set(["*"]) },
      facadeMode,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "chatgpt-test", version: "0" });
    await client.connect(ct);
    cleanups.push(() => {
      void client.close();
      void server.close();
    });
    return { client, v };
  }

  it("search and fetch results carry the documented object in structuredContent AND as JSON text", async () => {
    const { client } = await connect("triad");
    const s = (await client.callTool({ name: "search", arguments: { query: "zebra" } })) as any;
    expect(s.isError).toBeFalsy();
    expect(s.content).toHaveLength(1);
    expect(s.content[0].type).toBe("text");
    expect(JSON.parse(s.content[0].text)).toEqual(s.structuredContent);
    DocumentedSearch.parse(s.structuredContent);
    const id = s.structuredContent.results[0].id as string;
    const f = (await client.callTool({ name: "fetch", arguments: { id } })) as any;
    expect(f.isError).toBeFalsy();
    expect(JSON.parse(f.content[0].text)).toEqual(f.structuredContent);
    DocumentedFetch.parse(f.structuredContent);
  });

  it("advertises an object-rooted outputSchema for both, and the documented required fields", async () => {
    const { client } = await connect("triad");
    const tools = (await client.listTools()).tools;
    const search = tools.find((t) => t.name === "search");
    const fetchTool = tools.find((t) => t.name === "fetch");
    expect(search).toBeDefined();
    expect(fetchTool).toBeDefined();
    const s = search?.outputSchema as any;
    const f = fetchTool?.outputSchema as any;
    expect(s.type).toBe("object");
    expect(f.type).toBe("object");
    expect(search?.inputSchema.required).toContain("query");
    expect(fetchTool?.inputSchema.required).toEqual(["id"]);
    const item = s.properties.results.items;
    expect(item.required).toEqual(expect.arrayContaining(["id", "title", "url"]));
    expect(f.required).toEqual(expect.arrayContaining(["id", "title", "text", "url"]));
    expect(search?.annotations?.readOnlyHint).toBe(true);
    expect(fetchTool?.annotations?.readOnlyHint).toBe(true);
  });

  it("triad advertises the three meta-tools plus search and fetch, and nothing else", async () => {
    const { client } = await connect("triad");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([
      "find_capability",
      "describe_capability",
      "call_capability",
      "search",
      "fetch",
    ]);
  });

  it("flat advertises them once each; domain keeps its domain tools and still routes a direct search call", async () => {
    const flat = await connect("flat");
    const flatNames = (await flat.client.listTools()).tools.map((t) => t.name);
    expect(flatNames.filter((n) => n === "search")).toHaveLength(1);
    expect(flatNames.filter((n) => n === "fetch")).toHaveLength(1);
    const dom = await connect("domain");
    const domNames = (await dom.client.listTools()).tools.map((t) => t.name);
    expect(domNames).not.toContain("fetch"); // reachable as an action of the search domain tool
    const direct = (await dom.client.callTool({
      name: "search",
      arguments: { query: "zebra" },
    })) as any;
    expect(direct.isError).toBeFalsy();
    DocumentedSearch.parse(direct.structuredContent);
    const viaDomain = (await dom.client.callTool({
      name: "search",
      arguments: { action: "search", args: { query: "zebra" } },
    })) as any;
    expect(viaDomain.isError).toBeFalsy();
    DocumentedSearch.parse(viaDomain.structuredContent);
  });

  it("both are callable through call_capability and listed by find_capability", async () => {
    const { client } = await connect("triad");
    const r = (await client.callTool({
      name: "call_capability",
      arguments: { name: "search", args: { query: "zebra" } },
    })) as any;
    DocumentedSearch.parse(r.structuredContent);
    const found = (await client.callTool({
      name: "find_capability",
      arguments: { query: "fetch note by id citation url" },
    })) as any;
    expect(JSON.stringify(found.structuredContent)).toContain("fetch");
  });

  it("the core profile keeps both (neither is non-core)", () => {
    expect(isNonCoreTool("search")).toBe(false);
    expect(isNonCoreTool("fetch")).toBe(false);
  });

  it("a caller who cannot see them is not advertised them in triad mode", async () => {
    const v = vault();
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: v.registry,
      context: () => v.ctx({ grantedScopes: new Set(["read:vault"]) }),
      visibility: { grantedScopes: new Set(["read:vault"]) },
      facadeMode: "triad",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    cleanups.push(() => {
      void client.close();
      void server.close();
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(["find_capability", "describe_capability", "call_capability"]);
  });
});
