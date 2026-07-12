import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runMigrations } from "../src/db/migrate";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
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

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    name: "vault_echo",
    description: "echoes the vault arg",
    inputSchema: z.object({ vault: z.string().optional() }),
    requiredScopes: [],
    handler: (i: { vault?: string }) => ({ vault: i.vault ?? null }),
  });
  return r;
}

function ctx(db: any, over: Partial<CallerContext> = {}): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "a",
    db,
    ...over,
  };
}

describe("THE-267 vault-binding guard", () => {
  it("rejects a bound caller naming a different vault", async () => {
    const res = await reg().dispatch(
      "vault_echo",
      { vault: "b" },
      ctx(freshDb(), { vaultBound: true }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("allows a bound caller naming its own vault", async () => {
    const res = await reg().dispatch(
      "vault_echo",
      { vault: "a" },
      ctx(freshDb(), { vaultBound: true }),
    );
    expect(res.ok).toBe(true);
  });

  it("allows a bound caller that omits the vault arg", async () => {
    const res = await reg().dispatch("vault_echo", {}, ctx(freshDb(), { vaultBound: true }));
    expect(res.ok).toBe(true);
  });

  it("allows an unbound (trusted stdio) caller to name any vault", async () => {
    const res = await reg().dispatch("vault_echo", { vault: "b" }, ctx(freshDb()));
    expect(res.ok).toBe(true);
  });
});
