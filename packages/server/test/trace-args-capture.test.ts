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
import { expectLinear } from "./scaling";

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

describe("THE-736 — the redaction scanner is not a DoS surface", { timeout: 60_000 }, () => {
  // CodeQL js/polynomial-redos (high) on the PEM pattern. Reachable rather than theoretical:
  // `captureArgs` runs redactSecrets over the caller's RAW arguments before the size cap, so the
  // input is attacker-controlled and unbounded at that point.
  //
  // A correctness test would not have caught this — the unbounded pattern redacts correctly, it
  // just takes polynomial time doing it. So the assertion is a TIME BUDGET on the pathological
  // shape CodeQL named: many repetitions of the BEGIN marker with no END to terminate the scan.
  it("scales LINEARLY on repeated BEGIN markers, not quadratically", () => {
    // An absolute budget alone cannot express the polynomial shape. Measured on this box, the
    // unbounded pattern ran 257ms at 108KB and 2460ms at 324KB -- 3x the input for 9.6x the time.
    // A bounded regex ran 245ms and 742ms: 3x for 3x. At 108KB the two are INDISTINGUISHABLE, so
    // a budget picked there passes against the vulnerable pattern.
    //
    // So the assertion is the SCALING EXPONENT (expectLinear: log-log slope of CPU time over four
    // sizes), not a single ratio: a two-point ratio measured 5.74 against a cap of 5 on a windows
    // runner for a LINEAR pattern.
    //
    // That bounded regex was linear in the limit but cost ~600 steps per input byte (every BEGIN
    // re-walked its 16 KB window, ~2 ms per KB), and a windows runner measured 3.1-3.5x per
    // doubling at 54-216 KB (slope 1.73 against the 1.6 cap). The scan is now one pass, so the
    // base input is 1 MiB: the 1x pass costs ~10 ms, above timer noise, where 54 KB (~0.7 ms)
    // would not. The absolute bound (40 ms per 80 KB, ~30x the measured cost and 4x under the old
    // regex's ~160 ms) is what fails a return of that constant, which a slope cannot see.
    const marker = "-----BEGIN PRIVATE KEY-----";
    expectLinear(marker, (s) => redactSecrets(s), {
      baseBytes: 1024 * 1024,
      boundMsPer80KB: 40,
    });
    // And nothing matches -- there is no END marker, so zero redactions is the correct answer.
    expect(redactSecrets(marker.repeat(12000)).redactions).toBe(0);
  });

  it("the scaling assertion FAILS on the quadratic (unbounded) pattern", () => {
    // RED proof, kept: the CodeQL-flagged form of the PEM pattern, run through the same helper
    // with the same slope cap, must be refused. Without it a loosened helper or a vacuous input
    // shape would pass the real test above while proving nothing.
    const unbounded = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
    const marker = "-----BEGIN PRIVATE KEY-----";
    expect(() =>
      expectLinear(marker, (s) => s.replace(unbounded, "[REDACTED]"), {
        baseBytes: 1000 * marker.length,
        boundMsPer80KB: null,
      }),
    ).toThrow(/log-log slope/);
  });

  it("many BEGIN markers and an unterminated block neither hide nor merge a real key block", () => {
    const marker = "-----BEGIN PRIVATE KEY-----";
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${"QUJD".repeat(200)}\n-----END RSA PRIVATE KEY-----`;
    // 3000 unterminated BEGINs, a filler longer than the 16384-byte body bound, then a real block:
    // the BEGINs are out of reach of the END, so exactly the real block is redacted.
    const filler = "x".repeat(20000);
    const one = redactSecrets(`${marker.repeat(3000)}${filler}${pem} tail`);
    expect(one.redactions).toBe(1);
    expect(one.matches).toEqual({ private_key: 1 });
    expect(one.text).toBe(`${marker.repeat(3000)}${filler}[REDACTED] tail`);
    // Two real blocks with an unterminated BEGIN between them: both redacted, the stray one kept.
    const two = redactSecrets(`${pem}\n${marker}\n${filler}\n${pem}`);
    expect(two.redactions).toBe(2);
    expect(two.text).toBe(`[REDACTED]\n${marker}\n${filler}\n[REDACTED]`);
  });

  it("still redacts a real PEM block", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${"QUJD".repeat(200)}\n-----END RSA PRIVATE KEY-----`;
    const { text, redactions } = redactSecrets(`{"key":"${pem}"}`);
    expect(redactions).toBe(1);
    expect(text).not.toContain("QUJDQUJD");
    expect(text).toContain("[REDACTED]");
  });
});
