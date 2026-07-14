import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { openMemoryDb } from "./helpers";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function ctx(db: Database, over: Partial<CallerContext> = {}): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db,
    ...over,
  };
}

describe("dispatch guards", () => {
  it("denies a mutating tool when the ACL is read-only, allows it otherwise", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    reg.register({
      name: "write_note",
      description: "writes",
      inputSchema: z.object({ path: z.string() }),
      requiredScopes: ["write:note"],
      handler: () => ({ ok: true }),
    });

    const readOnly = new FolderAcl({ readOnly: true, defaultScopes: [], rules: [] });
    const denied = await reg.dispatch("write_note", { path: "a.md" }, ctx(db, { acl: readOnly }));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("forbidden");

    const writable = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
    const ok = await reg.dispatch("write_note", { path: "a.md" }, ctx(db, { acl: writable }));
    expect(ok.ok).toBe(true);
  });

  it("gates a destructive tool behind a single-use elicit token (HITL)", async () => {
    const db = freshDb();
    const reg = new ToolRegistry({ verifyElicit: elicitVerifier });
    reg.register({
      name: "purge",
      description: "destructive",
      inputSchema: z.object({}),
      requiredScopes: [],
      destructive: true,
      handler: () => ({ done: true }),
    });

    const need = await reg.dispatch("purge", {}, ctx(db));
    expect(need.ok).toBe(false);
    if (!need.ok) expect(need.error.code).toBe("elicit_required");

    const token = issueElicitToken(db, {
      vaultId: "v1",
      toolName: "purge",
      argsHash: argsHash("purge", {}),
      caller: "t",
    });
    const ok = await reg.dispatch("purge", {}, ctx(db, { elicitToken: token }));
    expect(ok.ok).toBe(true);

    const reused = await reg.dispatch("purge", {}, ctx(db, { elicitToken: token }));
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.error.code).toBe("elicit_required");
  });
});

describe("dispatch precheck (D5)", () => {
  it("runs after scope/ACL and before the HITL elicit consumption", async () => {
    const db = freshDb();
    const reg = new ToolRegistry({ verifyElicit: elicitVerifier });
    reg.register({
      name: "guarded",
      description: "destructive with a precheck that always rejects",
      inputSchema: z.object({}),
      requiredScopes: [],
      destructive: true,
      precheck: () => {
        throw new ObsidianTcError("forbidden", "blocked by precheck");
      },
      handler: () => ({ done: true }),
    });
    // A VALID elicit token is present, but precheck runs first and must reject
    // WITHOUT consuming the token.
    const token = issueElicitToken(db, {
      vaultId: "v1",
      toolName: "guarded",
      argsHash: argsHash("guarded", {}),
      caller: "t",
    });
    const r = await reg.dispatch("guarded", {}, ctx(db, { elicitToken: token }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
    const row = db.prepare("SELECT consumed_at FROM elicit_tokens WHERE token = ?").get(token) as
      | { consumed_at: number | null }
      | undefined;
    expect(row?.consumed_at).toBeNull();
  });

  it("is transparent when it resolves", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    let ran = false;
    reg.register({
      name: "ok_tool",
      description: "no-op precheck",
      inputSchema: z.object({}),
      requiredScopes: [],
      precheck: () => {
        /* allow */
      },
      handler: () => {
        ran = true;
        return { ok: true };
      },
    });
    const r = await reg.dispatch("ok_tool", {}, ctx(db));
    expect(r.ok).toBe(true);
    expect(ran).toBe(true);
  });

  it("runs after the scope gate (forbidden short-circuits before precheck)", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    let prechecked = false;
    reg.register({
      name: "scoped",
      description: "requires a scope the caller lacks",
      inputSchema: z.object({}),
      requiredScopes: ["write:note"],
      precheck: () => {
        prechecked = true;
      },
      handler: () => ({ ok: true }),
    });
    const r = await reg.dispatch("scoped", {}, ctx(db, { grantedScopes: new Set(["read:note"]) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
    expect(prechecked).toBe(false);
  });
});
