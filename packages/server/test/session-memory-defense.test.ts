// GH #994 follow-up — memoryDefense on start_session.session_metadata / end_session.end_metadata.
// Before this file's fix, both fields were arbitrary caller JSON stored UNSCANNED in the
// workspace_sessions row (session_metadata only) and the session's JSONL trace (both fields) —
// a vault with `memoryDefense: { mode: "block" }` still let a caller stash a secret in a session's
// metadata. See tools/m5/session-tools.ts.
//
// Secrets assembled at runtime — same no-literal-secret convention as memory-defense.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MetricsRecorder } from "../src/metrics/registry";
import { getSession } from "../src/workspace/sessions";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

function fakeOpenAiKey(): string {
  return ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
}

function un<T>(r: any): T {
  return r.data as T;
}
function errOf(r: any): { code: string; message: string; details?: Record<string, unknown> } {
  return r.error;
}

describe("memoryDefense on start_session/end_session (GH #994 follow-up)", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("block mode: start_session refuses a secret in session_metadata, nothing persisted", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const secret = fakeOpenAiKey();
    const r = await v.call("start_session", {
      vault: "test",
      caller: "agent-x",
      session_metadata: { note: secret },
    });
    expect(r.ok).toBe(false);
    const err = errOf(r);
    expect(err.code).toBe("secret_detected");
    expect(JSON.stringify(err)).not.toContain(secret);
  });

  it("redact mode: start_session redacts session_metadata in BOTH the DB row and the JSONL trace", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const secret = fakeOpenAiKey();
    const r = await v.call(
      "start_session",
      { vault: "test", caller: "agent-x", session_metadata: { note: secret } },
      { now: () => 1000 },
    );
    expect(r.ok).toBe(true);
    const d = un<{ session_id: string; trace_path: string; redactions: number }>(r);
    expect(d.redactions).toBe(1);

    const row = getSession(v.db, d.session_id);
    expect(row?.metadata_json).not.toContain(secret);
    expect(row?.metadata_json).toContain("[REDACTED]");

    const trace = readFileSync(join(v.cacheDir, d.trace_path), "utf8");
    expect(trace).not.toContain(secret);
    expect(trace).toContain("[REDACTED]");
  });

  it("block mode: end_session refuses a secret in end_metadata, session stays open", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const started = un<{ session_id: string }>(
      await v.call("start_session", { vault: "test", caller: "agent-x" }),
    );
    const secret = fakeOpenAiKey();
    const r = await v.call("end_session", {
      vault: "test",
      session_id: started.session_id,
      end_metadata: { note: secret },
    });
    expect(r.ok).toBe(false);
    expect(errOf(r).code).toBe("secret_detected");
    expect(getSession(v.db, started.session_id)?.ended_at).toBeNull();
  });

  it("redact mode: end_session redacts end_metadata in the JSONL trace and reports redactions", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const started = un<{ session_id: string; trace_path: string }>(
      await v.call("start_session", { vault: "test", caller: "agent-x" }),
    );
    const secret = fakeOpenAiKey();
    const r = await v.call("end_session", {
      vault: "test",
      session_id: started.session_id,
      end_metadata: { note: secret },
    });
    expect(r.ok).toBe(true);
    expect(un<{ redactions: number }>(r).redactions).toBe(1);
    const trace = readFileSync(join(v.cacheDir, started.trace_path), "utf8");
    expect(trace).not.toContain(secret);
    expect(trace).toContain("[REDACTED]");
  });

  it("off (default): session_metadata/end_metadata persist verbatim — unchanged baseline", async () => {
    v = makeM5Vault();
    const secret = fakeOpenAiKey();
    const started = un<{ session_id: string; trace_path: string }>(
      await v.call("start_session", {
        vault: "test",
        caller: "agent-x",
        session_metadata: { note: secret },
      }),
    );
    expect(getSession(v.db, started.session_id)?.metadata_json).toContain(secret);
    const ended = await v.call("end_session", {
      vault: "test",
      session_id: started.session_id,
      end_metadata: { note: secret },
    });
    expect(ended.ok).toBe(true);
    const trace = readFileSync(join(v.cacheDir, started.trace_path), "utf8");
    expect(trace).toContain(secret);
  });

  it("a matched hit is tagged on the memoryDefense metric, never as a content-bearing label", async () => {
    const metrics = new MetricsRecorder();
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false }, metrics });
    const secret = fakeOpenAiKey();
    await v.call("start_session", {
      vault: "test",
      caller: "agent-x",
      session_metadata: { note: secret },
    });
    const dump = await metrics.metrics();
    expect(dump).toContain('obsidian_tc_memory_defense_hits_total{pattern="openai_key"} 1');
    expect(dump).not.toContain(secret);
  });
});
