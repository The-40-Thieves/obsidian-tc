// Follow-up security fix: update_task's redact-mode `new_state` used to fall back to `updated`
// (the RAW caller-supplied fields) whenever the persisted line failed to re-parse
// (`persistedParsed = parseTaskLine(persistedLine) ?? updated`, tasks-tools.ts). `updated` is
// built straight from the caller's `set.description` etc. BEFORE any scan — a secret survives
// there even after `scan.content` has been redacted on disk. The re-parse is expected to succeed
// whenever the original parse did (redaction only replaces matched substrings in place), so this
// fallback leg is rare in practice — this test forces it deterministically by mocking
// `parseTaskLine` to fail on its SECOND call within the handler (the re-parse of the persisted
// line), while the FIRST call (parsing the original line, pre-edit) still runs for real.
//
// Every secret value below is assembled at runtime (string concatenation), never a single literal
// in source that itself matches a SECRET_PATTERNS regex — same house rule
// memory-defense.test.ts documents in its own header.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

function fakeOpenAiKey(): string {
  return ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
}

// Call-count gate: real parseTaskLine for every call except the Nth, set per-test via
// `failParseOnCall`. Reset in afterEach so tests never leak state into one another.
let callCount = 0;
let failParseOnCall = -1;

vi.mock("../src/tools/m4/tasks-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/m4/tasks-model")>();
  return {
    ...actual,
    parseTaskLine: (line: string) => {
      callCount++;
      if (callCount === failParseOnCall) return null;
      return actual.parseTaskLine(line);
    },
  };
});

describe("update_task (redact mode) — new_state never falls back to the raw caller fields", () => {
  let v: M4Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    callCount = 0;
    failParseOnCall = -1;
  });

  it("forced re-parse failure after a redaction: new_state omits the raw secret", async () => {
    v = makeM4Vault({
      files: { "probe/tasks.md": "- [ ] wiring probe task\n" },
      memoryDefense: { mode: "redact", pii: true },
    });
    // Call 1 = parseTaskLine(original) before the edit (must succeed so the handler proceeds
    // past its "line is not a task" guard). Call 2 = the re-parse of the persisted (redacted)
    // line — forced to fail, exercising the fallback leg this fix closes.
    failParseOnCall = 2;
    const secret = fakeOpenAiKey();
    const r = await v.call("update_task", {
      vault: "test",
      path: "probe/tasks.md",
      line: 1,
      set: { description: secret },
    });
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
    const out = r.data as {
      new_state: { status?: string; description?: string };
      redactions?: number;
    };
    expect(out.redactions ?? 0).toBeGreaterThan(0);
    // The load-bearing assertion: even though the re-parse failed, new_state must never echo
    // `updated`'s raw caller-supplied description.
    expect(JSON.stringify(out.new_state)).not.toContain(secret);
    expect(JSON.stringify(r)).not.toContain(secret);
    // Safe-fallback shape: status carried from `updated` (not secret-shaped), description built
    // from the already-scanned persisted line text, tags empty (the re-parse that would have
    // recovered them failed).
    expect(out.new_state.status).toBe("todo");
    expect(out.new_state.description).toContain("[REDACTED]");
  });
});
