import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import type { Database } from "../src/db/types";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

function freshDb(): Database {
  const db = openMemoryDb();
  db.exec(schemaSql);
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
