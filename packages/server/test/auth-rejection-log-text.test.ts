// The "token has NOT expired; it exceeded auth.tokenTtlSeconds" hint is true of exactly one reason,
// `token_max_age`. It used to be attached to ANY rejection of a token whose `exp` was still in the
// future, which sent operators hunting for a ttl misconfiguration behind an audience, issuer or
// signature failure.
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const SECRET = "z".repeat(32);
const HINT = "token has NOT expired";

function authOf(input: unknown): ServerConfig["auth"] {
  return ServerConfigSchema.parse({ vaults: [{ id: "v1", path: "/tmp/v1" }], auth: input }).auth;
}

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    lines.push(String(c));
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const now = () => Math.floor(Date.now() / 1000);
const mint = (claims: Record<string, unknown>, secret = SECRET, iat = now()) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(iat)
    .setExpirationTime(now() + 86_400)
    .sign(new TextEncoder().encode(secret));

/** Boot an edge, POST one token, return the `auth: rejected` line it logged. */
async function rejectionLine(auth: unknown, token: string): Promise<string> {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const handle = await startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry: new ToolRegistry(),
    auth: authOf(auth),
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
  } as Parameters<typeof startHttp>[0]);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  } finally {
    await handle.close();
  }
  const line = lines.find((l) => l.startsWith("auth: rejected"));
  expect(line, `no rejection line in ${JSON.stringify(lines)}`).toBeDefined();
  return line as string;
}

describe("reportAuthRejection hint text, per reason", () => {
  it("token_max_age: names the ttl misconfiguration", async () => {
    const line = await rejectionLine(
      { mode: "jwt", jwtSecret: SECRET, tokenTtlSeconds: 60 },
      await mint({ sub: "svc" }, SECRET, now() - 3600),
    );
    expect(line).toContain("reason=token_max_age");
    expect(line).toContain(HINT);
    expect(line).toContain("auth.tokenTtlSeconds");
  });

  it.each([
    [
      "audience_mismatch",
      { mode: "jwt", jwtSecret: SECRET, audience: "https://mine.example" },
      () => mint({ sub: "svc", aud: "https://other.example" }),
    ],
    [
      "issuer_mismatch",
      {
        mode: "jwt",
        jwtSecret: SECRET,
        issuer: "https://mine.example",
        audience: "https://mine.example",
      },
      () => mint({ sub: "svc", iss: "https://other.example", aud: "https://mine.example" }),
    ],
    [
      "bad_signature",
      { mode: "jwt", jwtSecret: SECRET },
      () => mint({ sub: "svc" }, "q".repeat(32)),
    ],
  ] as const)(
    "%s on an unexpired token: does not claim a ttl problem",
    async (reason, auth, token) => {
      const line = await rejectionLine(auth, await token());
      expect(line).toContain(`reason=${reason}`);
      expect(line).not.toContain(HINT);
      expect(line).not.toContain("tokenTtlSeconds");
    },
  );

  it("token_expired: no ttl hint either", async () => {
    const expired = await new SignJWT({ sub: "svc" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("-1s")
      .sign(new TextEncoder().encode(SECRET));
    const line = await rejectionLine({ mode: "jwt", jwtSecret: SECRET }, expired);
    expect(line).toContain("reason=token_expired");
    expect(line).not.toContain(HINT);
  });
});
