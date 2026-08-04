// THE-726: `activeSessionFor` — the DURABLE resolution of a principal's open session, which is what
// lets the HTTP transport carry a session at all. Before this, `sessionId` and `activeSessions`
// appeared ZERO times in transports/http.ts, so `session_id` was NULL on 100% of live
// chunk_retrievals and agent_episodes rows regardless of what any client called.
//
// The load-bearing test here is the FIRST one. `workspace_sessions` carries two caller-shaped
// columns and they have different trust:
//
//     caller     = input.caller   DECLARED  — a required free-text field on start_session's input
//     principal  = ctx.caller     OBSERVED  — authenticated by the transport
//
// Resolving on the declared column would let any client holding `write:workspace` name another
// principal and inherit its session id — and a session id is the correlation key for that
// principal's retrieval history. That is a cross-principal read, not a cosmetic mix-up.

import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  activeSessionFor,
  endSession,
  genSessionId,
  insertSession,
} from "../src/workspace/sessions";
import { openMemoryDb } from "./helpers";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function open(
  db: Database,
  opts: { caller: string | null; principal?: string | null; vaultId?: string; startedAt?: number },
): string {
  const id = genSessionId();
  insertSession(db, {
    id,
    vaultId: opts.vaultId ?? "main",
    caller: opts.caller,
    startedAt: opts.startedAt ?? 1_000,
    tracePath: `traces/${id}.jsonl`,
    ...(opts.principal === undefined ? {} : { principal: opts.principal }),
  });
  return id;
}

describe("activeSessionFor — declaration must never resolve as observation", () => {
  it("does NOT resolve a session by its caller-SUPPLIED `caller`, only by the observed principal", () => {
    const db = freshDb();
    // alice opens a session. `caller` is whatever she declared; `principal` is what the transport
    // authenticated. Here they deliberately differ, which is the normal case on stdio (ctx.caller is
    // the transport name) and the attackable case on HTTP.
    const alice = open(db, { caller: "agent-alpha", principal: "alice" });

    // mallory declares alice's caller string. She may legitimately hold write:workspace — that scope
    // does not, and must not, imply the right to read alice's retrieval correlation.
    expect(activeSessionFor(db, "agent-alpha")).toBeUndefined();

    // Only the observed principal resolves it.
    expect(activeSessionFor(db, "alice")).toStrictEqual({ sessionId: alice, vaultId: "main" });
    db.close?.();
  });

  it("resolves nothing for a NULL principal, so a pre-migration row is unresolvable rather than resolvable-as-someone", () => {
    const db = freshDb();
    // Every row written before 20260804_001 has principal NULL. `WHERE principal = ?` is false on
    // both sides for NULL, and the supporting index excludes NULLs — so this is safe by
    // construction rather than by a guard someone could delete.
    open(db, { caller: "legacy-agent", principal: null });
    expect(activeSessionFor(db, null)).toBeUndefined();
    expect(activeSessionFor(db, undefined)).toBeUndefined();
    // And the empty string must not become a shared bucket for every unauthenticated caller.
    expect(activeSessionFor(db, "")).toBeUndefined();
    db.close?.();
  });
});

describe("activeSessionFor — lifecycle and shape", () => {
  it("stops resolving once the session is ended", () => {
    const db = freshDb();
    const id = open(db, { caller: "a", principal: "alice" });
    expect(activeSessionFor(db, "alice")?.sessionId).toBe(id);

    endSession(db, id, 2_000);
    expect(activeSessionFor(db, "alice")).toBeUndefined();
    db.close?.();
  });

  it("returns the MOST RECENT open session when a principal has several", () => {
    const db = freshDb();
    // The schema does not enforce one-open-session-per-principal, and a client calling start_session
    // twice without ending the first is doing something legal. The resolver must not assume
    // uniqueness; newest is the honest answer.
    open(db, { caller: "a", principal: "alice", startedAt: 1_000 });
    const newer = open(db, { caller: "a", principal: "alice", startedAt: 5_000 });
    expect(activeSessionFor(db, "alice")?.sessionId).toBe(newer);
    db.close?.();
  });

  it("carries the session's own vault, which the HTTP context needs to match against its bound vault", () => {
    const db = freshDb();
    // HTTP contexts are vaultBound (THE-267): dispatch rejects a call naming another vault, so the
    // caller of activeSessionFor compares this against the bound vault before attaching. The
    // resolver reports the vault rather than filtering, so that policy stays at the call site.
    open(db, { caller: "a", principal: "alice", vaultId: "agents" });
    expect(activeSessionFor(db, "alice")).toStrictEqual(
      expect.objectContaining({ vaultId: "agents" }),
    );
    db.close?.();
  });

  it("keeps principals separate", () => {
    const db = freshDb();
    const a = open(db, { caller: "shared-declaration", principal: "alice" });
    const b = open(db, { caller: "shared-declaration", principal: "bob" });
    expect(activeSessionFor(db, "alice")?.sessionId).toBe(a);
    expect(activeSessionFor(db, "bob")?.sessionId).toBe(b);
    expect(a).not.toBe(b);
    db.close?.();
  });
});
