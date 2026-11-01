// GH #1457: the runtime's own shutdown closes the stdio session that `sessions.autoOpen` opened.
// The real buildServerRuntime runs its stdio transport over in-memory streams (connectStdio is
// swapped for one wired to them), so one tools/call opens the implicit row through the production
// composition, and close() must end it rather than leave it to the window sweep.
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { openDatabase } from "../src/db/open";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { waitFor } from "./git-sync-test-helpers";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const io = vi.hoisted(() => ({
  stdin: undefined as PassThrough | undefined,
  stdout: undefined as PassThrough | undefined,
}));

vi.mock("../src/transports/stdio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/transports/stdio")>();
  return {
    ...actual,
    connectStdio: (server: Parameters<typeof actual.connectStdio>[0]) => {
      if (!io.stdin || !io.stdout) throw new Error("test stdio streams are not set");
      return actual.connectStdio(server, { stdin: io.stdin, stdout: io.stdout });
    },
  };
});

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmTemp(d);
});

describe("ServerRuntime.close() ends the stdio session sessions.autoOpen opened", () => {
  it(
    "closes the implicit row the first tools/call opened, instead of leaving it to the sweep",
    async () => {
      const vaultDir = makeTempDir("obtc-runtime-close-vault-");
      const cacheDir = makeTempDir("obtc-runtime-close-cache-");
      tmpRoots.push(vaultDir, cacheDir);
      const config = configFromVaultPath(vaultDir);
      config.cacheDir = cacheDir;
      config.sessions = { ...config.sessions, autoOpen: true, windowSeconds: 1800 };

      io.stdin = new PassThrough();
      io.stdout = new PassThrough();
      const replies = new Map<number, Record<string, any>>();
      let pending = "";
      io.stdout.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
          const msg = JSON.parse(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          if (typeof msg.id === "number") replies.set(msg.id, msg);
        }
      });
      const send = (msg: object) => io.stdin?.write(`${JSON.stringify(msg)}\n`);
      const request = async (id: number, method: string, params: object) => {
        send({ jsonrpc: "2.0", id, method, params });
        await waitFor(() => replies.has(id), 4_000).catch(() => {
          throw new Error(`no stdio reply for ${method}`);
        });
        return replies.get(id) as Record<string, any>;
      };

      const runtime = await buildServerRuntime(config, undefined);
      await runtime.start();
      await request(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "runtime-close-test", version: "1" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const called = await request(2, "tools/call", { name: "server_health", arguments: {} });
      expect(called.error).toBeUndefined();

      await runtime.close("test");

      const db = await openDatabase(join(cacheDir, "cache.db"));
      try {
        const all = db
          .prepare("SELECT caller, principal, ended_at FROM workspace_sessions")
          .all() as { caller: string | null; principal: string | null; ended_at: number | null }[];
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ caller: null, principal: "stdio" });
        expect(all[0]?.ended_at).not.toBeNull();
      } finally {
        db.close?.();
      }
    },
    stallTimeout(60_000),
  );
});
