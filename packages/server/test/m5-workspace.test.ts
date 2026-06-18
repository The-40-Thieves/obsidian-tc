// Domain 23 — Workspace memory + JSONL traces, end-to-end through dispatch (THE-181).
// Covers start_session (row + trace file + session_start record), end_session (append +
// idempotent close + event_count/duration), get_session_traces (by session, windowed,
// tool-filtered), the THE-175 append contract (an injected tool-invocation record
// replays back), invalid_input paths, the write ACL on the trace path, the read-only
// kill-switch, and scope enforcement.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendTrace } from "../src/workspace/sessions";
import { makeM5Vault } from "./m5-helpers";

async function start(
  v: ReturnType<typeof makeM5Vault>,
  now = 1000,
): Promise<{ id: string; trace: string }> {
  const r = await v.call("start_session", { vault: "test", caller: "agent-x" }, { now: () => now });
  if (!r.ok) throw new Error(`start_session failed: ${JSON.stringify(r.error)}`);
  const d = r.data as { session_id: string; trace_path: string };
  return { id: d.session_id, trace: d.trace_path };
}

describe("start_session", () => {
  it("creates a row + JSONL trace seeded with a session_start record", async () => {
    const v = makeM5Vault();
    try {
      const r = await v.call(
        "start_session",
        { vault: "test", caller: "agent-x", session_metadata: { goal: "demo" } },
        { now: () => 1000 },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.data as { session_id: string; trace_path: string; started_at: number };
      expect(d.session_id).toMatch(/^sess_[a-f0-9]{24}$/);
      expect(d.trace_path).toBe(`.obsidian-tc/traces/${d.session_id}.jsonl`);
      const trace = v.read(d.trace_path);
      expect(trace).toContain('"type":"session_start"');
      expect(trace).toContain('"goal":"demo"');
      expect(v.events().some((e) => e.tool_name === "start_session" && e.status === "ok")).toBe(
        true,
      );
    } finally {
      v.cleanup();
    }
  });

  it("enforces the write ACL on the trace path, is read-only-gated, and needs write:workspace", async () => {
    const denied = makeM5Vault({ acl: { writePaths: ["allowed/**"] } });
    try {
      const r = await denied.call("start_session", { vault: "test", caller: "x" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("acl_denied");
    } finally {
      denied.cleanup();
    }
    const ro = makeM5Vault({ acl: { readOnly: true } });
    try {
      const r = await ro.call("start_session", { vault: "test", caller: "x" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
    } finally {
      ro.cleanup();
    }
    const v = makeM5Vault();
    try {
      const r = await v.call(
        "start_session",
        { vault: "test", caller: "x" },
        { grantedScopes: new Set(["read:workspace"]) },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
    } finally {
      v.cleanup();
    }
  });
});

describe("end_session", () => {
  it("appends session_end, sets ended_at, and reports event_count + duration", async () => {
    const v = makeM5Vault();
    try {
      const s = await start(v, 1000);
      const r = await v.call(
        "end_session",
        { vault: "test", session_id: s.id },
        { now: () => 5000 },
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { event_count: number; duration_ms: number; ended_at: number };
        expect(d.event_count).toBe(2); // session_start + session_end
        expect(d.duration_ms).toBe(4000);
        expect(d.ended_at).toBe(5000);
      }
    } finally {
      v.cleanup();
    }
  });

  it("rejects an unknown session and a double-end with invalid_input", async () => {
    const v = makeM5Vault();
    try {
      const missing = await v.call("end_session", { vault: "test", session_id: "sess_nope" });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("invalid_input");

      const s = await start(v);
      await v.call("end_session", { vault: "test", session_id: s.id }, { now: () => 2000 });
      const again = await v.call(
        "end_session",
        { vault: "test", session_id: s.id },
        { now: () => 3000 },
      );
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});

describe("get_session_traces", () => {
  it("replays a session's records and applies tool_filter (THE-175 append contract)", async () => {
    const v = makeM5Vault();
    try {
      const s = await start(v, 1000);
      // Simulate the ambient worker (THE-175) appending a tool-invocation record.
      appendTrace(join(v.root, s.trace), {
        ts: 1500,
        type: "event",
        tool: "write_note",
        caller: "agent-x",
        args_hash: "abc",
      });
      await v.call("end_session", { vault: "test", session_id: s.id }, { now: () => 2000 });

      const all = await v.call("get_session_traces", { vault: "test", session_id: s.id });
      if (!all.ok) throw new Error("get failed");
      const items = (all.data as { items: Array<{ type?: string; ts: number }> }).items;
      expect(items.map((i) => i.type)).toEqual(["session_start", "event", "session_end"]);

      const onlyWrite = await v.call("get_session_traces", {
        vault: "test",
        session_id: s.id,
        tool_filter: ["write_note"],
      });
      if (!onlyWrite.ok) throw new Error("filtered get failed");
      const f = (onlyWrite.data as { items: Array<{ tool?: string }> }).items;
      expect(f).toHaveLength(1);
      expect(f[0]?.tool).toBe("write_note");
    } finally {
      v.cleanup();
    }
  });

  it("replays across a started-at window when no session_id is given", async () => {
    const v = makeM5Vault();
    try {
      const s1 = await start(v, 1000);
      const s2 = await start(v, 2000);
      const win = await v.call("get_session_traces", {
        vault: "test",
        from: new Date(1500).toISOString(),
        to: new Date(3000).toISOString(),
      });
      if (!win.ok) throw new Error("window get failed");
      const items = (win.data as { items: Array<{ session_id?: string }> }).items;
      // Only s2 started inside [1500,3000]; its session_start record (ts 2000) is in-window.
      expect(items.every((i) => i.session_id === s2.id)).toBe(true);
      expect(items.some((i) => i.session_id === s1.id)).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("rejects an unknown session and an invalid ISO date", async () => {
    const v = makeM5Vault();
    try {
      const missing = await v.call("get_session_traces", {
        vault: "test",
        session_id: "sess_nope",
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("invalid_input");

      const bad = await v.call("get_session_traces", { vault: "test", from: "not-a-date" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});
