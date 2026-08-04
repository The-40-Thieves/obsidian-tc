// THE-727, behavioral half. `operation-policy.test.ts` proves the resolver; this proves
// `runDispatch` actually AUTHORIZES against it. A declaration nothing enforces is a comment — the
// same reasoning that made THE-513's vault-arg gate need a dispatch-level counterpart.
//
// The load-bearing assertion is the ORDERING one at the bottom. The pipeline parses before it
// authorizes, which was true by accident of history and is now a security dependency: move
// `parseInput` back above `resolveOperationPolicy` and a consolidated tool authorizes against the
// wrong action's scopes, silently. Nothing but a test stops that edit.
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

function ctx(db: Database, scopes: string[]): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(scopes),
    vaultId: "a",
    db,
  };
}

/** One consolidated tool of the shape THE-727 exists to permit: a static declaration that is the
 *  UNION of what its actions need, narrowed per call. */
function registerNoteMutate(reg: ToolRegistry): void {
  reg.register({
    name: "note_mutate",
    description: "read or delete a note, by action",
    inputSchema: z.object({ action: z.enum(["read", "delete"]), path: z.string() }).strict(),
    requiredScopes: ["read:notes", "delete:notes"],
    destructive: true,
    resolvePolicy: (input: { action: "read" | "delete" }) =>
      input.action === "read"
        ? { requiredScopes: ["read:notes"], destructive: false }
        : { requiredScopes: ["delete:notes"], destructive: true },
    handler: (input: { action: string }) => ({ did: input.action }),
  } as never);
}

describe("THE-727: dispatch authorizes against the RESOLVED policy", () => {
  it("lets a read-only caller through the read action, which the static union would have refused", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    registerNoteMutate(reg);
    // This is the entire point. `requiredScopes` declares read+delete; a caller holding only
    // read:notes fails `grantsAll` against that union. Before THE-727 the only ways to ship this
    // tool were to demand delete for a read, or to drop delete from the declaration and
    // under-govern the destructive action.
    const res = await reg.dispatch(
      "note_mutate",
      { action: "read", path: "a.md" },
      ctx(db, ["read:notes"]),
    );
    // `if` rather than only `expect`: ToolResult is a discriminated union, so tsc needs the
    // narrowing that an assertion alone does not give it — vitest's esbuild accepted `.data`
    // unguarded and `bun run typecheck` did not.
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.data).toStrictEqual({ did: "read" });
    db.close?.();
  });

  it("still refuses the delete action to that same caller", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    registerNoteMutate(reg);
    // The other half. Narrowing must not become a way to reach the destructive action cheaply —
    // same tool, same caller, same session, different action, refused.
    const res = await reg.dispatch(
      "note_mutate",
      { action: "delete", path: "a.md" },
      ctx(db, ["read:notes"]),
    );
    if (res.ok) throw new Error("expected the delete action to be refused");
    expect(res.error.code).toBe("forbidden");
    db.close?.();
  });

  it("keeps the HITL floor on the destructive action while the read action skips it", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    registerNoteMutate(reg);
    // THE ASYMMETRY, and the gap this test caught in the first draft of the change. `hitlRequired`
    // read the STATIC `destructive`, so the read action of a consolidated read+delete tool demanded
    // a human confirmation — the union problem reappearing at the last gate that consumes it, and
    // the one most likely to pass review, because over-confirming looks conservative rather than
    // broken. It now takes the resolved policy.
    //
    // Delete: resolved destructive:true -> still gated, even holding the right scope.
    const del = await reg.dispatch(
      "note_mutate",
      { action: "delete", path: "a.md" },
      ctx(db, ["delete:notes"]),
    );
    if (del.ok) throw new Error("expected the destructive action to require HITL");
    expect(del.error.code).toBe("elicit_required");

    // Read: resolved destructive:false, no HITL-floored scope -> runs.
    const read = await reg.dispatch(
      "note_mutate",
      { action: "read", path: "a.md" },
      ctx(db, ["read:notes"]),
    );
    expect(read.ok).toBe(true);
    db.close?.();
  });

  it("refuses a tool whose resolver escalates beyond its declaration, as `internal`", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    reg.register({
      name: "sneaky",
      description: "declares read, resolves delete",
      inputSchema: z.object({}).strict(),
      requiredScopes: ["read:notes"],
      resolvePolicy: () => ({ requiredScopes: ["delete:notes"] }),
      handler: () => ({ ok: true }),
    } as never);
    // Even a caller holding EVERYTHING is refused: the defect is the definition, not the grant, so
    // it must not become reachable by handing someone more privilege.
    const res = await reg.dispatch("sneaky", {}, ctx(db, ["*", "delete:notes"]));
    if (res.ok) throw new Error("expected an escalating resolver to be refused");
    expect(res.error.code).toBe("internal");
    db.close?.();
  });
});

describe("THE-727: the parse-before-authorize ordering is now load-bearing", () => {
  it("resolves policy from VALIDATED input — an invalid action never reaches authorization", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    registerNoteMutate(reg);
    // A caller with no scopes at all sends a schema-invalid action. If authorization ran first this
    // would be `forbidden`; because the parse runs first it is a validation error. That ordering is
    // what guarantees the resolver only ever sees input the schema has already accepted — a
    // resolver switching on an unvalidated string would be branching on attacker-controlled data
    // before any gate has run.
    const res = await reg.dispatch(
      "note_mutate",
      { action: "obliterate", path: "a.md" },
      ctx(db, []),
    );
    if (res.ok) throw new Error("expected a schema-invalid action to be refused");
    expect(res.error.code).toBe("validation_error");
    db.close?.();
  });

  it("a tool with NO resolver is unchanged — the static declaration still governs", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    reg.register({
      name: "plain_write",
      description: "no resolvePolicy at all",
      inputSchema: z.object({}).strict(),
      requiredScopes: ["write:notes"],
      handler: () => ({ ok: true }),
    } as never);
    const denied = await reg.dispatch("plain_write", {}, ctx(db, ["read:notes"]));
    if (denied.ok) throw new Error("expected a scope-short caller to be refused");
    expect(denied.error.code).toBe("forbidden");
    const allowed = await reg.dispatch("plain_write", {}, ctx(db, ["write:notes"]));
    if (!allowed.ok) throw new Error(`expected ok, got ${allowed.error.code}`);
    expect(allowed.data).toStrictEqual({ ok: true });
    db.close?.();
  });
});
