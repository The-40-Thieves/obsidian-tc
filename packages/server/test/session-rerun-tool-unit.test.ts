// session_rerun (m6/admin-tools.ts) — the fast, dispatch-level half of its coverage. Registers
// only M6 onto a bare ToolRegistry with a STUB `rerun` closure (M6Deps.rerun), so every test here
// proves the TOOL's own wiring — scope gate, HITL gate, `.strict()` schema, the session lookup,
// and (critically) the `replayScopes = ctx.grantedScopes ∩ RERUN_SCOPES` computation forwarded to
// the sandbox builder — without paying for a real `buildServerRuntime` + staged vault copy on
// every case. The real sandbox lifecycle (staging, a second runtime, disposal on success/error/
// timeout, and that a mutating record narrowed out of `replayScopes` is genuinely never executed)
// is session-rerun-tool-sandbox.test.ts's job.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { RateLimiter } from "../src/throttle";
import { registerM6Tools, type SandboxRerunFn } from "../src/tools/m6";
import { VaultRegistry } from "../src/vault/registry";
import { cacheTraceRelPath, genSessionId, insertSession } from "../src/workspace/sessions";
import { openMemoryDb } from "./helpers";

const NO_THROTTLE = {
  read: { perMinute: 1e6, burst: 1e6 },
  write: { perMinute: 1e6, burst: 1e6 },
  bulk: { perMinute: 1e6, burst: 1e6 },
  execute: { perMinute: 1e6, burst: 1e6 },
  admin: { perMinute: 1e6, burst: 1e6 },
};

const ZERO_BY_VERDICT = {
  runnable: 0,
  no_capture: 0,
  redacted: 0,
  truncated: 0,
  skipped_mutating: 0,
  unparseable: 0,
  refused_by_policy: 0,
  served_from_cache: 0,
};

const CANNED_RESULT = {
  records: [],
  summary: { total: 0, runnable: 0, diverged: 0, byVerdict: ZERO_BY_VERDICT },
};

interface Harness {
  db: Database;
  registry: ToolRegistry;
  calls: Array<Parameters<SandboxRerunFn>[0]>;
}

function buildHarness(rerun?: SandboxRerunFn): Harness {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const vaultRegistry = new VaultRegistry([{ id: "main", path: "/tmp/does-not-matter" }]);
  const rateLimiter = new RateLimiter(NO_THROTTLE as never);
  const registry = new ToolRegistry({ verifyElicit: elicitVerifier, rateLimiter });
  const calls: Array<Parameters<SandboxRerunFn>[0]> = [];
  registerM6Tools(registry, {
    vaultRegistry,
    rateLimiter,
    version: "test",
    startedAt: 0,
    authMode: "none",
    throttle: {} as never,
    observability: { otel: false, prometheus: false, morgiana: false },
    embeddingsProvider: "ollama",
    governorMaxResponseBytes: 1e6,
    ...(rerun
      ? {
          rerun: async (params) => {
            calls.push(params);
            return rerun(params);
          },
        }
      : {}),
  });
  return { db, registry, calls };
}

/** Only the SQLite row matters here — the stub `rerun` closure never reads the trace file, so
 *  there is nothing to write one for (unlike session-rerun-tool-sandbox.test.ts, which exercises
 *  the real `rerunSession` and needs a real trace). */
function seedSession(db: Database, vaultId: string): string {
  const id = genSessionId();
  insertSession(db, {
    id,
    vaultId,
    caller: "alice",
    startedAt: 1000,
    tracePath: cacheTraceRelPath(id),
  });
  return id;
}

function ctxFor(db: Database, over: Partial<CallerContext> = {}): CallerContext {
  return {
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "main",
    db,
    ...over,
  };
}

function un<T>(r: ToolResult): T {
  if (!r.ok) throw new Error(`expected ok, got error: ${JSON.stringify(r.error)}`);
  return r.data as T;
}
function errCode(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return r.error.code;
}

async function mintToken(
  db: Database,
  vaultId: string,
  input: Record<string, unknown>,
): Promise<string> {
  return issueElicitToken(db, {
    vaultId,
    toolName: "session_rerun",
    argsHash: argsHash("session_rerun", input),
    caller: "test",
  });
}

describe("session_rerun — scope + HITL gate", () => {
  it("is refused without admin:rerun (scope gate runs before HITL)", async () => {
    const { db, registry } = buildHarness(async () => CANNED_RESULT as never);
    const sid = seedSession(db, "main");
    const input = { vault: "main", session_id: sid };
    const res = await registry.dispatch(
      "session_rerun",
      input,
      ctxFor(db, { grantedScopes: new Set(["read:*"]) }),
    );
    expect(errCode(res)).toBe("forbidden");
  });

  it("demands a HITL confirmation (destructive: true), then succeeds with a valid token", async () => {
    const { db, registry, calls } = buildHarness(async () => CANNED_RESULT as never);
    const sid = seedSession(db, "main");
    const input = { vault: "main", session_id: sid };

    const need = await registry.dispatch("session_rerun", input, ctxFor(db));
    expect(errCode(need)).toBe("elicit_required");

    const token = await mintToken(db, "main", input);
    const ok = await registry.dispatch("session_rerun", input, ctxFor(db, { elicitToken: token }));
    expect(un<{ session_id: string; vault: string }>(ok).session_id).toBe(sid);
    expect(un<{ vault: string }>(ok).vault).toBe("main");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe(sid);
    expect(calls[0]?.vaultId).toBe("main");
  });
});

describe("session_rerun — no scope escalation: replayScopes = grantedScopes ∩ RERUN_SCOPES", () => {
  it("a caller holding only read:* + admin:rerun forwards replayScopes = ['read:*']", async () => {
    const { db, registry, calls } = buildHarness(async () => CANNED_RESULT as never);
    const sid = seedSession(db, "main");
    const input = { vault: "main", session_id: sid };
    const token = await mintToken(db, "main", input);
    const granted = new Set(["read:*", "admin:rerun"]);
    const res = await registry.dispatch(
      "session_rerun",
      input,
      ctxFor(db, { grantedScopes: granted, elicitToken: token }),
    );
    expect(res.ok).toBe(true);
    expect(calls[0]?.replayScopes).toEqual(["read:*"]);
  });

  it("a caller holding '*' forwards the full RERUN_SCOPES ceiling", async () => {
    const { db, registry, calls } = buildHarness(async () => CANNED_RESULT as never);
    const sid = seedSession(db, "main");
    const input = { vault: "main", session_id: sid };
    const token = await mintToken(db, "main", input);
    const res = await registry.dispatch(
      "session_rerun",
      input,
      ctxFor(db, { grantedScopes: new Set(["*"]), elicitToken: token }),
    );
    expect(res.ok).toBe(true);
    expect(calls[0]?.replayScopes).toEqual([
      "read:*",
      "write:*",
      "delete:*",
      "bulk:*",
      "execute:*",
    ]);
  });

  it("a narrow per-resource grant (write:notes, not write:*) does NOT unlock the write family", async () => {
    const { db, registry, calls } = buildHarness(async () => CANNED_RESULT as never);
    const sid = seedSession(db, "main");
    const input = { vault: "main", session_id: sid };
    const token = await mintToken(db, "main", input);
    const res = await registry.dispatch(
      "session_rerun",
      input,
      ctxFor(db, { grantedScopes: new Set(["write:notes", "admin:rerun"]), elicitToken: token }),
    );
    expect(res.ok).toBe(true);
    expect(calls[0]?.replayScopes).toEqual([]);
  });
});

describe("session_rerun — timeout_ms", () => {
  it("defaults timeout_ms when omitted, forwards it when given", async () => {
    const { db, registry, calls } = buildHarness(async () => CANNED_RESULT as never);
    const sid = seedSession(db, "main");
    const input1 = { vault: "main", session_id: sid };
    const token1 = await mintToken(db, "main", input1);
    await registry.dispatch("session_rerun", input1, ctxFor(db, { elicitToken: token1 }));
    expect(calls[0]?.timeoutMs).toBe(60_000);

    const input2 = { vault: "main", session_id: sid, timeout_ms: 5000 };
    const token2 = await mintToken(db, "main", input2);
    await registry.dispatch("session_rerun", input2, ctxFor(db, { elicitToken: token2 }));
    expect(calls[1]?.timeoutMs).toBe(5000);
  });
});

describe("session_rerun — sandbox-only: no parameter selects observe/live mode", () => {
  it("rejects an unrecognized key (e.g. a caller trying to pass sandbox/observe) via the strict schema", async () => {
    const { db, registry } = buildHarness(async () => CANNED_RESULT as never);
    const sid = seedSession(db, "main");
    const res = await registry.dispatch(
      "session_rerun",
      { vault: "main", session_id: sid, sandbox: false },
      ctxFor(db),
    );
    expect(errCode(res)).toBe("validation_error");
  });
});

describe("session_rerun — session lookup", () => {
  it("an unknown session_id is refused as invalid_input", async () => {
    const { db, registry } = buildHarness(async () => CANNED_RESULT as never);
    const input = { vault: "main", session_id: "nope" };
    const token = await mintToken(db, "main", input);
    const res = await registry.dispatch("session_rerun", input, ctxFor(db, { elicitToken: token }));
    expect(errCode(res)).toBe("invalid_input");
  });

  it("a session recorded against a DIFFERENT vault than the input names is refused as invalid_input", async () => {
    const { db, registry } = buildHarness(async () => CANNED_RESULT as never);
    const sid = seedSession(db, "other-vault");
    const input = { vault: "main", session_id: sid };
    const token = await mintToken(db, "main", input);
    const res = await registry.dispatch("session_rerun", input, ctxFor(db, { elicitToken: token }));
    expect(errCode(res)).toBe("invalid_input");
  });
});

describe("session_rerun — unwired dependency", () => {
  it("fails loudly (never a silent no-op / live-vault fallback) when M6Deps.rerun is not wired", async () => {
    const { db, registry } = buildHarness(); // no `rerun` closure at all
    const sid = seedSession(db, "main");
    const input = { vault: "main", session_id: sid };
    const token = await mintToken(db, "main", input);
    const res = await registry.dispatch("session_rerun", input, ctxFor(db, { elicitToken: token }));
    expect(errCode(res)).toBe("internal");
  });
});
