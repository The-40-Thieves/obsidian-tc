// THE-736 — capturing dispatch arguments onto the session trace, and the limits on where they go.
//
// Three properties, in descending order of how badly they matter:
//
//   1. OFF BY DEFAULT. A capture-posture change that shipped on would be the change, not the flag.
//   2. Captured arguments NEVER leave through `get_session_traces`. That tool is
//      `read:workspace`-scoped, does NOT filter by principal, and its output schema is
//      `.catchall(z.unknown())` — so a new field reaches the client BY DEFAULT. Omission has to be
//      an act, and this test is what makes it stay one.
//   3. Secrets are scrubbed and size is capped on the way in, using the same scanner the episode
//      capture bus runs.
//
// `captureArgs` is tested directly because the flag's whole job is to be off: driving a full
// dispatch to prove a field is ABSENT is a weaker signal than proving the function that would
// have produced it returns nothing.
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { redactSecrets } from "../src/experiential/redact";
import { captureArgs } from "../src/mcp/registry/dispatch-observability";
import { appendTrace } from "../src/workspace/sessions";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

const MAX = 4096;

describe("THE-736 — captureArgs", () => {
  it("returns NOTHING when capture is off — absent, not null", () => {
    const out = captureArgs({ path: "notes/private.md", content: "secret body" }, false, MAX);
    // Absent, not `{args: null}`. A null would be indistinguishable from "captured, and it was
    // null" — a failure encoded as a valid domain value.
    expect(out).toEqual({});
    expect("args" in out).toBe(false);
    expect("args_scan" in out).toBe(false);
  });

  it("captures the arguments when explicitly enabled", () => {
    const out = captureArgs({ path: "a.md", limit: 5 }, true, MAX);
    expect(out.args).toContain("a.md");
    expect(out.args_scan).toBe("clean");
  });

  it("redacts secrets and says how many", () => {
    const out = captureArgs(
      { note: "token: ghp_0123456789abcdefghijklmnopqrstuvwxyzAB" },
      true,
      MAX,
    );
    expect(out.args).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyzAB");
    expect(out.args_scan).toMatch(/^redacted:[1-9]\d*$/);
  });

  it("caps size, and reports truncation rather than pretending the capture is whole", () => {
    const out = captureArgs({ body: "x".repeat(MAX * 2) }, true, MAX);
    expect(out.args?.length).toBeLessThanOrEqual(MAX + "…[truncated]".length);
    expect(out.args_scan).toBe("truncated");
  });

  it("redacts BEFORE truncating, so a cut can never leave half a secret readable", () => {
    // The secret sits past the cap. If truncation ran first the tail would be dropped and the
    // test would pass for the wrong reason — so the padding is sized to keep it inside the
    // retained prefix, where only redaction can remove it.
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
    const out = captureArgs({ pad: "y".repeat(MAX - 200), tail: secret }, true, MAX);
    expect(out.args).not.toContain(secret);
    expect(out.args).not.toContain(secret.slice(0, 20));
  });

  it("handles a null/undefined payload without throwing", () => {
    expect(captureArgs(undefined, true, MAX).args).toBe("null");
    expect(captureArgs(null, true, MAX).args).toBe("null");
  });
});

let v: M5Vault | undefined;
afterEach(() => v?.cleanup());

function data<T>(r: ToolResult): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}

describe("THE-736 — captured arguments do not leave through get_session_traces", () => {
  it("strips args and args_scan from every returned record", async () => {
    const SECRET = "the736-must-not-escape-4b1e";
    v = makeM5Vault();
    const started = data<{ session_id: string; trace_path: string }>(
      await v.call("start_session", { vault: v.id, caller: "alice" }),
    );

    // Simulate a dispatch recorded while `sessions.traceContent` was ON.
    appendTrace(join(v.cacheDir, started.trace_path), {
      ts: 1500,
      type: "tool_invocation",
      tool: "patch_note",
      args_hash: "abc",
      args: JSON.stringify({ path: "private/salary.md", content: SECRET }),
      args_scan: "clean",
    });

    const out = data<{ items: Array<Record<string, unknown>> }>(
      await v.call("get_session_traces", { vault: v.id, session_id: started.session_id }),
    );

    // Vacuity guard: the record must actually be in the reply, or "no args" is trivially true.
    const invocation = out.items.find((i) => i.type === "tool_invocation");
    expect(invocation).toBeDefined();
    expect(invocation?.args_hash).toBe("abc");

    // The property.
    expect(invocation).not.toHaveProperty("args");
    expect(invocation).not.toHaveProperty("args_scan");
    expect(JSON.stringify(out.items)).not.toContain(SECRET);
  });

  it("keeps the non-content fields, so stripping is surgical rather than blanket", async () => {
    v = makeM5Vault();
    const started = data<{ session_id: string; trace_path: string }>(
      await v.call("start_session", { vault: v.id, caller: "alice" }),
    );
    appendTrace(join(v.cacheDir, started.trace_path), {
      ts: 1500,
      type: "tool_invocation",
      tool: "read_note",
      caller: "alice",
      duration_ms: 12,
      args_hash: "h",
      result_size: 99,
      args: "{}",
    });
    const out = data<{ items: Array<Record<string, unknown>> }>(
      await v.call("get_session_traces", { vault: v.id, session_id: started.session_id }),
    );
    const rec = out.items.find((i) => i.type === "tool_invocation");
    expect(rec).toMatchObject({ tool: "read_note", duration_ms: 12, result_size: 99 });
  });
});

describe("THE-736 — the redaction scanner is not a DoS surface", () => {
  // CodeQL js/polynomial-redos (high) on the PEM pattern. Reachable rather than theoretical:
  // `captureArgs` runs redactSecrets over the caller's RAW arguments before the size cap, so the
  // input is attacker-controlled and unbounded at that point.
  //
  // A correctness test would not have caught this — the unbounded pattern redacts correctly, it
  // just takes polynomial time doing it. So the assertion is a TIME BUDGET on the pathological
  // shape CodeQL named: many repetitions of the BEGIN marker with no END to terminate the scan.
  it("scales LINEARLY on repeated BEGIN markers, not quadratically", () => {
    // An absolute time budget cannot express this. Measured on this box, the unbounded pattern
    // ran 257ms at 108KB and 2460ms at 324KB -- 3x the input for 9.6x the time. The bounded one
    // ran 245ms and 742ms: 3x for 3x. At 108KB the two are INDISTINGUISHABLE, so a budget picked
    // there passes against the vulnerable pattern, which is exactly what happened on the first
    // attempt at this test.
    //
    // So the assertion is the SCALING RATIO, which is also what makes it robust to a loaded CI
    // box: both measurements move together.
    const gen = (n: number): string => "-----BEGIN PRIVATE KEY-----".repeat(n);
    const time = (s: string): number => {
      const t0 = performance.now();
      redactSecrets(s);
      return performance.now() - t0;
    };
    const small = gen(4000);
    const large = gen(12000); // 3x the input
    time(small); // warm up, so JIT compilation does not land in the first measurement
    const tSmall = Math.max(time(small), 1);
    const tLarge = time(large);
    const ratio = tLarge / tSmall;
    // Linear would be ~3. Quadratic would be ~9. 5 sits between them with room for noise.
    expect(ratio).toBeLessThan(5);
    // And nothing matches -- there is no END marker, so zero redactions is the correct answer.
    expect(redactSecrets(large).redactions).toBe(0);
  });

  it("still redacts a real PEM block", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${"QUJD".repeat(200)}\n-----END RSA PRIVATE KEY-----`;
    const { text, redactions } = redactSecrets(`{"key":"${pem}"}`);
    expect(redactions).toBe(1);
    expect(text).not.toContain("QUJDQUJD");
    expect(text).toContain("[REDACTED]");
  });
});
