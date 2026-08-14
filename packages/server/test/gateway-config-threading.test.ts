// THE-832: `gateway.baseUrl` / `gateway.token` in obsidian-tc.config.json, threaded through
// wireGatewaySeams' createGatewayClient call. Motivation (GitHub #787): a host app that rewrites
// its own MCP config on restart drops env keys it did not author, silently reverting
// OBSIDIAN_TC_GATEWAY_URL and leaving every generative seam unavailable with no error. Config is
// a channel that rewrite does not touch, so an explicit config value must win over the env var.
//
// Exercises wireGatewaySeams' `gateway` return directly via ping() against a stubbed global
// fetch — proving the CLIENT actually targets the config URL/token, not just that it resolves
// non-null (resolveGatewayUrl's own precedence is unit-tested in gateway/client, but nothing
// previously proved the config value reaches that call at the tool-wiring layer).
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolRegistry } from "../src/mcp/registry";
import { wireGatewaySeams } from "../src/runtime/tool-wiring";
import { buildAdminTools } from "../src/tools/m6/admin-tools";
import type { M6Deps } from "../src/tools/m6/shared";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

function embeddingsOnly() {
  return ServerConfigSchema.parse({
    vaults: [{ id: "main", path: "/v" }],
    embeddings: { provider: "ollama" },
  }).embeddings;
}

describe("wireGatewaySeams — gateway config threading (THE-832)", () => {
  const prevUrl = process.env.OBSIDIAN_TC_GATEWAY_URL;
  const prevToken = process.env.OBSIDIAN_TC_GATEWAY_TOKEN;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevUrl === undefined) delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    else process.env.OBSIDIAN_TC_GATEWAY_URL = prevUrl;
    if (prevToken === undefined) delete process.env.OBSIDIAN_TC_GATEWAY_TOKEN;
    else process.env.OBSIDIAN_TC_GATEWAY_TOKEN = prevToken;
  });

  it("config.gateway.baseUrl set, env UNSET -> the client resolves to the config URL", async () => {
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response(null, { status: 200 });
      }),
    );
    const { gateway } = await wireGatewaySeams(embeddingsOnly(), undefined, undefined, undefined, {
      baseUrl: "http://from-config:4001",
    });
    expect(gateway).not.toBeNull();
    await gateway?.ping();
    expect(urls).toEqual(["http://from-config:4001/health"]);
  });

  it("config.gateway.baseUrl set AND env set to something different -> config wins", async () => {
    process.env.OBSIDIAN_TC_GATEWAY_URL = "http://from-env:9999";
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response(null, { status: 200 });
      }),
    );
    const { gateway } = await wireGatewaySeams(embeddingsOnly(), undefined, undefined, undefined, {
      baseUrl: "http://from-config:4001",
    });
    await gateway?.ping();
    // If precedence flipped, this would hit http://from-env:9999/health instead.
    expect(urls).toEqual(["http://from-config:4001/health"]);
  });

  it("config.gateway.token set -> forwarded as the bearer, config wins over the env token too", async () => {
    process.env.OBSIDIAN_TC_GATEWAY_URL = "http://from-config:4001";
    process.env.OBSIDIAN_TC_GATEWAY_TOKEN = "env-token";
    const authHeaders: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        authHeaders.push(
          (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
        );
        return new Response(null, { status: 200 });
      }),
    );
    const { gateway } = await wireGatewaySeams(embeddingsOnly(), undefined, undefined, undefined, {
      token: "config-token",
    });
    await gateway?.ping();
    expect(authHeaders).toEqual(["Bearer config-token"]);
  });

  it("neither config nor env set -> gateway unconfigured, seams degrade, boot does not fail", async () => {
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    const { gateway, roles } = await wireGatewaySeams(embeddingsOnly());
    expect(gateway).toBeNull();
    expect(roles).toBeNull();
  });
});

describe("get_server_config — gateway.token never leaks (THE-832)", () => {
  let v: M6Vault | undefined;
  afterEach(() => v?.cleanup());

  const register = (r: ToolRegistry, d: M6Deps) => {
    for (const t of buildAdminTools(d)) r.register(t);
  };

  it("a configured gateway.token is absent from the actual returned object", async () => {
    const secret = "super-secret-litellm-key";
    // gateway.token is deliberately NOT threaded into M6Deps (admin-tools.ts's module comment:
    // "never the JWT secret, REST API keys, or embedding API keys — those are not even in
    // M6Deps"); this proves that holds for the new key too, on the real dispatch path rather
    // than by inspecting source.
    ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/v" }],
      embeddings: { provider: "ollama" },
      gateway: { baseUrl: "http://gw:4001", token: secret },
    });
    v = makeM6Vault({ authMode: "jwt", register });
    const result = await v.call("get_server_config", {});
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain(secret);
    expect(serialized.toLowerCase()).not.toContain("gateway");
  });
});
