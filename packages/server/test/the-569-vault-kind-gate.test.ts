// THE-569: reverse vault-kind gate. P1.5 closed the read direction (read:docs tools refuse a
// non-docs vault); this closes the write/integrity direction — a mutating dispatch must refuse
// to touch a docs- or system-kind vault, so a "read-only docs corpus" is read-only by kind, not
// just by convention.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
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
    vaultId: "private-vault",
    db,
    ...over,
  };
}

const KIND_BY_VAULT: Record<string, "docs" | "system" | "private"> = {
  "docs-vault": "docs",
  "system-vault": "system",
  "private-vault": "private",
};

function registerTools(reg: ToolRegistry): void {
  reg.register({
    name: "write_note",
    description: "mutates",
    inputSchema: z.object({ vault: z.string().optional() }).strict(),
    requiredScopes: ["write:notes"],
    handler: () => ({ ok: true }),
  });
  reg.register({
    name: "read_note",
    description: "reads",
    inputSchema: z.object({ vault: z.string().optional() }).strict(),
    requiredScopes: ["read:notes"],
    handler: () => ({ ok: true }),
  });
}

describe("THE-569: reverse vault-kind gate", () => {
  it("forbids a write:notes dispatch against a docs-kind vault", async () => {
    const db = freshDb();
    const reg = new ToolRegistry({ vaultKindResolver: (id) => KIND_BY_VAULT[id] });
    registerTools(reg);
    const r = await reg.dispatch("write_note", { vault: "docs-vault" }, ctx(db));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
  });

  it("forbids a write:notes dispatch against a system-kind vault", async () => {
    const db = freshDb();
    const reg = new ToolRegistry({ vaultKindResolver: (id) => KIND_BY_VAULT[id] });
    registerTools(reg);
    const r = await reg.dispatch("write_note", { vault: "system-vault" }, ctx(db));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
  });

  it("allows a read:notes dispatch against a docs-kind vault", async () => {
    const db = freshDb();
    const reg = new ToolRegistry({ vaultKindResolver: (id) => KIND_BY_VAULT[id] });
    registerTools(reg);
    const r = await reg.dispatch("read_note", { vault: "docs-vault" }, ctx(db));
    expect(r.ok).toBe(true);
  });

  it("allows a write:notes dispatch against a private-kind vault (no regression)", async () => {
    const db = freshDb();
    const reg = new ToolRegistry({ vaultKindResolver: (id) => KIND_BY_VAULT[id] });
    registerTools(reg);
    const r = await reg.dispatch("write_note", { vault: "private-vault" }, ctx(db));
    expect(r.ok).toBe(true);
  });

  it("is a no-op when no vaultKindResolver is wired (all allowed)", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    registerTools(reg);
    const write = await reg.dispatch("write_note", { vault: "docs-vault" }, ctx(db));
    expect(write.ok).toBe(true);
    const read = await reg.dispatch("read_note", { vault: "docs-vault" }, ctx(db));
    expect(read.ok).toBe(true);
  });
});
