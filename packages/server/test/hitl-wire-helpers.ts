// Shared wire harness for the HITL round trip over a real `startHttp`, in any auth mode.
// hitl-multi-round-trip.test.ts owns the jwtSecret-mode matrix; this one exists so the same
// destructive-tool round trip can be driven under `oidc` and asymmetric-only `jwt` too.
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import type { TokenVerifier } from "../src/auth/verifier";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

export const MODERN = "2026-07-28";
export const HS_SECRET = "test-only-secret-not-a-real-credential-0123456789";
export const AUDIENCE = "http://test";
export const ARGS = { vault: "v1", path: "a.md" };

const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "hitl-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
};

const BASE = { vaults: [{ id: "v1", path: "/tmp/v1" }] };

export const hsConfig = (jwtSecret: string = HS_SECRET): ServerConfig["auth"] =>
  ServerConfigSchema.parse({
    ...BASE,
    auth: { mode: "jwt", jwtSecret, audience: AUDIENCE, tokenTtlSeconds: 3600 },
  }).auth;

export const oidcConfig = (): ServerConfig["auth"] =>
  ServerConfigSchema.parse({
    ...BASE,
    auth: {
      mode: "oidc",
      tokenTtlSeconds: 3600,
      oidc: { issuer: "https://idp.example.com", audience: AUDIENCE },
    },
  }).auth;

/** Asymmetric-only `jwt` mode: an inline JWKS and NO `jwtSecret`. */
export async function jwksFixture() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const pub = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const auth = ServerConfigSchema.parse({
    ...BASE,
    auth: { mode: "jwt", jwks: { keys: [pub] }, audience: AUDIENCE, tokenTtlSeconds: 3600 },
  }).auth;
  const sign = () => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: "agent-1", scopes: ["*"], aud: AUDIENCE, iat: now, exp: now + 600 })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "JWT" })
      .sign(privateKey);
  };
  return { auth, sign };
}

export function signHs(secret: string = HS_SECRET): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "agent-1", scopes: ["*"], aud: AUDIENCE, iat: now, exp: now + 600 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(secret));
}

/** A verifier standing in for the OIDC provider: every bearer is agent-1 with full scopes. */
export const stubVerifier: TokenVerifier = {
  verify: async () => ({ caller: "agent-1", scopes: new Set(["*"]) }),
};

export async function bootHitl(opts: {
  auth: ServerConfig["auth"];
  /** The server's cache directory. Absent: an embedder that supplies none. */
  cacheDir?: string;
  verifier?: TokenVerifier;
}) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const effect = { applied: 0 };
  const registry = new ToolRegistry();
  // `destructive: true` is what arms the dispatch HITL gate.
  registry.register({
    name: "danger_write",
    description: "test-only destructive tool",
    inputSchema: z.object({ vault: z.string(), path: z.string() }),
    requiredScopes: [],
    destructive: true,
    confirmationTargets: "none",
    handler: () => {
      effect.applied += 1;
      return { wrote: true };
    },
  } as never);
  const h = await startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth: opts.auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
    ...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
    ...(opts.verifier ? { verifier: opts.verifier } : {}),
  } as Parameters<typeof startHttp>[0]);
  return { ...h, effect };
}

/** One modern `tools/call`; with `requestState` it also sends the accepting confirm leg a real
 *  client sends after the human approves. */
export async function callDanger(
  port: number,
  jwt: string,
  requestState?: string,
  args: Record<string, unknown> = ARGS,
): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/call",
      "mcp-name": "danger_write",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "danger_write",
        arguments: args,
        _meta: META,
        ...(requestState
          ? {
              requestState,
              inputResponses: { confirm: { action: "accept", content: { approve: true } } },
            }
          : {}),
      },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text || "{}");
}

/** The first round: the offered `requestState`. Fails the test loudly when none is offered. */
export async function offer(port: number, jwt: string): Promise<string> {
  const first = await callDanger(port, jwt);
  const state = first.result?.requestState;
  if (typeof state !== "string")
    throw new Error(`no requestState offered: ${JSON.stringify(first).slice(0, 300)}`);
  return state;
}

export const completed = (r: any): boolean =>
  r.error === undefined &&
  r.result?.resultType !== "input_required" &&
  r.result?.isError !== true &&
  JSON.stringify(r.result).includes("wrote");
