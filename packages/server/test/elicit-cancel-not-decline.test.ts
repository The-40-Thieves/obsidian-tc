// An elicitation `cancel` is "dismissed without choosing", NOT "the user said no" (MCP elicitation
// spec, Response Actions: `decline` = "User explicitly declined the request", `cancel` = "User
// dismissed without making an explicit choice"). Claude Code headless advertises
// `elicitation:{form,url}` and auto-answers `cancel` ~5 ms after the server's elicitation/create,
// with no human involved. Mapping that to "declined, do not mint a token" made every HITL-gated
// write impossible for a headless client even when the operator had granted approval out of band.
//
// These tests drive REAL gated tools (delete_note: dispatch-level gate; move_note across folders
// and write_note mode=overwrite: handler-side gate in vault/hitl.ts) through the stdio legacy shim
// over an in-memory transport, so every route to the shared answer mapping
// (mcp/elicit-form.ts resolveElicitConfirmation -> mcp/server.ts dispatchToResult) is exercised.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, getDefaultElicitTtlSeconds, issueElicitToken } from "../src/elicit";
import { createElicitCodec } from "../src/elicit-request-state";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { registerM1Tools } from "../src/tools/m1";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "test";
const CALLER = "stdio";

type Answer = "accept" | "decline" | "cancel";

interface Case {
  tool: "delete_note" | "move_note" | "write_note";
  input: Record<string, unknown>;
  /** The state on disk before the call, and a probe that is true only when the write happened. */
  files: Record<string, string>;
  performed: (read: (rel: string) => string | undefined) => boolean;
}

const CASES: Case[] = [
  {
    tool: "delete_note",
    input: { vault: VAULT, path: "a.md" },
    files: { "a.md": "original" },
    performed: (read) => read("a.md") === undefined,
  },
  {
    tool: "move_note",
    input: { vault: VAULT, from: "a.md", to: "archive/b.md" },
    files: { "a.md": "original" },
    performed: (read) => read("archive/b.md") !== undefined,
  },
  {
    tool: "write_note",
    input: { vault: VAULT, path: "a.md", content: "new", mode: "overwrite" },
    files: { "a.md": "original" },
    performed: (read) => read("a.md") === "new",
  },
];

async function boot(files: Record<string, string>, capabilities: Record<string, unknown>) {
  const root = makeTempDir("obtc-cancel-");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry({
    verifyElicit: elicitVerifier,
    rootResolver: (id) => (id === VAULT ? root : undefined),
  });
  registerM1Tools(registry, {
    vaultRegistry: new VaultRegistry([{ id: VAULT, path: root }]),
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
  });
  const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
  const context = (): CallerContext => ({
    caller: CALLER,
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: VAULT,
    db,
    acl,
  });
  const server = createMcpServer({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    elicitCodec: createElicitCodec(randomBytes(32).toString("hex"), getDefaultElicitTtlSeconds()),
    legacyElicitationShim: true,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "headless", version: "1.0.0" }, { capabilities });
  const legs = { count: 0 };
  return {
    root,
    db,
    client,
    legs,
    connect: async (answer?: Answer) => {
      if (answer !== undefined) {
        client.setRequestHandler(ElicitRequestSchema, async () => {
          legs.count += 1;
          return answer === "accept"
            ? { action: "accept", content: { approve: true } }
            : { action: answer };
        });
      }
      await client.connect(clientTransport);
    },
    read: (rel: string): string | undefined =>
      existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : undefined,
    close: async () => {
      await client.close();
      await server.close();
      rmTemp(root);
    },
  };
}

const textOf = (res: unknown): string =>
  (res as { content: Array<{ text: string }> }).content[0]?.text ?? "";
const structured = (res: unknown): Record<string, unknown> =>
  (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};

describe.each(CASES)("elicitation answers on $tool", (c) => {
  it("cancel: approval NOT obtained, write refused, message AND recovery give the mint route", async () => {
    const b = await boot(c.files, { elicitation: { form: {}, url: {} } });
    try {
      await b.connect("cancel");
      const res = await b.client.callTool({ name: c.tool, arguments: c.input });
      expect(res.isError).toBe(true);
      expect(b.legs.count).toBe(1);
      expect(c.performed(b.read)).toBe(false);
      const text = textOf(res);
      expect(text).not.toMatch(/declined/i);
      expect(text).not.toMatch(/do not mint/i);
      expect(text).toContain(`confirm with: obsidian-tc elicit --hash `);
      expect(text).toContain(`--tool ${c.tool}`);
      const sc = structured(res);
      expect(sc.code).toBe("elicit_required");
      expect((sc.details as { reason?: string }).reason).toBe("approval_not_obtained");
      expect(String(sc.recovery)).toContain("obsidian-tc elicit");
      expect(String(sc.recovery)).not.toMatch(/declined|do not mint/i);
    } finally {
      await b.close();
    }
  });

  it("decline: hard stop, no mint route, unchanged text", async () => {
    const b = await boot(c.files, { elicitation: {} });
    try {
      await b.connect("decline");
      const res = await b.client.callTool({ name: c.tool, arguments: c.input });
      expect(res.isError).toBe(true);
      expect(b.legs.count).toBe(1);
      expect(c.performed(b.read)).toBe(false);
      const text = textOf(res);
      expect(text).toContain(
        "The user declined this change. Do not retry it and do not mint a token.",
      );
      expect(text).not.toContain("confirm with:");
      const sc = structured(res);
      expect((sc.details as { reason?: string }).reason).toBe("approval_declined");
      expect(String(sc.recovery)).toMatch(/do not mint/i);
      expect(String(sc.recovery)).not.toContain("obsidian-tc elicit");
    } finally {
      await b.close();
    }
  });

  it("accept: the write happens", async () => {
    const b = await boot(c.files, { elicitation: {} });
    try {
      await b.connect("accept");
      const res = await b.client.callTool({ name: c.tool, arguments: c.input });
      expect(res.isError).toBeFalsy();
      expect(c.performed(b.read)).toBe(true);
    } finally {
      await b.close();
    }
  });

  it("client without elicitation: same as cancel (refused, mint route, no decline text)", async () => {
    const b = await boot(c.files, {});
    try {
      await b.connect();
      const res = await b.client.callTool({ name: c.tool, arguments: c.input });
      expect(res.isError).toBe(true);
      expect(c.performed(b.read)).toBe(false);
      const text = textOf(res);
      expect(text).not.toMatch(/declined/i);
      expect(text).not.toContain("do not mint a token");
      expect(text).toContain("confirm with: obsidian-tc elicit --hash ");
      expect(String(structured(res).recovery)).toContain("obsidian-tc elicit");
    } finally {
      await b.close();
    }
  });
});

describe("cancel then the out-of-band token route (token path not weakened)", () => {
  it("a token minted after a cancel is bound to the call, redeems once, and is spent", async () => {
    const c = CASES[0] as Case;
    const b = await boot(c.files, { elicitation: { form: {}, url: {} } });
    try {
      await b.connect("cancel");
      const first = await b.client.callTool({ name: c.tool, arguments: c.input });
      const hash = (structured(first).details as { args_hash: string }).args_hash;
      const token = issueElicitToken(b.db, {
        vaultId: VAULT,
        toolName: c.tool,
        argsHash: hash,
        caller: CALLER,
      });

      // Bound: the token minted for a.md does not authorize a different path.
      writeFileSync(join(b.root, "other.md"), "other");
      const wrong = await b.client.callTool({
        name: c.tool,
        arguments: { vault: VAULT, path: "other.md", elicit_token: token },
      });
      expect(wrong.isError).toBe(true);
      expect(b.read("other.md")).toBe("other");

      // Redeems exactly once for the call it was minted for.
      const ok = await b.client.callTool({
        name: c.tool,
        arguments: { ...c.input, elicit_token: token },
      });
      expect(ok.isError).toBeFalsy();
      expect(c.performed(b.read)).toBe(true);

      writeFileSync(join(b.root, "a.md"), "recreated");
      const again = await b.client.callTool({
        name: c.tool,
        arguments: { ...c.input, elicit_token: token },
      });
      expect(again.isError).toBe(true);
      expect(b.read("a.md")).toBe("recreated");
    } finally {
      await b.close();
    }
  });
});
