import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runMigrations } from "../src/db/migrate";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";
import { openMemoryDb } from "./helpers";

function freshDb(): any {
  const d = openMemoryDb();
  runMigrations(d, [
    {
      version: "001",
      sql: "CREATE TABLE event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, vault_id TEXT, tool_name TEXT, caller TEXT, duration_ms INTEGER, result_size INTEGER, status TEXT NOT NULL, error_code TEXT, args_hash TEXT, event_type TEXT);",
    },
  ]);
  return d;
}

function ctx(db: any, over: Partial<CallerContext> = {}): CallerContext {
  return {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["read:notes"]),
    vaultId: "main",
    db,
    ...over,
  };
}

function reg() {
  const r = new ToolRegistry({
    maxResponseBytes: 256,
    verifyElicit: (token, hash) => token === `good:${hash}`,
  });
  r.register(
    createHealthTool({
      version: "0.0.0-test",
      vaults: ["main"],
      startedAt: Date.now(),
      nativeLoaded: false,
      vecEnabled: false,
    }),
  );
  r.register({
    name: "read_thing",
    description: "scoped read",
    inputSchema: z.object({ path: z.string() }),
    requiredScopes: ["read:notes"],
    handler: (i: { path: string }) => ({ path: i.path, ok: true }),
  });
  r.register({
    name: "danger",
    description: "destructive",
    inputSchema: z.object({}).strict(),
    requiredScopes: ["delete:notes"],
    destructive: true,
    handler: () => ({ deleted: true }),
  });
  r.register({
    name: "big",
    description: "overflows the governor",
    inputSchema: z.object({}).strict(),
    requiredScopes: [],
    handler: () => ({ blob: "x".repeat(500) }),
  });
  return r;
}

describe("dispatch pipeline", () => {
  let db: any;
  beforeEach(() => {
    db = freshDb();
  });

  it("runs a no-scope tool end to end and writes an audit row", async () => {
    const res = await reg().dispatch("server_health", {}, ctx(db, { grantedScopes: new Set() }));
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as any).status).toBe("ok");
    const row = db
      .prepare("SELECT status, tool_name FROM event_log ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toMatchObject({ status: "ok", tool_name: "server_health" });
  });

  it("rejects unknown tools", async () => {
    const res = await reg().dispatch("nope", {}, ctx(db));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("returns validation_error on bad input", async () => {
    const res = await reg().dispatch("read_thing", { path: 123 }, ctx(db));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation_error");
  });

  it("returns unauthorized when a scoped tool is called unauthenticated", async () => {
    const res = await reg().dispatch(
      "read_thing",
      { path: "a.md" },
      ctx(db, { authenticated: false, grantedScopes: new Set() }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unauthorized");
  });

  it("returns forbidden when scope is missing", async () => {
    const res = await reg().dispatch(
      "danger",
      {},
      ctx(db, { grantedScopes: new Set(["read:notes"]) }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("requires elicit on a destructive tool, then succeeds with a valid token", async () => {
    const scopes = new Set(["delete:notes"]);
    const first = await reg().dispatch("danger", {}, ctx(db, { grantedScopes: scopes }));
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("elicit_required");

    const hash = argsHash("danger", {});
    const second = await reg().dispatch(
      "danger",
      {},
      ctx(db, { grantedScopes: scopes, elicitToken: `good:${hash}` }),
    );
    expect(second.ok).toBe(true);
  });

  it("enforces the response-byte governor", async () => {
    const res = await reg().dispatch("big", {}, ctx(db, { grantedScopes: new Set() }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("overflow");
      expect(res.meta.overflow_bytes).toBeGreaterThan(0);
    }
  });
});
