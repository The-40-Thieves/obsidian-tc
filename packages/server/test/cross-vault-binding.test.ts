import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runMigrations } from "../src/db/migrate";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { buildUriTools } from "../src/tools/m6/uri-tools";
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

  // THE-589. The guard matches on the argument NAME, so any tool whose `vault` argument is not a
  // vault id collides with it. generate_uri's was an Obsidian DISPLAY NAME, and a bound caller
  // whose display name differed from its vault id got `forbidden` from a tool that requires no
  // scope, reads nothing, and only concatenates a string. Reproduced before the fix:
  //   {vault:"My Notes"} + bound vault "main" -> forbidden: vault is not the caller's bound vault
  //
  // Fixed by renaming the field to `vault_name` rather than exempting the tool — no bypass added
  // to a security-relevant check. Both halves are asserted here: the tool now works, AND the guard
  // still refuses a genuine cross-vault id. A fix that quietly widened the exemption would pass the
  // first assertion and fail the second.
  it("does not fire on generate_uri, whose vault_name is a display name (THE-589)", async () => {
    const r = new ToolRegistry();
    for (const t of buildUriTools()) r.register(t);
    const res = await r.dispatch(
      "generate_uri",
      { vault_name: "My Notes", action: "open", params: { file: "n.md" } },
      ctx(freshDb(), { vaultId: "main", vaultBound: true }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(JSON.stringify(res.data)).toContain("vault=My%20Notes");
  });

  it("still refuses a genuine cross-vault id on a vault-bound tool (THE-589 guard intact)", async () => {
    const res = await reg().dispatch(
      "vault_echo",
      { vault: "someone-elses-vault" },
      ctx(freshDb(), { vaultId: "main", vaultBound: true }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });
});
