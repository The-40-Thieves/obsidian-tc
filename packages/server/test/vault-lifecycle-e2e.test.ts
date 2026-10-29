import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import type { Database } from "../src/db/types";
import { deterministicVector } from "../src/embeddings/fake";
import { buildServerRuntime, type ServerRuntime } from "../src/runtime/server-runtime";
import { AUDIENCE, HS_SECRET, MODERN, signHs } from "./hitl-wire-helpers";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "lifecycle";
const INITIAL_PATH = "Notes/Lifecycle.md";
const MOVED_PATH = "Archive/Lifecycle.md";
const WAIT_MS = stallTimeout(10_000);

function note(marker: string): string {
  return `# Lifecycle\n\n${Array.from(
    { length: 32 },
    (_, i) =>
      `Paragraph ${i} records ${marker} and a distinct observation about module boundaries.`,
  ).join("\n\n")}\n`;
}

type WireResult = {
  isError?: boolean;
  structuredContent?: unknown;
  requestState?: string;
  resultType?: string;
  content?: { type: string; text?: string }[];
};

function dataOf<T>(value: unknown): T {
  const result = value as WireResult;
  expect(result.isError, JSON.stringify(value)).not.toBe(true);
  expect(result.resultType, JSON.stringify(value)).not.toBe("input_required");
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (text === undefined) throw new Error(`Missing tool payload: ${JSON.stringify(value)}`);
  return JSON.parse(text) as T;
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP port"));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function embeddingFixture() {
  const batches: string[][] = [];
  const server = createHttpServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/api/embed") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const part of request) body += part.toString();
      const { input } = JSON.parse(body) as { input: string[] };
      batches.push([...input]);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ embeddings: input.map((text) => deterministicVector(text, 32)) }),
      );
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No embedding fixture port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    batches,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function confirmedCall(
  port: number,
  jwt: string,
  name: string,
  args: Record<string, unknown>,
  assertPending: () => void,
): Promise<unknown> {
  const call = async (requestState?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      signal: AbortSignal.timeout(stallTimeout(5_000)),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${jwt}`,
        "mcp-protocol-version": MODERN,
        "mcp-method": "tools/call",
        "mcp-name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientInfo": { name: "vault-lifecycle", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
          },
          ...(requestState
            ? {
                requestState,
                inputResponses: { confirm: { action: "accept", content: { approve: true } } },
              }
            : {}),
        },
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const event = text.split("\n").find((line) => line.startsWith("data: "));
    const message = JSON.parse(event ? event.slice(6) : text) as {
      error?: unknown;
      result: WireResult;
    };
    expect(message.error, text).toBeUndefined();
    return message.result;
  };
  const offered = await call();
  expect(offered.resultType).toBe("input_required");
  expect(offered.requestState).toBeTypeOf("string");
  assertPending();
  return dataOf(await call(offered.requestState));
}

type ChunkRow = {
  chunk_index: string;
  content: string;
  content_hash: string;
  token_count: number;
  model: string;
  embedding: string;
};

function chunks(db: Database, path: string): ChunkRow[] {
  return db
    .prepare(
      `SELECT c.chunk_index, c.content, c.content_hash, c.token_count, e.model, hex(e.embedding) AS embedding
       FROM chunks c LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1
       WHERE c.vault_id = ? AND c.path = ? ORDER BY c.chunk_index`,
    )
    .all(VAULT, path) as ChunkRow[];
}

describe.each(["legacy", "modular"] as const)("vault lifecycle over HTTP (%s indexing)", (mode) => {
  it(
    "indexes writes, confirms mutations, survives restart, watches edits, and removes deleted results",
    async () => {
      const vault = makeTempDir("otc-life-v-");
      const cache = makeTempDir("otc-life-c-");
      const embeddings = await embeddingFixture();
      const jwt = await signHs();
      let runtime: ServerRuntime | undefined;
      let client: Client | undefined;
      let db: Database | undefined;
      let port = 0;
      const database = () => {
        if (!db) throw new Error("Cache not open");
        return db;
      };
      const boot = async (watch: boolean) => {
        port = await freePort();
        const config = ServerConfigSchema.parse({
          vaults: [{ id: VAULT, path: vault }],
          cacheDir: cache,
          auth: { mode: "jwt", jwtSecret: HS_SECRET, audience: AUDIENCE },
          transports: { stdio: false, http: { enabled: true, host: "127.0.0.1", port } },
          embeddings: {
            provider: "ollama",
            model: "lifecycle-fixture",
            baseUrl: embeddings.baseUrl,
            dimensions: 32,
            batchSize: 2,
            concurrency: 1,
            maxBatchTokens: 192,
            chunkContext: true,
          },
          indexing: {
            chunkTokens: 64,
            writePreparation: mode,
            backgroundEmbed: { mode: "immediate" },
          },
          watch: { enabled: watch, debounceMs: 25 },
          throttle: { enabled: false },
          maintenance: { enabled: false },
          plane: { enabled: false },
          telemetry: { enabled: false },
        });
        expect(config.indexing.writePreparation).toBe(mode);
        runtime = await buildServerRuntime(config, undefined);
        await runtime.start();
        client = new Client({ name: "vault-lifecycle", version: "1.0.0" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${jwt}` } },
          }),
          { timeout: stallTimeout(5_000) },
        );
        db = await openDatabase(join(cache, "cache.db"), undefined, { readonly: true });
        await expect
          .poll(async () => (await call<{ reconcile: string }>("get_index_status")).reconcile, {
            timeout: WAIT_MS,
            interval: 50,
          })
          .toBe("ok");
      };
      const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
        if (!client) throw new Error("Client not connected");
        return dataOf<T>(
          await client.callTool({ name, arguments: args }, undefined, {
            timeout: stallTimeout(5_000),
          }),
        );
      };
      const search = async (query: string) => [
        ...new Set(
          (
            await call<{ items: { path: string }[] }>("search_text", {
              vault: VAULT,
              query,
            })
          ).items.map((item) => item.path),
        ),
      ];
      const indexed = async (query: string, path: string) => {
        await expect.poll(() => search(query), { timeout: WAIT_MS, interval: 50 }).toEqual([path]);
        await expect
          .poll(
            () => {
              const rows = chunks(database(), path);
              return (
                rows.length > 0 &&
                rows.every(
                  (row) =>
                    row.content.includes(query) &&
                    row.token_count <= 64 &&
                    row.embedding.length > 0,
                )
              );
            },
            { timeout: WAIT_MS, interval: 50 },
          )
          .toBe(true);
        const semantic = await call<{ items: { path: string }[] }>("search_semantic", {
          vault: VAULT,
          query,
          k: 5,
        });
        expect(semantic.items.map((item) => item.path)).toContain(path);
        const status = await call<{ write_failures: number }>("get_index_status");
        expect(status.write_failures).toBe(0);
      };
      const close = async () => {
        const closingClient = client;
        const closingDb = db;
        const closingRuntime = runtime;
        client = undefined;
        db = undefined;
        runtime = undefined;
        try {
          await closingClient?.close();
        } finally {
          try {
            closingDb?.close?.();
          } finally {
            await closingRuntime?.close("lifecycle test");
          }
        }
      };
      try {
        // Settle boot with the watcher disabled so neither can repair a broken index-on-write hook.
        await boot(false);
        const original = note("celestialneedle");
        await call("write_note", { vault: VAULT, path: INITIAL_PATH, content: original });
        expect(readFileSync(join(vault, INITIAL_PATH), "utf8")).toBe(original);
        await indexed("celestialneedle", INITIAL_PATH);
        expect(chunks(database(), INITIAL_PATH).length).toBeGreaterThan(4);
        expect(embeddings.batches.some((batch) => batch.length === 2)).toBe(true);
        for (const batch of embeddings.batches) {
          expect(batch.length).toBeLessThanOrEqual(2);
          expect(
            batch.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
          ).toBeLessThanOrEqual(192);
        }

        const revised = note("orchardneedle");
        await confirmedCall(
          port,
          jwt,
          "write_note",
          {
            vault: VAULT,
            path: INITIAL_PATH,
            content: revised,
            mode: "overwrite",
          },
          () => expect(readFileSync(join(vault, INITIAL_PATH), "utf8")).toBe(original),
        );
        await indexed("orchardneedle", INITIAL_PATH);
        expect(await search("celestialneedle")).toEqual([]);

        await confirmedCall(
          port,
          jwt,
          "move_note",
          { vault: VAULT, from: INITIAL_PATH, to: MOVED_PATH },
          () => {
            expect(existsSync(join(vault, INITIAL_PATH))).toBe(true);
            expect(existsSync(join(vault, MOVED_PATH))).toBe(false);
          },
        );
        await indexed("orchardneedle", MOVED_PATH);
        expect(existsSync(join(vault, INITIAL_PATH))).toBe(false);
        expect(chunks(database(), INITIAL_PATH)).toEqual([]);
        const persisted = chunks(database(), MOVED_PATH);
        await close();
        await boot(true);
        expect(chunks(database(), MOVED_PATH)).toEqual(persisted);
        await indexed("orchardneedle", MOVED_PATH);

        // An external editor bypasses tools; only the real watcher can observe this post-boot change.
        writeFileSync(join(vault, MOVED_PATH), note("watcherneedle"), "utf8");
        await indexed("watcherneedle", MOVED_PATH);
        expect(await search("orchardneedle")).toEqual([]);
        await confirmedCall(port, jwt, "delete_note", { vault: VAULT, path: MOVED_PATH }, () => {
          expect(existsSync(join(vault, MOVED_PATH))).toBe(true);
        });
        await expect
          .poll(() => search("watcherneedle"), { timeout: WAIT_MS, interval: 50 })
          .toEqual([]);
        await expect
          .poll(() => chunks(database(), MOVED_PATH), { timeout: WAIT_MS, interval: 50 })
          .toEqual([]);
        const deletedSearch = await call<{ items: { path: string }[] }>("search_semantic", {
          vault: VAULT,
          query: "watcherneedle",
          k: 5,
        });
        expect(deletedSearch.items.map((item) => item.path)).not.toContain(MOVED_PATH);
        expect(existsSync(join(vault, MOVED_PATH))).toBe(false);
        expect(existsSync(join(vault, ".trash", MOVED_PATH))).toBe(true);
        const events = database().prepare("SELECT tool_name, status FROM event_log").all() as {
          tool_name: string;
          status: string;
        }[];
        for (const name of [
          "write_note",
          "move_note",
          "delete_note",
          "search_text",
          "search_semantic",
        ]) {
          expect(
            events.some((event) => event.tool_name === name && event.status === "ok"),
            name,
          ).toBe(true);
        }
        expect(events.some((event) => event.tool_name === "index_vault")).toBe(false);
        expect((await call<{ write_failures: number }>("get_index_status")).write_failures).toBe(0);
      } finally {
        try {
          await close();
        } finally {
          try {
            await embeddings.close();
          } finally {
            rmTemp(vault);
            rmTemp(cache);
          }
        }
      }
    },
    stallTimeout(30_000),
  );
});
