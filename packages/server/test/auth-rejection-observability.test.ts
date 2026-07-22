// THE-520 (edge half): a rejection must be diagnosable by the OPERATOR without becoming an oracle
// for the caller. The server logs the specific reason and counts it; the HTTP response stays a
// generic 401 with no hint about which check failed.
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const SECRET = "z".repeat(32);

function authOf(input: unknown): ServerConfig["auth"] {
  return ServerConfigSchema.parse({ vaults: [{ id: "v1", path: "/tmp/v1" }], auth: input }).auth;
}

async function boot(auth: ServerConfig["auth"], onAuthRejected?: unknown) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const handle = await startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry: new ToolRegistry(),
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
    ...(onAuthRejected ? { onAuthRejected } : {}),
  } as Parameters<typeof startHttp>[0]);
  return { handle, url: `http://127.0.0.1:${handle.port}/mcp` };
}

function mint(claims: Record<string, unknown>, set: (s: SignJWT) => SignJWT): Promise<string> {
  return set(new SignJWT(claims).setProtectedHeader({ alg: "HS256" })).sign(
    new TextEncoder().encode(SECRET),
  );
}

async function post(url: string, token: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

describe("THE-520 auth rejection observability", () => {
  it("reports the max-age reason to the operator sink, with the exp-still-future signal", async () => {
    const seen: { reason: string; expStillFuture: boolean; caller: string | null }[] = [];
    const { handle, url } = await boot(
      authOf({ mode: "jwt", jwtSecret: SECRET, tokenTtlSeconds: 60 }),
      (r: { reason: string; expStillFuture: boolean; caller: string | null }) => seen.push(r),
    );
    try {
      const aged = await mint({ sub: "cave-agents" }, (s) =>
        s.setIssuedAt(Math.floor(Date.now() / 1000) - 3600).setExpirationTime("365d"),
      );

      const res = await post(url, aged);

      expect(res.status).toBe(401);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.reason).toBe("token_max_age");
      expect(seen[0]?.expStillFuture).toBe(true);
      expect(seen[0]?.caller).toBe("cave-agents");
    } finally {
      await handle.close();
    }
  });

  it("does NOT leak the reason to the client — the 401 body stays undifferentiated", async () => {
    const { handle, url } = await boot(
      authOf({ mode: "jwt", jwtSecret: SECRET, tokenTtlSeconds: 60 }),
    );
    try {
      const aged = await mint({ sub: "svc" }, (s) =>
        s.setIssuedAt(Math.floor(Date.now() / 1000) - 3600).setExpirationTime("365d"),
      );
      const expired = await mint({ sub: "svc" }, (s) => s.setExpirationTime("-1s"));

      const agedBody = await (await post(url, aged)).text();
      const expiredBody = await (await post(url, expired)).text();

      // Two different internal reasons must be indistinguishable from outside.
      expect(agedBody).toBe(expiredBody);
      for (const leak of ["max_age", "maximum age", "expStillFuture", "signature"]) {
        expect(agedBody).not.toContain(leak);
      }
    } finally {
      await handle.close();
    }
  });

  it("writes one stderr line naming the reason", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { handle, url } = await boot(
      authOf({ mode: "jwt", jwtSecret: SECRET, tokenTtlSeconds: 60 }),
    );
    try {
      const aged = await mint({ sub: "svc" }, (s) =>
        s.setIssuedAt(Math.floor(Date.now() / 1000) - 3600).setExpirationTime("365d"),
      );

      await post(url, aged);

      const lines = write.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("token_max_age"))).toBe(true);
    } finally {
      write.mockRestore();
      await handle.close();
    }
  });

  it("classifies a bad signature separately from an aged token", async () => {
    const seen: { reason: string }[] = [];
    const { handle, url } = await boot(
      authOf({ mode: "jwt", jwtSecret: SECRET, tokenTtlSeconds: 60 }),
      (r: { reason: string }) => seen.push(r),
    );
    try {
      const forged = await new SignJWT({ sub: "mallory" })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode("q".repeat(32)));

      await post(url, forged);

      expect(seen[0]?.reason).toBe("bad_signature");
    } finally {
      await handle.close();
    }
  });
});
