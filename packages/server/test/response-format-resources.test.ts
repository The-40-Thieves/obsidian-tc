// GH #1027 part 2: response_format on resource reads.
//   - resources/read carries no parameters, so only tools.defaults.responseFormat can select the
//     concise shape there (server option -> readResourceFor -> readResource); the read_resources
//     tool takes the per-call parameter (response-format-tools.test.ts covers its shapes).
//   - unset / detailed is byte-identical to before: the raw markdown, frontmatter included.
//   - concise changes ONLY the text (the body, no frontmatter block): the scope, vault-binding,
//     folder ACL and the size ceiling (judged on the RAW size) and the SEP-2549 cache hint are the
//     same for both.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import type { CallerContext } from "../src/mcp/registry";
import { buildResourceUri, readResource, readResourceFor } from "../src/mcp/resources";
import { createMcpServer } from "../src/mcp/server";
import { startHttp } from "../src/transports/http";
import { makeTestVault, type TestVault } from "./m1-helpers";

const NOTE = "---\ntitle: Alpha\ntags:\n  - x\n---\n# Alpha\n\nbody text\n";
const FILES = { "a.md": NOTE, "plain.md": "no frontmatter here\n", "secret/s.md": NOTE };
const BODY = "# Alpha\n\nbody text\n";

const vaults: TestVault[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const v of vaults.splice(0)) v.cleanup();
});

function vault(over: Parameters<typeof makeTestVault>[0] = {}): TestVault {
  const v = makeTestVault({ files: FILES, ...over });
  vaults.push(v);
  return v;
}

async function connect(v: TestVault, responseFormat?: "concise" | "detailed") {
  const context = (): CallerContext => v.ctx();
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry: v.registry,
    context,
    visibility: { grantedScopes: new Set(context().grantedScopes) },
    vaultRegistry: v.vaultRegistry,
    facadeMode: "triad",
    ...(responseFormat ? { responseFormat } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("resources/read follows the config default (no per-call parameter exists)", () => {
  it("no config default: the raw markdown, frontmatter included (byte-identical to before)", async () => {
    const c = await connect(vault());
    const r = await c.readResource({ uri: buildResourceUri("test", "a.md") });
    expect(r.contents[0]).toMatchObject({ mimeType: "text/markdown", text: NOTE });
  });

  it("config detailed: identical to no default", async () => {
    const c = await connect(vault(), "detailed");
    const r = await c.readResource({ uri: buildResourceUri("test", "a.md") });
    expect(r.contents[0]).toMatchObject({ text: NOTE });
  });

  it("config concise: the body without the frontmatter block; uri and mimeType kept", async () => {
    const c = await connect(vault(), "concise");
    const r = await c.readResource({ uri: buildResourceUri("test", "a.md") });
    expect(r.contents).toHaveLength(1);
    expect(r.contents[0]).toMatchObject({
      uri: buildResourceUri("test", "a.md"),
      mimeType: "text/markdown",
      text: BODY,
    });
  });

  it("config concise: a note with no frontmatter reads back unchanged", async () => {
    const c = await connect(vault(), "concise");
    const r = await c.readResource({ uri: buildResourceUri("test", "plain.md") });
    expect(r.contents[0]).toMatchObject({ text: FILES["plain.md"] });
  });

  it("the folder ACL still denies under concise", async () => {
    const v = vault({
      centralAcl: true,
      aclByVault: { test: { readPaths: ["a.md"] } },
    });
    const c = await connect(v, "concise");
    await expect(
      c.readResource({ uri: buildResourceUri("test", "secret/s.md") }),
    ).rejects.toThrow();
    const ok = await c.readResource({ uri: buildResourceUri("test", "a.md") });
    expect(ok.contents[0]).toMatchObject({ text: BODY });
  });
});

describe("readResource: the size ceiling is judged on the raw size in both formats", () => {
  it("a note whose body fits but whose raw size does not is refused when concise", () => {
    const v = vault();
    const uri = buildResourceUri("test", "a.md");
    const ctx = v.ctx();
    const ceiling = Buffer.byteLength(BODY, "utf8") + 1; // the body fits, the raw note does not
    for (const format of ["detailed", "concise"] as const)
      expect(() =>
        readResource(v.vaultRegistry, ctx, uri, ceiling, (id) => v.registry.aclFor(id), format),
      ).toThrow(/exceeds/);
  });

  it("readResourceFor resolves the config default and ignores nothing else", () => {
    const v = vault();
    const uri = buildResourceUri("test", "a.md");
    const read = (rf?: "concise" | "detailed") =>
      readResourceFor(
        { registry: v.registry, ...(rf ? { responseFormat: rf } : {}) },
        v.vaultRegistry,
        v.ctx(),
        uri,
      ).contents[0];
    expect(read()).toMatchObject({ text: NOTE });
    expect(read("detailed")).toMatchObject({ text: NOTE });
    expect(read("concise")).toMatchObject({ text: BODY });
  });
});

const MODERN = "2026-07-28";
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "rf-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

describe("HTTP transport threads the config default to resources/read", () => {
  async function httpRead(responseFormat?: "concise", era: "legacy" | "modern" = "legacy") {
    const v = vault();
    const auth = ServerConfigSchema.parse({
      vaults: [{ id: "test", path: "/tmp/unused" }],
      auth: { mode: "none" },
    }).auth;
    const h = await startHttp({
      name: "obsidian-tc",
      version: "0.0.0-test",
      registry: v.registry,
      vaultRegistry: v.vaultRegistry,
      auth,
      db: v.db,
      vaultId: "test",
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
      host: "127.0.0.1",
      port: 0,
      ...(responseFormat ? { responseFormat } : {}),
    });
    closers.push(() => h.close());
    const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(era === "modern"
          ? {
              "mcp-protocol-version": MODERN,
              "mcp-method": "resources/read",
              "mcp-name": buildResourceUri("test", "a.md"),
            }
          : { "mcp-protocol-version": "2025-11-25" }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: {
          uri: buildResourceUri("test", "a.md"),
          ...(era === "modern" ? { _meta: MODERN_META } : {}),
        },
      }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(line ? line.slice(6) : text) as {
      result?: { contents: Array<{ text: string }>; ttlMs?: number; cacheScope?: string };
      error?: unknown;
    };
  }

  it("unset: raw markdown; concise: body only", async () => {
    const raw = await httpRead();
    expect(raw.error).toBeUndefined();
    expect(raw.result?.contents[0]?.text).toBe(NOTE);
    const concise = await httpRead("concise");
    expect(concise.result?.contents[0]?.text).toBe(BODY);
  });

  it("the SEP-2549 cache hint is the same in both formats", async () => {
    const detailed = await httpRead(undefined, "modern");
    const concise = await httpRead("concise", "modern");
    expect(detailed.error).toBeUndefined();
    expect(detailed.result?.cacheScope).toBe("private");
    expect(detailed.result?.ttlMs).toBeGreaterThanOrEqual(0);
    expect(concise.result?.contents[0]?.text).toBe(BODY);
    expect(concise.result?.cacheScope).toBe(detailed.result?.cacheScope);
    expect(concise.result?.ttlMs).toBe(detailed.result?.ttlMs);
  });
});
