// THE-634: `notifications/advisory` — the proactive-advisory push channel, served in front of the
// SDK handler for the same reason `notifications/tasks` (mcp/tasks.ts) is: the SDK's own
// `subscriptions/listen` SubscriptionFilter/ServerEvent union is a closed four-key set, so neither
// an advisory opt-in nor an advisory event is expressible through it.
//
// What matters most, mirroring notifications-tasks.test.ts's own framing: OWNERSHIP ON EVERY FRAME
// (a push channel is the easiest place to leak isolation, because the push side is what nobody
// re-checks) and the MODERN-ERA-ONLY ceiling this ticket's brief calls out explicitly — a legacy
// (2025-11-25) session must receive no delivery attempt and no error, not silently break.
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import {
  ADVISORY_SUBSCRIPTION_KEY,
  createAdvisoryBus,
  subscribesToAdvisories,
} from "../src/mcp/advisories";
import { ToolRegistry } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";
import { type HttpHandle, startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";

describe("subscribesToAdvisories", () => {
  it("true only when the exact key is true; anything else is not an opt-in", () => {
    expect(
      subscribesToAdvisories({ params: { notifications: { [ADVISORY_SUBSCRIPTION_KEY]: true } } }),
    ).toBe(true);
    expect(
      subscribesToAdvisories({ params: { notifications: { [ADVISORY_SUBSCRIPTION_KEY]: false } } }),
    ).toBe(false);
    expect(subscribesToAdvisories({ params: { notifications: {} } })).toBe(false);
    expect(subscribesToAdvisories({ params: {} })).toBe(false);
    expect(subscribesToAdvisories(null)).toBe(false);
    expect(subscribesToAdvisories(undefined)).toBe(false);
  });
});

describe("createAdvisoryBus", () => {
  it("publishing with no listener is a no-op, not a throw — the common case (legacy/disconnected sessions)", () => {
    const bus = createAdvisoryBus();
    expect(() =>
      bus.publish({ vaultId: "v1", caller: "a", sessionId: "s1", advisories: [] }),
    ).not.toThrow();
  });

  it("delivers to a listener and stops after unsubscribe", () => {
    const bus = createAdvisoryBus();
    const seen: unknown[] = [];
    const unsubscribe = bus.onAdvisory((e) => seen.push(e));
    bus.publish({ vaultId: "v1", caller: "a", sessionId: "s1", advisories: [] });
    expect(seen).toHaveLength(1);
    unsubscribe();
    bus.publish({ vaultId: "v1", caller: "a", sessionId: "s1", advisories: [] });
    expect(seen).toHaveLength(1);
  });

  it("one listener's throw does not break delivery to another", () => {
    const bus = createAdvisoryBus();
    const seen: unknown[] = [];
    bus.onAdvisory(() => {
      throw new Error("boom");
    });
    bus.onAdvisory((e) => seen.push(e));
    expect(() =>
      bus.publish({ vaultId: "v1", caller: "a", sessionId: "s1", advisories: [] }),
    ).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

async function boot(): Promise<{ handle: HttpHandle; bus: ReturnType<typeof createAdvisoryBus> }> {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry();
  registry.register(
    createHealthTool({
      version: "0.0.0-test",
      vaults: ["v1"],
      startedAt: Date.now(),
      nativeLoaded: false,
      vecEnabled: false,
    }),
  );
  const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
  }).auth;
  const bus = createAdvisoryBus();
  const handle = await startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
    advisoryBus: bus,
  });
  return { handle, bus };
}

async function tokenFor(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub, scopes: ["*"], aud: "http://test", iat: now, exp: now + 600 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

/** Open an advisory subscription (modern era, unless overridden), run `act` once the ack lands,
 *  collect frames until the deadline. Mirrors notifications-tasks.test.ts's `collect` exactly. */
async function collect(
  port: number,
  jwt: string,
  act: () => void,
  opts: { protocolVersion?: string; deadlineMs?: number } = {},
): Promise<Array<Record<string, any>>> {
  const protocolVersion = opts.protocolVersion ?? MODERN;
  const deadlineMs = opts.deadlineMs ?? 3000;
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    signal: ac.signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": protocolVersion,
      "mcp-method": "subscriptions/listen",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "subscriptions/listen",
      params: {
        notifications: { [ADVISORY_SUBSCRIPTION_KEY]: true },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
          "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const frames: Array<Record<string, any>> = [];
  const reader = res.body?.getReader();
  if (!reader) return frames;
  const dec = new TextDecoder();
  let fired = false;
  const stop = setTimeout(() => ac.abort(), deadlineMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split("\n")) {
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
      }
      if (!fired) {
        fired = true;
        act();
      }
    }
  } catch {
    /* aborted at the deadline, which is the normal exit for an SSE stream */
  }
  clearTimeout(stop);
  return frames;
}

describe("notifications/advisory (THE-634)", () => {
  it("acknowledges the subscription and delivers an event published for the SAME (vault, caller)", async () => {
    const { handle, bus } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const frames = await collect(handle.port, jwt, () => {
        bus.publish({
          vaultId: "v1",
          caller: "agent-1",
          sessionId: "s1",
          advisories: [
            {
              chunkId: "hit",
              goalId: "g1",
              goalText: "goal",
              score: 0.9,
              candidateKind: "note_changed",
            },
          ],
        });
      });
      const ack = frames.find((f) => f.method === "notifications/subscriptions/acknowledged");
      expect(ack?.params?.notifications?.[ADVISORY_SUBSCRIPTION_KEY]).toBe(true);
      const push = frames.find((f) => f.method === "notifications/advisory");
      expect(push).toBeDefined();
      expect(push?.params?.sessionId).toBe("s1");
      expect(push?.params?.advisories).toEqual([
        {
          chunkId: "hit",
          goalId: "g1",
          goalText: "goal",
          score: 0.9,
          candidateKind: "note_changed",
        },
      ]);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("NEVER pushes another caller's advisory", async () => {
    const { handle, bus } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const frames = await collect(handle.port, jwt, () => {
        bus.publish({ vaultId: "v1", caller: "agent-2", sessionId: "theirs", advisories: [] });
      });
      expect(frames.some((f) => f.method === "notifications/advisory")).toBe(false);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("THE-634 acceptance #5: a legacy-era (2025-11-25) session gets no delivery attempt and no error", async () => {
    // The documented ceiling: `subscriptions/listen` (and therefore this extension) does not exist
    // in the legacy era at all. A legacy request naming the SAME subscription key must fall through
    // to the SDK's ordinary legacy handling — no advisory frame, and critically no error either.
    const { handle } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
          "mcp-protocol-version": LEGACY,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "subscriptions/listen",
          params: { notifications: { [ADVISORY_SUBSCRIPTION_KEY]: true } },
        }),
      });
      // Whatever the legacy-era SDK path does with an unrecognized 2026-only method, it must not be
      // our advisory stream (no text/event-stream body naming it) and must not be an unhandled crash.
      expect(res.status).toBeLessThan(500);
      const text = await res.text();
      expect(text).not.toContain("notifications/advisory");
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("no bus wired (flag off): the subscription falls through to the SDK, never our stream", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const registry = new ToolRegistry();
    registry.register(
      createHealthTool({
        version: "0.0.0-test",
        vaults: ["v1"],
        startedAt: Date.now(),
        nativeLoaded: false,
        vecEnabled: false,
      }),
    );
    const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
    }).auth;
    const handle = await startHttp({
      name: "obsidian-tc",
      version: "0.0.0-test",
      registry,
      auth,
      db,
      vaultId: "v1",
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
      host: "127.0.0.1",
      port: 0,
      // no advisoryBus — the off-by-default state.
    });
    const jwt = await tokenFor("agent-1");
    try {
      const frames = await collect(handle.port, jwt, () => {
        /* nothing to publish — there is no bus */
      });
      const ack = frames.find((f) => f.method === "notifications/subscriptions/acknowledged");
      // The SDK's own listen handler still acks (per subscriptions-listen.test.ts), but with an
      // EMPTY filter for a key it does not recognise — never our ADVISORY_SUBSCRIPTION_KEY as true.
      expect(ack?.params?.notifications?.[ADVISORY_SUBSCRIPTION_KEY]).not.toBe(true);
    } finally {
      await handle.close();
    }
  }, 30_000);
});
