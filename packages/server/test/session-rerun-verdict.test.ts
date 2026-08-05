// THE-645 item 3 — the verdict classifier. Pure: no vault, no dispatch, no I/O.
//
// Every non-`runnable` verdict is a way a "successful" re-run would be silently wrong, so the
// classifier is DEFAULT-DENY: a record that does not positively satisfy the capture contract is
// refused, never attempted.
import { describe, expect, it } from "vitest";
import {
  classifyRecord,
  exitCodeFor,
  type RerunRecord,
  summarize,
} from "../src/workspace/rerun-verdict";
import type { TraceRecord } from "../src/workspace/sessions";

const base: TraceRecord = { ts: 1000, type: "tool_invocation", tool: "read_note", status: "ok" };

describe("THE-645 item 3 — classifyRecord", () => {
  it("runnable only when args are present AND the scan says clean", () => {
    const out = classifyRecord({ ...base, args: '{"path":"a.md"}', args_scan: "clean" });
    expect(out.verdict).toBe("runnable");
    expect(out.args).toEqual({ path: "a.md" });
  });

  it("no_capture when the args field is ABSENT — distinct from empty args", () => {
    // The universal case while `sessions.traceContent` is off. Dispatching `{}` here would be a
    // valid-looking call that is wrong, so absent must not collapse into empty.
    const out = classifyRecord({ ...base, args_hash: "abc" });
    expect(out.verdict).toBe("no_capture");
    expect(out.args).toBeNull();
  });

  it("redacted — [REDACTED] is substituted INTO the argument text", () => {
    const out = classifyRecord({ ...base, args: '{"note":"[REDACTED]"}', args_scan: "redacted:1" });
    expect(out.verdict).toBe("redacted");
    expect(out.args).toBeNull();
  });

  it("truncated — JSON cut at the cap is not parseable and must not be repaired", () => {
    const out = classifyRecord({ ...base, args: '{"body":"xxx', args_scan: "truncated" });
    expect(out.verdict).toBe("truncated");
    expect(out.args).toBeNull();
  });

  it("unparseable when JSON.parse throws on a line readTrace let through", () => {
    const out = classifyRecord({ ...base, args: "{not json", args_scan: "clean" });
    expect(out.verdict).toBe("unparseable");
    expect(out.args).toBeNull();
  });

  it("refuses args present with NO args_scan — the contract is unsatisfied, not merely unusual", () => {
    // captureArgs always writes both fields together. One without the other is a record this
    // classifier cannot vouch for, and default-deny is the safe direction.
    const out = classifyRecord({ ...base, args: '{"path":"a.md"}' });
    expect(out.verdict).toBe("unparseable");
  });

  it("refuses a non-object payload — dispatch takes a record, not a scalar", () => {
    const out = classifyRecord({ ...base, args: "42", args_scan: "clean" });
    expect(out.verdict).toBe("unparseable");
  });
});

const rec = (over: Partial<RerunRecord>): RerunRecord => ({
  seq: 0,
  ts: 1000,
  tool: "read_note",
  caller: null,
  verdict: "runnable",
  reason: "",
  recorded: { status: "ok", result_size: 10, duration_ms: 1 },
  replayed: { status: "ok", result_size: 10, duration_ms: 1 },
  divergence: "none",
  ...over,
});

describe("THE-645 item 3 — summary and exit codes", () => {
  it("counts every verdict, including the ones that are zero", () => {
    const s = summarize([rec({}), rec({ seq: 1, verdict: "no_capture", replayed: null })]);
    expect(s.total).toBe(2);
    expect(s.runnable).toBe(1);
    expect(s.byVerdict.no_capture).toBe(1);
    expect(s.byVerdict.redacted).toBe(0);
    expect(s.diverged).toBe(0);
  });

  it("exit 0 — something ran and nothing moved", () => {
    expect(exitCodeFor(summarize([rec({})]))).toBe(0);
  });

  it("exit 1 — something ran and something moved", () => {
    const s = summarize([rec({}), rec({ seq: 1, divergence: "status" })]);
    expect(s.diverged).toBe(1);
    expect(exitCodeFor(s)).toBe(1);
  });

  it("exit 2 — NOTHING was runnable, which is not the same observable outcome as success", () => {
    // The vacuity guard. On a deployment with `sessions.traceContent` off this is the ONLY
    // reachable path, and without its own code it is indistinguishable from "everything passed".
    const s = summarize([
      rec({ verdict: "no_capture", replayed: null }),
      rec({ seq: 1, verdict: "no_capture", replayed: null }),
    ]);
    expect(s.runnable).toBe(0);
    expect(exitCodeFor(s)).toBe(2);
  });

  it("exit 2 on an EMPTY trace — zero records is also zero runnable", () => {
    expect(exitCodeFor(summarize([]))).toBe(2);
  });

  it("a run with BOTH refusals and divergence exits 1, not 2", () => {
    // Partial refusal is the expected steady state; only TOTAL refusal is what 2 carries.
    const s = summarize([
      rec({ divergence: "error_code" }),
      rec({ seq: 1, verdict: "redacted", replayed: null }),
    ]);
    expect(exitCodeFor(s)).toBe(1);
  });
});
