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
  ActiveSessionTracker,
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

describe("activeSessionFor — THE-1108 resolver bound on a stale EXPLICIT session", () => {
  it("refuses to bind to an explicit session older than windowSeconds — exactly as if none existed", () => {
    const db = freshDb();
    const stale = open(db, { caller: "agent-alpha", principal: "alice", startedAt: 0 });
    expect(activeSessionFor(db, "alice", { windowSeconds: 1800, now: 1_800_001 })).toBeUndefined();
    // The row itself is untouched by the resolver — only a sweep closes it.
    const row = db.prepare("SELECT ended_at FROM workspace_sessions WHERE id = ?").get(stale) as {
      ended_at: number | null;
    };
    expect(row.ended_at).toBeNull();
    db.close?.();
  });

  it("still binds an explicit session within the window", () => {
    const db = freshDb();
    const fresh = open(db, { caller: "agent-alpha", principal: "alice", startedAt: 1_000_000 });
    expect(activeSessionFor(db, "alice", { windowSeconds: 1800, now: 1_800_000 })?.sessionId).toBe(
      fresh,
    );
    db.close?.();
  });

  it("does NOT apply the bound to an IMPLICIT (server-opened) session — that stays closeStaleImplicitSessions's job", () => {
    const db = freshDb();
    const implicit = open(db, { caller: null, principal: "alice", startedAt: 0 });
    expect(activeSessionFor(db, "alice", { windowSeconds: 1800, now: 1_800_001 })?.sessionId).toBe(
      implicit,
    );
    db.close?.();
  });

  it("omitting windowSeconds reproduces the pre-THE-1108 behaviour byte-for-byte, however old the row", () => {
    const db = freshDb();
    const ancient = open(db, { caller: "agent-alpha", principal: "alice", startedAt: 0 });
    expect(activeSessionFor(db, "alice")?.sessionId).toBe(ancient);
    expect(activeSessionFor(db, "alice", {})?.sessionId).toBe(ancient);
    db.close?.();
  });

  it("re-keys on `caller` only for the STALENESS check, never for identity — the cross-principal probe still fails", () => {
    const db = freshDb();
    open(db, { caller: "agent-alpha", principal: "alice", startedAt: 0 });
    // Same as the undecorated call: a caller-supplied declaration must never resolve a session,
    // window or no window.
    expect(activeSessionFor(db, "agent-alpha", { windowSeconds: 1800, now: 1 })).toBeUndefined();
    db.close?.();
  });
});

describe("ActiveSessionTracker.validate — THE-1108 fix (Codex P1-1): stdio must stop reusing a closed/stale entry", () => {
  it("returns the tracked entry unchanged when the row is still open and within window", () => {
    const db = freshDb();
    const id = open(db, { caller: "agent-alpha", principal: "stdio", startedAt: 0 });
    const tracker = new ActiveSessionTracker();
    tracker.set("stdio", id, "main");
    expect(tracker.validate(db, "stdio", { windowSeconds: 1800, now: 1000 })).toStrictEqual({
      sessionId: id,
      vaultId: "main",
    });
    db.close?.();
  });

  it("clears and refuses a tracked entry whose row the SWEEP already closed — SQL closing a row is invisible to a raw get()", () => {
    const db = freshDb();
    const id = open(db, { caller: "agent-alpha", principal: "stdio", startedAt: 0 });
    const tracker = new ActiveSessionTracker();
    tracker.set("stdio", id, "main");
    // Simulate what closeExpiredExplicitSessions does: close the row directly in SQL, exactly as
    // the sweep would, WITHOUT going through end_session or touching the tracker.
    db.prepare("UPDATE workspace_sessions SET ended_at = ? WHERE id = ?").run(999_999, id);
    expect(tracker.validate(db, "stdio")).toBeUndefined();
    // Cleared, not merely masked — a second read must not find a ghost entry either.
    expect(tracker.get("stdio")).toBeUndefined();
    db.close?.();
  });

  it("clears and refuses a tracked entry whose row `end_session` already closed from elsewhere (defense in depth)", () => {
    const db = freshDb();
    const id = open(db, { caller: "agent-alpha", principal: "stdio", startedAt: 0 });
    const tracker = new ActiveSessionTracker();
    tracker.set("stdio", id, "main");
    endSession(db, id, 1000);
    expect(tracker.validate(db, "stdio")).toBeUndefined();
    expect(tracker.get("stdio")).toBeUndefined();
    db.close?.();
  });

  it("applies the SAME age rule as activeSessionFor's durable lookup to an explicit row, and clears once past it", () => {
    const db = freshDb();
    const id = open(db, { caller: "agent-alpha", principal: "stdio", startedAt: 0 });
    const tracker = new ActiveSessionTracker();
    tracker.set("stdio", id, "main");
    // Past windowSeconds: the durable resolver would refuse this row too (see the describe block
    // above) — validate must agree, not keep serving dispatch a session activeSessionFor would not.
    expect(tracker.validate(db, "stdio", { windowSeconds: 1800, now: 1_800_001 })).toBeUndefined();
    expect(tracker.get("stdio")).toBeUndefined();
    // The row itself is untouched — validate only stops REUSE, same as activeSessionFor's own bound.
    const row = db.prepare("SELECT ended_at FROM workspace_sessions WHERE id = ?").get(id) as {
      ended_at: number | null;
    };
    expect(row.ended_at).toBeNull();
    db.close?.();
  });

  it("clears and refuses a tracked entry whose row does not exist at all (e.g. a different db)", () => {
    const tracker = new ActiveSessionTracker();
    const db = freshDb();
    tracker.set("stdio", genSessionId(), "main");
    expect(tracker.validate(db, "stdio", { windowSeconds: 1800 })).toBeUndefined();
    expect(tracker.get("stdio")).toBeUndefined();
    db.close?.();
  });

  it("returns undefined without touching the db when nothing is tracked for this caller", () => {
    const db = freshDb();
    const tracker = new ActiveSessionTracker();
    expect(tracker.validate(db, "stdio")).toBeUndefined();
    db.close?.();
  });
});
