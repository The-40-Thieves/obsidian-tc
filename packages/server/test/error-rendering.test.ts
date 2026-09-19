// THE-1082 (GH #945): `elicit_required`'s text channel (THE-823: real MCP clients drop
// `structuredContent` on an isError result) rendered the bare "human confirmation required"
// sentence and nothing else, so a client with no MCP elicitation support (Claude Code over stdio
// among them) had `args_hash` in `structuredContent` — which it never sees — and no route to the
// 2025-era `obsidian-tc elicit` token path #931 (THE-1037) made `call_capability` accept.
//
// Fix round 2 (cross-vendor review of the first commit) found the first fix was incomplete on two
// axes, both covered below:
//   - dispatch.ts's OWN `elicit_required` throw (the always-gated `destructive: true` path, 11+
//     tools) carried only `args_hash`, so its rendered line omitted `--tool` — a HARD requirement
//     of `obsidian-tc elicit` (cli/args.ts throws a CliError without it) — making the "main case
//     the issue was filed about" unusable.
//   - the rendered line was not paste-able: `--config <path to your config>` is shell redirection
//     syntax to a real shell, and `tool`/`vault` were interpolated with no quoting at all, although
//     a configured vault id is a plain unconstrained string (VaultConfigSchema.id), not the
//     stricter regex-constrained `VaultId` a tool's own `vault` ARGUMENT is validated against.
//
// This file covers: `formatErrorDetail`'s rendering directly (full details, no-vault, no-tool, no
// hash), one non-elicit code pinned byte-identical (THE-1042's issues path this must not touch),
// shell-quoting of unsafe tool/vault values, `proposed` never overriding the trusted fields
// (hitl.ts), BOTH throw sites end to end through `errorToResult`/`dispatch`, a real-shell
// paste-ability round trip through `parseCliArgs` + `planElicitMint` for both throw sites, and a
// regression guard that the modern SEP-2260 `inputRequired` round trip (`isModern && elicitCodec
// && canElicit`, `mcp/server.ts`) still short-circuits before `errorToResult` ever runs.
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ObsidianTcError,
  type ServerConfig,
  ServerConfigSchema,
} from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { type CliCommand, parseCliArgs } from "../src/cli/args";
import { planElicitMint } from "../src/cli/commands/elicit-mint";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { formatErrorDetail } from "../src/mcp/error-rendering";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { startHttp } from "../src/transports/http";
import { requireConfirmation } from "../src/vault/hitl";
import { openMemoryDb } from "./helpers";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

describe("formatErrorDetail: elicit_required (THE-1082, GH #945)", () => {
  it("full details (hash + tool + vault): the exact obsidian-tc elicit invocation, no --config", () => {
    const detail = formatErrorDetail({
      code: "elicit_required",
      message: "human confirmation required",
      retryable: false,
      details: { args_hash: "abc123", tool: "write_note", vault: "v1" },
    });
    expect(detail).toBe(
      "confirm with: obsidian-tc elicit --hash abc123 --tool write_note --vault v1\n" +
        "(reads OBSIDIAN_TC_CONFIG if set; otherwise add --config <path> or a vault/config path " +
        "positional argument)\n" +
        "then retry the same call with elicit_token: <token>",
    );
    const confirmLine = detail?.split("\n")[0];
    expect(confirmLine).not.toContain("--config");
    expect(detail).not.toContain("<path to your config>");
  });

  it("hash + tool, no vault: renders without --vault (the CLI treats --vault as optional)", () => {
    const detail = formatErrorDetail({
      code: "elicit_required",
      message: "human confirmation required",
      retryable: false,
      details: { args_hash: "abc123", tool: "write_note" },
    });
    expect(detail).toBe(
      "confirm with: obsidian-tc elicit --hash abc123 --tool write_note\n" +
        "(reads OBSIDIAN_TC_CONFIG if set; otherwise add --config <path> or a vault/config path " +
        "positional argument)\n" +
        "then retry the same call with elicit_token: <token>",
    );
  });

  it("hash only, no tool: a 'cannot render' explanation, never an unusable command", () => {
    // --tool is a HARD requirement of `obsidian-tc elicit` (cli/args.ts throws a CliError without
    // it) — a rendered command missing it would paste, then fail with a confusing usage error.
    const detail = formatErrorDetail({
      code: "elicit_required",
      message: "human confirmation required",
      retryable: false,
      details: { args_hash: "abc123" },
    });
    expect(detail).toBeDefined();
    expect(detail).not.toContain("obsidian-tc elicit --hash");
    expect(detail).toContain("cannot render a confirm command");
    expect(detail).toContain("--tool");
    expect(detail).toContain("abc123");
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

  describe("shell-quoting: tool/vault are not guaranteed shell-safe text", () => {
    it("a vault id containing a space is single-quoted, not interpolated bare", () => {
      const detail = formatErrorDetail({
        code: "elicit_required",
        message: "human confirmation required",
        retryable: false,
        details: { args_hash: "abc123", tool: "write_note", vault: "my vault" },
      });
      expect(detail).toContain("--vault 'my vault'");
    });

    it("a vault id containing $(...) is single-quoted (inert inside single quotes)", () => {
      const detail = formatErrorDetail({
        code: "elicit_required",
        message: "human confirmation required",
        retryable: false,
        details: { args_hash: "abc123", tool: "write_note", vault: "$(printf INJECTED)" },
      });
      expect(detail).toContain("--vault '$(printf INJECTED)'");
    });

    it("a vault id containing a single quote is closed/escaped/reopened", () => {
      const detail = formatErrorDetail({
        code: "elicit_required",
        message: "human confirmation required",
        retryable: false,
        details: { args_hash: "abc123", tool: "write_note", vault: "o'brien's vault" },
      });
      expect(detail).toContain(`--vault 'o'\\''brien'\\''s vault'`);
    });

    it("a plain slug-shaped vault id is rendered bare (no unnecessary quoting)", () => {
      const detail = formatErrorDetail({
        code: "elicit_required",
        message: "human confirmation required",
        retryable: false,
        details: { args_hash: "abc123", tool: "write_note", vault: "v1" },
      });
      expect(detail).toContain("--vault v1");
      expect(detail).not.toContain("'v1'");
    });
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

describe("hitl.ts: proposed can never override the trusted fields (fix round 2)", () => {
  it("a proposed object carrying tool/vault/args_hash does not win", () => {
    const db = freshDb();
    const ctx: CallerContext = {
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v1",
      db,
    };
    try {
      requireConfirmation(ctx, "write_note", { path: "a.md" }, true, {
        tool: "spoofed_tool",
        vault: "spoofed_vault",
        args_hash: "spoofed_hash",
      });
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof ObsidianTcError)) throw e;
      expect(e.details?.tool).toBe("write_note");
      expect(e.details?.vault).toBe("v1");
      expect(e.details?.args_hash).not.toBe("spoofed_hash");
    }
  });
});

/** A conditional-HITL tool — calls `requireConfirmation` from inside the handler (hitl.ts's own
 *  throw site), rather than `destructive: true` (dispatch.ts's SEPARATE `elicit_required` throw —
 *  see `destructiveTool` below and error-rendering.ts's comment on why both now render fully). */
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

/** An always-gated tool — `destructive: true` arms dispatch's OWN `elicit_required` throw
 *  (registry/dispatch.ts, `needsHitl`), the class the issue was filed about (11+ real sites). */
function destructiveTool(name: string): ToolDefinition {
  return {
    name,
    description: "test-only destructive tool",
    inputSchema: z.object({}),
    requiredScopes: [],
    destructive: true,
    handler: () => ({ done: true }),
  } as unknown as ToolDefinition;
}

function textOf(res: unknown): string {
  return (res as { content: [{ text: string }] }).content[0].text;
}

function structuredOf(res: unknown): Record<string, unknown> {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

describe("errorToResult (mcp/server.ts): both throw sites render a complete CLI line", () => {
  async function boot(tool: ToolDefinition) {
    const db = freshDb();
    const registry = new ToolRegistry();
    registry.register(tool);
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
    return { client, server };
  }

  it("hitl.ts's conditional throw: text carries hash/tool/vault; structuredContent unchanged", async () => {
    const { client, server } = await boot(conditionalTool("conditional_write"));
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
      expect(text).toContain("Error [elicit_required]: human confirmation required");
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

  it("dispatch.ts's destructive throw: text ALSO carries hash/tool/vault (fix round 2)", async () => {
    const { client, server } = await boot(destructiveTool("purge"));
    try {
      const res = await client.callTool({ name: "purge", arguments: {} });
      expect(res.isError).toBe(true);
      const structured = structuredOf(res);
      expect(structured.code).toBe("elicit_required");
      const argsHash = (structured.details as { args_hash?: string } | undefined)?.args_hash;
      expect(typeof argsHash).toBe("string");
      expect((structured.details as { tool?: string }).tool).toBe("purge");
      expect((structured.details as { vault?: string }).vault).toBe("v1");

      const text = textOf(res);
      expect(text).toContain(`--hash ${argsHash}`);
      expect(text).toContain("--tool purge");
      expect(text).toContain("--vault v1");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("paste-ability: the rendered line survives a REAL shell and mints a real plan", () => {
  /** Real POSIX shell tokenization of a rendered command line — proves paste-ability the way a
   *  hand-rolled parser cannot: `set --` performs the exact word-splitting/quote-removal a user's
   *  shell does when the line is pasted in, and the `for`/`printf` loop reads the resulting
   *  positional params back out NUL-delimited (a shell argument cannot itself contain a NUL, so
   *  it can never be mistaken for the separator). If our quoting under-escapes anything, this is
   *  what would show it — an argv that doesn't match what was rendered, or a shell that errors. */
  function shellSplit(argsPortion: string): string[] {
    const script = `set -- ${argsPortion}\nfor a; do printf '%s\\0' "$a"; done`;
    const out = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    return out.length === 0 ? [] : out.slice(0, -1).split("\0");
  }

  const CONFIRM_PREFIX = "confirm with: obsidian-tc ";

  /** Extract the "confirm with:" line from rendered text, real-shell-split its argv (everything
   *  after the fixed `obsidian-tc` program name), and parse it with the REAL CLI parser. */
  function paste(text: string): CliCommand {
    const line = text.split("\n").find((l) => l.startsWith(CONFIRM_PREFIX));
    if (!line) throw new Error(`no "confirm with:" line in:\n${text}`);
    const argv = shellSplit(line.slice(CONFIRM_PREFIX.length));
    return parseCliArgs(argv);
  }

  function cfgFor(vaultId: string): Pick<ServerConfig, "vaults" | "elicitTtlSeconds"> {
    return ServerConfigSchema.parse({ vaults: [{ id: vaultId, path: "/vault" }] });
  }

  function assertMintable(cmd: CliCommand, toolName: string, vaultId: string) {
    expect(cmd.kind).toBe("elicit-mint");
    if (cmd.kind !== "elicit-mint") throw new Error("unreachable");
    expect(cmd.tool).toBe(toolName);
    expect(cmd.vault).toBe(vaultId);
    expect(typeof cmd.hash).toBe("string");
    // The point of this test: run the SAME real parser output through the real mint planner and
    // prove it actually plans a token — not just that parseCliArgs accepted the shape.
    const plan = planElicitMint(cfgFor(vaultId), cmd);
    expect(plan.toolName).toBe(toolName);
    expect(plan.vaultId).toBe(vaultId);
    expect(plan.argsHash).toBe(cmd.hash);
  }

  it("hitl.ts's conditional throw site (a plain vault id)", () => {
    const db = freshDb();
    const ctx: CallerContext = {
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v1",
      db,
    };
    try {
      requireConfirmation(ctx, "write_note", { path: "a.md" }, true);
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof ObsidianTcError)) throw e;
      const text = formatErrorDetail(e.toJSON());
      if (!text) throw new Error("expected rendered text");
      assertMintable(paste(text), "write_note", "v1");
    }
  });

  it("dispatch.ts's always-gated throw site (a plain vault id)", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    reg.register(destructiveTool("purge"));
    const result = await reg.dispatch("purge", {}, {
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v1",
      db,
    } as CallerContext);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected elicit_required");
    const text = formatErrorDetail(result.error);
    if (!text) throw new Error("expected rendered text");
    assertMintable(paste(text), "purge", "v1");
  });

  // Codex cross-vendor review, item A: a vault id with a space, and one with a `$(...)`
  // substring — proving neither can alter the parsed command or run as a real shell expansion.
  for (const vaultId of ["vault with spaces", "$(printf INJECTED)", "o'brien's vault"]) {
    it(`survives a shell-unsafe vault id: ${JSON.stringify(vaultId)}`, () => {
      const db = freshDb();
      const ctx: CallerContext = {
        caller: "t",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId,
        db,
      };
      try {
        requireConfirmation(ctx, "write_note", { path: "a.md" }, true);
        throw new Error("should have thrown");
      } catch (e) {
        if (!(e instanceof ObsidianTcError)) throw e;
        const text = formatErrorDetail(e.toJSON());
        if (!text) throw new Error("expected rendered text");
        // The real assertion: the vault id survives shell round-tripping BYTE FOR BYTE. If
        // quoting under-escaped this value, the shell would either split it into extra
        // arguments, run `$(...)` as a real substitution, or error outright — any of which
        // would make this not equal the original string.
        assertMintable(paste(text), "write_note", vaultId);
      }
    });
  }
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
