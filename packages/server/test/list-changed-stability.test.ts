// notifications/{tools,prompts,resources}/list_changed churn.
//
// Visual Studio resets every tool approval on list_changed, and claude.ai re-prompts when a tool's
// description hash moves. This server declares `listChanged: true` (SEP-2575 needs it for a
// `subscriptions/listen` filter to be real) but its tool surface is fixed for a process lifetime and
// a caller's visible subset is fixed by its auth, so the correct number of list_changed
// notifications over a session is ZERO. This pins that on the wire for every facade mode, and pins
// the source so a future emitter must come with a deliberate change here (and a "real change of the
// caller's visible set" condition).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { VaultRegistry } from "../src/vault/registry";
import { makeTempDir, rmTemp } from "./tmp";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function tool(name: string, domain: string, scopes: string[] = []): ToolDefinition {
  return {
    name,
    domain,
    description: `Does ${name}.`,
    inputSchema: z.object({}).strict(),
    requiredScopes: scopes,
    handler: () => ({ ok: true }),
  } as unknown as ToolDefinition;
}

function vault(): VaultRegistry {
  const dir = makeTempDir("otc-listchanged-");
  dirs.push(dir);
  return new VaultRegistry(
    ServerConfigSchema.parse({ vaults: [{ id: "main", path: dir }] }).vaults,
  );
}

async function connect(mode: "flat" | "triad" | "domain", scopes: string[]) {
  const registry = new ToolRegistry();
  registry.register(tool("read_note", "notes", ["read:notes"]));
  registry.register(tool("write_note", "notes", ["write:notes"]));
  registry.register(tool("search_text", "search", ["read:notes"]));
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context: (): CallerContext => ({
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(scopes),
      vaultId: "main",
      db: {} as never,
    }),
    visibility: { grantedScopes: new Set(scopes) },
    vaultRegistry: vault(),
    facadeMode: mode,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  const seen: string[] = [];
  client.fallbackNotificationHandler = async (n) => {
    seen.push(n.method);
  };
  await client.connect(ct);
  return { client, server, seen };
}

const tick = () => new Promise((r) => setTimeout(r, 25));

describe("list_changed is never emitted during a session", () => {
  for (const mode of ["flat", "triad", "domain"] as const) {
    it(`${mode}: list, list again, call, read resources and prompts, no list_changed`, async () => {
      const { client, server, seen } = await connect(mode, ["read:notes"]);
      expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
      const first = (await client.listTools()).tools.map((t) => t.name);
      await client.listResources();
      await client.listPrompts();
      await client.callTool({
        name: mode === "triad" ? "find_capability" : "read_note",
        arguments: mode === "triad" ? { query: "read" } : {},
      });
      const second = (await client.listTools()).tools.map((t) => t.name);
      await tick();
      expect(second).toEqual(first);
      expect(seen.filter((m) => m.endsWith("/list_changed"))).toEqual([]);
      await client.close();
      await server.close();
    });
  }

  it("two callers with different scopes see different sets and still get no notification", async () => {
    const reader = await connect("flat", ["read:notes"]);
    const writer = await connect("flat", ["read:notes", "write:notes"]);
    const r = (await reader.client.listTools()).tools.map((t) => t.name);
    const w = (await writer.client.listTools()).tools.map((t) => t.name);
    expect(w.length).toBeGreaterThan(r.length);
    await tick();
    expect(reader.seen).toEqual([]);
    expect(writer.seen).toEqual([]);
    for (const c of [reader, writer]) {
      await c.client.close();
      await c.server.close();
    }
  });

  it("positive control: the harness does observe a notification when one is sent", async () => {
    const { client, server, seen } = await connect("flat", ["read:notes"]);
    await server.sendToolListChanged();
    await tick();
    expect(seen).toEqual(["notifications/tools/list_changed"]);
    await client.close();
    await server.close();
  });
});

describe("no source path emits list_changed", () => {
  const EMITTER =
    /sendToolListChanged|sendResourceListChanged|sendPromptListChanged|notifications\/(?:tools|resources|prompts)\/list_changed|\btoolsListChanged\b|\bresourcesListChanged\b|\bpromptsListChanged\b/;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) return sourceFiles(p);
      return p.endsWith(".ts") && !p.endsWith(".d.ts") ? [p] : [];
    });
  }

  it("scans the real source tree and finds no emitter in code (comments excluded)", () => {
    const files = sourceFiles(new URL("../src", import.meta.url).pathname);
    // Existence floor: an empty walk would pass vacuously.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith("/mcp/server.ts"))).toBe(true);
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return [];
          return EMITTER.test(line) ? [`${f}:${i + 1}: ${t}`] : [];
        }),
    );
    expect(hits).toEqual([]);
  });

  it("the scan pattern recognizes each emitter shape (red cases)", () => {
    for (const line of [
      "await server.sendToolListChanged();",
      "server.sendResourceListChanged()",
      "server.sendPromptListChanged()",
      'notify({ method: "notifications/tools/list_changed" })',
      "notify({ toolsListChanged: true })",
    ])
      expect(EMITTER.test(line), line).toBe(true);
    expect(EMITTER.test("tools: { listChanged: true },")).toBe(false);
  });
});
