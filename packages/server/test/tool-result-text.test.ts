// Every tools/call result, success and error, carries a non-empty text block that answers the call
// on its own. Codex drops `content` whenever `structuredContent` is present (and a client that
// renders only the text block never sees the structured half), so the guarantee has to hold at the
// ONE place every result leaves the server (mcp/tool-result.ts), not per tool.
//
// Three layers: (1) the REAL handlers: the response-format fixture's scenarios run the real tools
// over a real vault and the text is read back; (2) every registered tool: a schema-valid sample
// is built from the advertised outputSchema and pushed through the result builder, so a tool whose
// output cannot be rendered fails here by name; (3) the end-to-end server, for the degenerate
// shapes (null payloads, byte cap).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { errorToCallToolResult } from "../src/mcp/error-rendering";
import { toJson } from "../src/mcp/facade";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { ensureTextContent, NO_OUTPUT_TEXT, toolDataResult } from "../src/mcp/tool-result";
import { sampleFromJsonSchema } from "./json-schema-sample";
import { dataOf, makeWorld, runScenario, SCENARIOS, type World } from "./response-format-fixture";
import { UNADVERTISED_OUTPUTS } from "./schema-portability-rules";

vi.setConfig({ testTimeout: 60_000 });

const textOf = (r: CallToolResult): string =>
  r.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");

describe("real handlers: the text block alone answers the call", () => {
  const worlds: World[] = [];
  afterEach(() => {
    for (const w of worlds.splice(0)) w.cleanup();
  });

  it("covers a non-empty scenario set (existence floor)", () => {
    expect(SCENARIOS.length).toBeGreaterThan(50);
  });

  for (const s of SCENARIOS) {
    it(`${s.name}`, async () => {
      const w = await makeWorld();
      worlds.push(w);
      const data = dataOf(await runScenario(w, s, {}));
      const result = ensureTextContent(toolDataResult(data));
      const text = textOf(result);
      expect(text.trim().length).toBeGreaterThan(0);
      // Not a pointer at structuredContent: the text parses back to the same payload.
      expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(data)));
      expect(text).not.toMatch(/see structuredContent/i);
      // ...and it names the fields the caller needs.
      for (const k of Object.keys(data)) expect(text).toContain(`"${k}"`);
    });
  }
});

describe("every registered tool", () => {
  const registry = buildFullRegistry();
  const defs = registry.list();
  const validator = new AjvJsonSchemaValidator();

  it("checks a non-empty registry (existence floor)", () => {
    expect(defs.length).toBeGreaterThan(100);
  });

  it("builds a schema-valid, self-contained text block from its advertised outputSchema", () => {
    const failures: string[] = [];
    for (const def of defs) {
      if (!def.outputSchema) {
        failures.push(`${def.name}: no outputSchema`);
        continue;
      }
      const schema = toJson(def.outputSchema);
      if (schema === undefined) {
        // Unconstrained output, not advertised (THE-1393): any JSON value, e.g. an array, still
        // reaches the client as its own JSON text.
        if (!UNADVERTISED_OUTPUTS.includes(def.name)) failures.push(`${def.name}: not advertised`);
        const text = textOf(ensureTextContent(toolDataResult([{ id: 1 }])));
        if (text !== '[{"id":1}]') failures.push(`${def.name}: array text was ${text}`);
        continue;
      }
      const sample = sampleFromJsonSchema(schema) as Record<string, unknown>;
      const check = validator.getValidator(schema as never)(sample);
      if (!check.valid) {
        failures.push(`${def.name}: sample invalid: ${check.errorMessage}`);
        continue;
      }
      const result = ensureTextContent(toolDataResult(sample));
      const text = textOf(result);
      if (text.trim().length === 0) failures.push(`${def.name}: empty text`);
      else if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(result.structuredContent))
        failures.push(`${def.name}: text is not the structured payload`);
    }
    expect(failures).toEqual([]);
  });

  it("an error result for each tool is readable text naming the code and the message", () => {
    for (const def of defs) {
      const e = err.validation(`bad input to ${def.name}`, { field: "path" }).toJSON();
      const text = textOf(ensureTextContent(errorToCallToolResult(e)));
      expect(text, def.name).toContain("validation_error");
      expect(text, def.name).toContain(`bad input to ${def.name}`);
    }
  });
});

describe("ensureTextContent (the central guarantee)", () => {
  it("leaves a result that already has a text block untouched (same object)", () => {
    const r: CallToolResult = { content: [{ type: "text", text: "hello" }], structuredContent: {} };
    expect(ensureTextContent(r)).toBe(r);
  });

  it("renders structuredContent as compact JSON when content is empty", () => {
    const r = ensureTextContent({ content: [], structuredContent: { a: 1, b: [2] } });
    expect(textOf(r)).toBe('{"a":1,"b":[2]}');
  });

  it("treats a blank text block as missing, and keeps non-text blocks", () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    const r = ensureTextContent({
      content: [{ type: "text", text: "  " }, image],
      structuredContent: { ok: true },
    });
    expect(textOf(r)).toBe('{"ok":true}');
    expect(r.content).toContainEqual(image);
  });

  it("gives an error with no detail at all a sentence, and keeps isError", () => {
    const r = ensureTextContent({ content: [], isError: true });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/error/i);
  });

  it("gives a success with no payload at all a sentence (not the literal 'null')", () => {
    expect(textOf(ensureTextContent(toolDataResult(null)))).not.toBe("null");
    expect(textOf(ensureTextContent(toolDataResult(undefined)))).toMatch(/\S/);
  });

  it("does not touch an incomplete / task result (resultType is the client's discriminator)", () => {
    const r = { resultType: "input_required", inputRequests: {}, content: [] } as never;
    expect(ensureTextContent(r)).toBe(r);
  });
});

describe("end to end through the server", () => {
  const context = (): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db: {} as never,
  });
  const def = (name: string, handler: () => unknown, extra: Partial<ToolDefinition> = {}) =>
    ({
      name,
      description: `${name} desc`,
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      handler,
      ...extra,
    }) as unknown as ToolDefinition;

  async function connect(registry: ToolRegistry) {
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry,
      context,
      visibility: { grantedScopes: new Set(["*"]) },
      facadeMode: "flat",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    return { client, server };
  }

  it("a tool with no payload still answers in words", async () => {
    const r = new ToolRegistry();
    r.register(def("silent", () => null));
    const { client, server } = await connect(r);
    const res = await client.callTool({ name: "silent", arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).not.toBe("null");
    expect(text.trim().length).toBeGreaterThan(0);
    await client.close();
    await server.close();
  });

  it("a structured success carries the payload as text beside structuredContent", async () => {
    const outputSchema = z.object({ title: z.string(), n: z.number() }).strict();
    const r = new ToolRegistry();
    r.register(def("rich", () => ({ title: "Hello", n: 3 }), { outputSchema }));
    const { client, server } = await connect(r);
    const res = await client.callTool({ name: "rich", arguments: {} });
    expect(res.structuredContent).toEqual({ title: "Hello", n: 3 });
    expect((res.content as { text: string }[])[0]?.text).toBe('{"title":"Hello","n":3}');
    await client.close();
    await server.close();
  });

  it("the byte cap still bounds the result: the over-cap payload is refused, not echoed", async () => {
    const r = new ToolRegistry({ maxResponseBytes: 2_000 });
    r.register(def("big", () => ({ blob: "x".repeat(50_000) })));
    const { client, server } = await connect(r);
    const res = await client.callTool({ name: "big", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res).length).toBeLessThan(8_000);
    await client.close();
    await server.close();
  });

  it("the cap governs the sentence a payload-less success sends, not the literal 'null'", async () => {
    // Codex review of #1191: with maxResponseBytes 4, "null" fit and the 44-byte sentence went out.
    const tight = new ToolRegistry({ maxResponseBytes: 4 });
    tight.register(def("silent", () => null));
    const a = await connect(tight);
    const over = await a.client.callTool({ name: "silent", arguments: {} });
    expect(over.isError).toBe(true);
    await a.client.close();
    await a.server.close();

    const exact = new ToolRegistry({ maxResponseBytes: Buffer.byteLength(NO_OUTPUT_TEXT) });
    exact.register(def("silent", () => undefined));
    const b = await connect(exact);
    const ok = await b.client.callTool({ name: "silent", arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect((ok.content as { text: string }[])[0]?.text).toBe(NO_OUTPUT_TEXT);
    await b.client.close();
    await b.server.close();
  });

  it("a payload just under the cap is carried once as text and once as structuredContent", async () => {
    const r = new ToolRegistry({ maxResponseBytes: 4_000 });
    r.register(def("fits", () => ({ blob: "y".repeat(3_000) })));
    const { client, server } = await connect(r);
    const res = await client.callTool({ name: "fits", arguments: {} });
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    expect(res.isError).toBeFalsy();
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(JSON.parse(text)).toEqual(res.structuredContent);
    await client.close();
    await server.close();
  });
});
