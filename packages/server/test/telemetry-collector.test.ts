// THE-1125 — TelemetryCollector: the in-process counter set fed from MetricsRecorder's ONE
// observeToolCall hook (see registry.ts's ToolCallObserver comment).
//
// Security review (grok HIGH-1 + in-pool HIGH-A, 2026-09-25): `recordToolCall`/`recordClientName`
// used to store the caller-supplied string VERBATIM with no allowlist and no cap on the
// tool/error maps — a hostile tool name (e.g. a vault path) landed directly in the document. Every
// test below that names "known"/"unknown" is asserting the FIX: nothing but a registered tool
// name, a real ErrorCode, or a canonical client label can ever become a document key.
import { describe, expect, it } from "vitest";
import {
  canonicalizeClientName,
  OTHER_CLIENT_LABEL,
  TelemetryCollector,
  UNKNOWN_ERROR_CODE,
  UNKNOWN_TOOL_NAME,
} from "../src/telemetry/collector";

const knownTools = () => new Set(["search_text", "read_note", "write_note"]);

describe("TelemetryCollector — tool-name allowlist", () => {
  it("counts a REGISTERED tool call under its own name", () => {
    const c = new TelemetryCollector(knownTools, () => 0);
    c.recordToolCall("search_text");
    c.recordToolCall("search_text");
    c.recordToolCall("read_note");
    expect(c.snapshot().toolCalls).toEqual({ search_text: 2, read_note: 1 });
  });

  it("buckets an UNREGISTERED tool name into UNKNOWN_TOOL_NAME — never the caller's string", () => {
    const c = new TelemetryCollector(knownTools, () => 0);
    c.recordToolCall("/Users/alice/vault/Private/journal.md");
    c.recordToolCall("some_other_unregistered_tool");
    const snap = c.snapshot();
    expect(snap.toolCalls).toEqual({ [UNKNOWN_TOOL_NAME]: 2 });
    expect(Object.keys(snap.toolCalls)).not.toContain("/Users/alice/vault/Private/journal.md");
  });

  it("reads the known-name set LIVE, not once at construction (the registry finishes after telemetry is built)", () => {
    const known = new Set(["search_text"]);
    const c = new TelemetryCollector(
      () => known,
      () => 0,
    );
    c.recordToolCall("read_note"); // not yet known -> unknown
    known.add("read_note"); // registry finishes registering
    c.recordToolCall("read_note"); // now known
    expect(c.snapshot().toolCalls).toEqual({ [UNKNOWN_TOOL_NAME]: 1, read_note: 1 });
  });

  it("defaults to an always-empty known-name set (safe for a caller with no live registry)", () => {
    const c = new TelemetryCollector();
    c.recordToolCall("search_text");
    expect(c.snapshot().toolCalls).toEqual({ [UNKNOWN_TOOL_NAME]: 1 });
  });
});

describe("TelemetryCollector — error-code allowlist", () => {
  it("counts a REAL ErrorCode under its own name", () => {
    const c = new TelemetryCollector(knownTools, () => 0);
    c.recordToolCall("write_note", "acl_denied");
    c.recordToolCall("write_note", "acl_denied");
    expect(c.snapshot().errorCodes).toEqual({ acl_denied: 2 });
  });

  it("buckets a non-taxonomy string into UNKNOWN_ERROR_CODE", () => {
    const c = new TelemetryCollector(knownTools, () => 0);
    c.recordToolCall("write_note", "not_a_real_code");
    c.recordToolCall("write_note", "https://evil.example/steal?token=abc");
    expect(c.snapshot().errorCodes).toEqual({ [UNKNOWN_ERROR_CODE]: 2 });
  });

  it("an ok call (no errorCode) never touches errorCodes at all", () => {
    const c = new TelemetryCollector(knownTools, () => 0);
    c.recordToolCall("search_text");
    expect(c.snapshot().errorCodes).toEqual({});
  });
});

describe("canonicalizeClientName", () => {
  const table: ReadonlyArray<readonly [string, string]> = [
    ["claude-code", "domain"],
    ["cursor", "triad"],
  ];

  it("matches a known substring, case-insensitively, and returns the CANONICAL label", () => {
    expect(canonicalizeClientName("Claude-Code-CLI", table)).toBe("claude-code");
    expect(canonicalizeClientName("my-cursor-fork", table)).toBe("cursor");
  });

  it("returns OTHER_CLIENT_LABEL for anything unmatched — never the raw string", () => {
    expect(canonicalizeClientName("https://evil.example/?vault=/Users/alice", table)).toBe(
      OTHER_CLIENT_LABEL,
    );
    expect(canonicalizeClientName("some-random-client", table)).toBe(OTHER_CLIENT_LABEL);
  });
});

describe("TelemetryCollector — client-name canonicalization + cap", () => {
  const table: ReadonlyArray<readonly [string, string]> = [
    ["claude-code", "domain"],
    ["cursor", "triad"],
  ];

  it("stores the CANONICAL label, not the raw client-supplied string", () => {
    const c = new TelemetryCollector(knownTools, () => 0);
    c.recordClientName("claude-code-desktop-v2", table);
    expect(c.snapshot().clientNames).toEqual(["claude-code"]);
  });

  it("an unmatched client name canonicalizes to OTHER_CLIENT_LABEL, including a URL-shaped one", () => {
    const c = new TelemetryCollector(knownTools, () => 0);
    c.recordClientName("https://evil.example/?vault=/Users/alice", table);
    expect(c.snapshot().clientNames).toEqual([OTHER_CLIENT_LABEL]);
  });

  it("caps distinct canonical labels at 32 (defensive — the table itself is small)", () => {
    const c = new TelemetryCollector(knownTools, () => 0);
    // Only two canonical outcomes exist for this table (claude-code, cursor, or other) — this
    // proves the cap does not spuriously drop the SMALL, expected label set.
    for (let i = 0; i < 50; i++) c.recordClientName(`claude-code-${i}`, table);
    for (let i = 0; i < 50; i++) c.recordClientName(`cursor-${i}`, table);
    expect([...c.snapshot().clientNames].sort()).toEqual(["claude-code", "cursor"]);
  });

  it("recordClientName(undefined) is a no-op (the ok/no-clientInfo case)", () => {
    const c = new TelemetryCollector(knownTools, () => 0);
    c.recordClientName(undefined, table);
    expect(c.snapshot().clientNames).toEqual([]);
  });
});

describe("TelemetryCollector — window lifecycle", () => {
  it("snapshot does not clear counters — a preview can be read repeatedly", () => {
    const c = new TelemetryCollector(knownTools, () => 0);
    c.recordToolCall("search_text");
    c.snapshot();
    expect(c.snapshot().toolCalls).toEqual({ search_text: 1 });
  });

  it("reset clears every counter and opens a new window", () => {
    const c = new TelemetryCollector(knownTools, () => 1000);
    c.recordToolCall("write_note", "throttled");
    c.recordClientName("claude-code", [["claude-code", "domain"]]);
    c.reset(() => 2000);
    const snap = c.snapshot(() => 3000);
    expect(snap.toolCalls).toEqual({});
    expect(snap.errorCodes).toEqual({});
    expect(snap.clientNames).toEqual([]);
    expect(snap.windowStart).toBe(2000);
    expect(snap.windowEnd).toBe(3000);
  });

  it("windowStart is set at construction and tracked across a window", () => {
    const c = new TelemetryCollector(knownTools, () => 500);
    expect(c.snapshot(() => 900).windowStart).toBe(500);
    expect(c.snapshot(() => 900).windowEnd).toBe(900);
  });
});
