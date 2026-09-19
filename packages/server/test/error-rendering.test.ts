// THE-1082 (GH #945): `elicit_required`'s text channel (THE-823: real MCP clients drop
// `structuredContent` on an isError result) rendered the bare "human confirmation required"
// sentence and nothing else, so a client with no MCP elicitation support (Claude Code over stdio
// among them) had `args_hash` in `structuredContent` — which it never sees — and no route to the
// 2025-era `obsidian-tc elicit` token path #931 (THE-1037) made `call_capability` accept. This
// covers `formatErrorDetail`'s new `elicit_required` branch directly (full details, partial
// details), pins one non-elicit code's rendering byte-identical (the THE-1042 issues path this
// change must not touch), and proves the effect end to end through `errorToResult` — plus a
// regression guard that the modern SEP-2260 `inputRequired` round trip (`isModern && elicitCodec
// && canElicit`, `mcp/server.ts`) still short-circuits before `errorToResult` ever runs.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { formatErrorDetail } from "../src/mcp/error-rendering";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { startHttp } from "../src/transports/http";
import { requireConfirmation } from "../src/vault/hitl";
import { openMemoryDb } from "./helpers";

describe("formatErrorDetail: elicit_required (THE-1082, GH #945)", () => {
  it("full details (hash + tool + vault): the exact obsidian-tc elicit invocation", () => {
    const detail = formatErrorDetail({
      code: "elicit_required",
      message: "human confirmation required",
      retryable: false,
      details: { args_hash: "abc123", tool: "write_note", vault: "v1" },
    });
    expect(detail).toBe(
      "confirm with: obsidian-tc elicit --config <path to your config> --hash abc123 --tool write_note --vault v1\n" +
        "then retry the same call with elicit_token: <token>",
    );
  });

  it("partial details (hash only): no --tool/--vault flags, not placeholders", () => {
    const detail = formatErrorDetail({
      code: "elicit_required",
      message: "human confirmation required",
      retryable: false,
      details: { args_hash: "abc123" },
    });
    expect(detail).toBe(
      "confirm with: obsidian-tc elicit --config <path to your config> --hash abc123\n" +
        "then retry the same call with elicit_token: <token>",
    );
    expect(detail).not.toContain("--tool");
    expect(detail).not.toContain("--vault");
  });

  it("no args_hash at all: nothing to render", () => {
    expect(
      formatErrorDetail({
        code: "elicit_required",
        message: "human confirmation required",
        retryable: false,
      }),
    ).toBeUndefined();
  });
});

describe("formatErrorDetail: non-elicit codes stay byte-identical (THE-1042, GH #935)", () => {
  it("validation_error (unrecognized_keys) renders exactly as before this change", () => {
    const schema = z.object({ path: z.string() }).strict();
    const result = schema.safeParse({ path: "a.md", bogus: 1 });
    if (result.success) throw new Error("expected a validation failure");
    const detail = formatErrorDetail({
      code: "validation_error",
      message: "input validation failed",
      retryable: false,
      details: { issues: result.error.issues },
    });
    const [firstIssue] = result.error.issues;
    if (!firstIssue) throw new Error("expected at least one issue");
    expect(detail).toBe(z.prettifyError(new z.ZodError([firstIssue])));
    expect(detail).not.toContain("obsidian-tc elicit");
  });

  it("vault_not_found (no issues, a vault hint): unaffected by the elicit branch", () => {
    const detail = formatErrorDetail({
      code: "vault_not_found",
      message: "vault not found",
      retryable: false,
      details: { did_you_mean: "auny" },
    });
    expect(detail).toBe('vault: did you mean "auny"?');
  });
});

/** A conditional-HITL tool — calls `requireConfirmation` from inside the handler (hitl.ts's own
 *  throw site, the one THE-1082 changed), rather than `destructive: true` (dispatch.ts's SEPARATE
 *  `elicit_required` throw, which carries only `args_hash` — see error-rendering.ts's comment on
 *  why that path renders fewer flags). */
function conditionalTool(name: string): ToolDefinition {
  return {
    name,
    description: "test-only conditional-HITL tool",
    inputSchema: z.object({ path: z.string() }),
    requiredScopes: [],
    handler: (input: { path: string }, ctx: CallerContext) => {
      requireConfirmation(ctx, name, input, true);
      return { wrote: input.path };
    },
  } as unknown as ToolDefinition;
}

function textOf(res: unknown): string {
  return (res as { content: [{ text: string }] }).content[0].text;
}

function structuredOf(res: unknown): Record<string, unknown> {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

describe("errorToResult (mcp/server.ts): the legacy/no-elicitation path renders the CLI line", () => {
  it("text carries the hash and the obsidian-tc elicit line; structuredContent is the plain error", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const registry = new ToolRegistry();
    registry.register(conditionalTool("conditional_write"));
    const context = (): CallerContext => ({
      caller: "test-caller",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v1",
      db,
    });
    // No `era`/`elicitCodec` — the default construction, matching every 2025-era or
    // elicitation-incapable caller (dispatchToResult's `isModern && opts.elicitCodec && canElicit`
    // guard is false here by construction, so this exercises `errorToResult`, not `inputRequired`).
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
    try {
      const res = await client.callTool({
        name: "conditional_write",
        arguments: { path: "a.md" },
      });
      expect(res.isError).toBe(true);
      const structured = structuredOf(res);
      expect(structured.code).toBe("elicit_required");
      const argsHash = (structured.details as { args_hash?: string } | undefined)?.args_hash;
      expect(typeof argsHash).toBe("string");
      expect((structured.details as { tool?: string }).tool).toBe("conditional_write");
      expect((structured.details as { vault?: string }).vault).toBe("v1");

      const text = textOf(res);
      expect(text).toContain(`Error [elicit_required]: human confirmation required`);
      expect(text).toContain(`--hash ${argsHash}`);
      expect(text).toContain("--tool conditional_write");
      expect(text).toContain("--vault v1");
      expect(text).toContain("obsidian-tc elicit");
      expect(text).toContain("retry the same call with elicit_token:");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("the modern SEP-2260 inputRequired path is unaffected (regression guard)", () => {
  const MODERN = "2026-07-28";
  const SECRET = "test-only-secret-not-a-real-credential-0123456789";

  async function boot() {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const registry = new ToolRegistry();
    registry.register(conditionalTool("conditional_write"));
    const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
    }).auth;
    return startHttp({
      name: "obsidian-tc",
      version: "0.0.0-test",
      registry,
      auth,
      db,
      vaultId: "v1",
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
      host: "127.0.0.1",
      port: 0,
    });
  }

  async function token(): Promise<string> {
    const { SignJWT } = await import("jose");
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: "agent-1",
      scopes: ["*"],
      aud: "http://test",
      iat: now,
      exp: now + 600,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(SECRET));
  }

  it("a modern, elicitation-capable client gets inputRequired, never the rendered text", async () => {
    const h = await boot();
    const jwt = await token();
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
          "mcp-protocol-version": MODERN,
          "mcp-method": "tools/call",
          "mcp-name": "conditional_write",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "conditional_write",
            arguments: { vault: "v1", path: "a.md" },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MODERN,
              "io.modelcontextprotocol/clientInfo": {
                name: "elicit-render-test",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
            },
          },
        }),
      });
      const text = await res.text();
      const line = text.split("\n").find((l) => l.startsWith("data: "));
      const body = JSON.parse(line ? line.slice(6) : text || "{}");
      expect(body.result?.resultType).toBe("input_required");
      expect(typeof body.result?.requestState).toBe("string");
      // Never the errorToResult text shape this PR added — the inputRequired branch in
      // dispatchToResult returns before errorToResult is ever called.
      expect(JSON.stringify(body.result)).not.toContain("obsidian-tc elicit");
    } finally {
      await h.close();
    }
  }, 25_000);
});
