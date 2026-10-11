// THE-838 — a session belongs to the principal that opened it, and only that principal may end it.
//
// `end_session` validated exactly two things: the session exists, and it belongs to the requested
// VAULT. It never compared `s.principal` to `ctx.caller`, so any principal holding
// `write:workspace` on the vault could end another principal's session — and, because the handler
// appends a `session_end` record carrying the caller's arbitrary `end_metadata`, could write
// attacker-controlled JSON into another principal's JSONL trace. Those traces feed `inferCitations`
// and session replay.
//
// The property was already established next door and simply not applied here. `activeSessionFor`'s
// docblock (workspace/sessions.ts) says it resolves on `principal` (server-observed) and NEVER on
// `caller` (caller-supplied), "because resolving by a declared value would let any client holding
// write:workspace claim another principal's session id, and a session id is the correlation key for
// that principal's retrieval history". PR #691 gate-watched that failing. `end_session` never calls
// `activeSessionFor`, so it inherited none of it.
//
// The refusal cases below were WATCHED FAILING against the unfixed handler first — a test written
// only against fixed code proves nothing about the bug it claims to cover.
import { describe, expect, it } from "vitest";
import { makeM5Vault } from "./m5-helpers";

/** Open a session as `principal`. `caller` (the input field) is caller-DECLARED and deliberately
 *  different from the server-observed principal, so a test cannot pass by conflating the two. */
async function startAs(
  v: ReturnType<typeof makeM5Vault>,
  principal: string | null,
  now = 1000,
): Promise<string> {
  const r = await v.call(
    "start_session",
    { vault: "test", caller: "declared-not-observed" },
    { now: () => now, caller: principal },
  );
  if (!r.ok) throw new Error(`start_session failed: ${JSON.stringify(r.error)}`);
  return (r.data as { session_id: string }).session_id;
}

describe("THE-838: end_session enforces session ownership", () => {
  it("REFUSES a principal ending another principal's session", async () => {
    const v = makeM5Vault();
    try {
      const id = await startAs(v, "alice");
      const r = await v.call(
        "end_session",
        { vault: "test", session_id: id },
        { now: () => 5000, caller: "bob" },
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("forbidden");
      // The refusal must leave the session OPEN, not merely return an error. A handler that threw
      // after already closing the row would still have taken alice's session from her.
      const after = await v.call(
        "end_session",
        { vault: "test", session_id: id },
        { now: () => 6000, caller: "alice" },
      );
      expect(after.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("does not let a foreign caller inject end_metadata into another principal's trace", async () => {
    // The impact half of the same bug, asserted directly rather than inferred from the refusal:
    // end_metadata is `z.record(z.string(), z.unknown())`, so its content is unconstrained.
    const v = makeM5Vault();
    try {
      const id = await startAs(v, "alice");
      await v.call(
        "end_session",
        { vault: "test", session_id: id, end_metadata: { injected: "by-bob" } },
        { now: () => 5000, caller: "bob" },
      );
      const traces = await v.call(
        "get_session_traces",
        { vault: "test", session_id: id },
        { caller: "alice" },
      );
      expect(traces.ok).toBe(true);
      if (!traces.ok) return;
      expect(JSON.stringify(traces.data)).not.toContain("by-bob");
    } finally {
      v.cleanup();
    }
  });

  it("ALLOWS a principal ending its own session — the fix is not a blanket denial", async () => {
    const v = makeM5Vault();
    try {
      const id = await startAs(v, "alice");
      const r = await v.call(
        "end_session",
        { vault: "test", session_id: id },
        { now: () => 5000, caller: "alice" },
      );
      expect(r.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("treats a NULL-principal session as UNOWNED: only the cross-principal scope may end it", async () => {
    // This pinned the opposite ("any caller may end it"), reasoned as "no principal to protect".
    // But NULL was never "no one": a valid JWT with no `sub` is `caller: null`, so every sub-less
    // credential counted as the owner of every NULL-principal session and could end another's and
    // append `end_metadata` to its trace. start_session is `principalOwned` now (no new NULL rows);
    // the legacy ones are closed deliberately by the holder of admin:workspace.
    // (The helper's default grant is `*`, which includes that scope, so the callers narrow it.)
    const v = makeM5Vault();
    try {
      const id = await startAs(v, "alice");
      v.db.prepare("UPDATE workspace_sessions SET principal = NULL WHERE id = ?").run(id);
      const denied = await v.call(
        "end_session",
        { vault: "test", session_id: id },
        { now: () => 5000, caller: "someone", grantedScopes: new Set(["write:workspace"]) },
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("forbidden");
      const admin = await v.call(
        "end_session",
        { vault: "test", session_id: id },
        {
          now: () => 5000,
          caller: "ops",
          grantedScopes: new Set(["write:workspace", "admin:workspace"]),
        },
      );
      expect(admin.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("refuses BEFORE the already-ended check, so ownership is not leaked by the error code", async () => {
    // Order matters. If `session already ended` were reported first, a foreign caller could
    // distinguish an existing-but-closed session from a nonexistent one — a small oracle, but the
    // handler has no reason to offer it.
    const v = makeM5Vault();
    try {
      const id = await startAs(v, "alice");
      await v.call(
        "end_session",
        { vault: "test", session_id: id },
        { now: () => 5000, caller: "alice" },
      );
      const r = await v.call(
        "end_session",
        { vault: "test", session_id: id },
        { now: () => 6000, caller: "bob" },
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("forbidden");
    } finally {
      v.cleanup();
    }
  });
});

// A source scan, not a behaviour test. The behavioural cases above pin `end_session`; this pins the
// SET of handlers that reach a workspace_sessions row from caller-supplied input, so a handler
// added later cannot inherit the gap silently. THE-838's own finding was that a security property
// established on one verb (`activeSessionFor`) was never applied to its sibling — the failure mode
// is a NEW call site, not a regression in an existing one.
describe("THE-838: the session_id-resolving handler set is closed", () => {
  it("every getSession call site is a known one, and end_session compares the principal", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("../src/tools/m5/session-tools.ts", import.meta.url)),
      "utf8",
    );

    // Floor first: a scan that finds nothing must fail, not report a clean result.
    const sites = [...src.matchAll(/getSession\(ctx\.db, input\.session_id\)/g)];
    expect(sites.length).toBeGreaterThanOrEqual(2);

    // Exactly two handlers resolve a caller-supplied session id today:
    //   * end_session      — a WRITE. Guarded below.
    //   * get_session_traces — a READ that deliberately does NOT filter by principal, and says so
    //     in its own comment. It mitigates the CONTENT axis instead, stripping captured `args` so
    //     cross-principal note bodies cannot leave through it. That is a recorded posture decision,
    //     not this ticket's oversight; it is pinned here so changing it is a choice.
    expect(sites.length).toBe(2);
    expect(src).toContain("this tool does not filter by principal");

    // The guard itself: server-observed `principal`, never the caller-declared `caller` column.
    expect(src).toContain("s.principal === null");
    expect(src).toContain("s.principal !== ctx.caller");
    expect(src).toContain('err.forbidden("session belongs to another principal"');

    // And it precedes the already-ended check, so the error code is not an ownership oracle.
    const guardAt = src.indexOf("s.principal !== ctx.caller");
    const endedAt = src.indexOf('err.invalidInput("session already ended"');
    expect(guardAt).toBeGreaterThan(-1);
    expect(endedAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(endedAt);
  });
});
