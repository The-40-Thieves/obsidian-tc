// THE-1125 — TelemetryDocumentSchema is `.strict()`: the acceptance-critical guarantee this repo
// promised (SECURITY.md, THE-1117 owner constraints) is that NOTHING but the declared keys can
// ever reach the network. This file has two halves: (1) the schema's own shape (accepts the
// well-formed document, rejects an extra key), and (2) a property test that feeds adversarial tool
// names through the REAL `ToolRegistry.dispatch` path — no fast-check in this repo's
// devDependencies, so a small seeded PRNG generator stands in for it.
//
// Security review (grok HIGH-1, 2026-09-25): the ORIGINAL version of this test called
// `collector.recordToolCall(...)` directly, so it only ever asserted the collector's OWN
// behavior — it could not have caught the actual bug, which was that `dispatch.ts` handed the
// collector a caller-supplied string it never validated at all (an unknown `tools/call` name
// throws `not_found`, and `observeToolCall(..., name, ...)` still records that same name). This
// version dispatches through a real `ToolRegistry` instead, the exact code path an adversarial
// `tools/call`/`call_capability` invocation takes, and additionally scans the WHOLE serialized
// document (not just top-level keys) for path/URL-shaped substrings.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database } from "../src/db/types";
import type { CallerContext } from "../src/mcp/registry";
import { ToolRegistry } from "../src/mcp/registry";
import { MetricsRecorder } from "../src/metrics/registry";
import {
  buildTelemetryDocument,
  TELEMETRY_DOCUMENT_KEYS,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryDocumentSchema,
} from "../src/telemetry/document";
import { wireTelemetry } from "../src/telemetry/wiring";

function validDoc() {
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    installId: "3b9e1a2c-4b1e-4a2f-9c3d-1e2f3a4b5c6d",
    serverVersion: "1.31.3",
    os: "linux",
    arch: "x64",
    facadeMode: "triad" as const,
    clientNames: ["claude-code"],
    toolCalls: { search_text: 3 },
    errorCodes: { acl_denied: 1 },
    windowStart: 1000,
    windowEnd: 2000,
  };
}

describe("TelemetryDocumentSchema", () => {
  it("accepts a well-formed document", () => {
    expect(TelemetryDocumentSchema.safeParse(validDoc()).success).toBe(true);
  });

  it("rejects ANY extra key — .strict(), not .safeParse()-and-strip", () => {
    const withExtra = { ...validDoc(), vaultId: "leak" };
    const r = TelemetryDocumentSchema.safeParse(withExtra);
    expect(r.success).toBe(false);
  });

  it.each([
    "path",
    "notePath",
    "content",
    "query",
    "vaultId",
    "principal",
    "caller",
    "token",
    "apiKey",
    "hostname",
    "env",
  ])("rejects a document carrying a forbidden-looking key: %s", (key) => {
    const r = TelemetryDocumentSchema.safeParse({ ...validDoc(), [key]: "x" });
    expect(r.success).toBe(false);
  });

  it("rejects a wrong schema literal", () => {
    const r = TelemetryDocumentSchema.safeParse({
      ...validDoc(),
      schema: "obsidian-tc.telemetry/2",
    });
    expect(r.success).toBe(false);
  });

  it("caps clientNames at 32 in buildTelemetryDocument (over-cap input is truncated, not rejected)", () => {
    const names = Array.from({ length: 50 }, (_, i) => `client-${i}`);
    const doc = buildTelemetryDocument({ ...validDoc(), clientNames: names });
    expect(doc.clientNames.length).toBe(32);
  });

  it("buildTelemetryDocument throws (never returns a partial document) on an invalid installId", () => {
    expect(() => buildTelemetryDocument({ ...validDoc(), installId: "not-a-uuid" })).toThrow();
  });
});

// Deterministic, seeded PRNG — no external dependency, reproducible across CI runs.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Path/URL-shaped and otherwise-sensitive adversarial strings — what a hostile `tools/call`
// might name a nonexistent tool, or what a client might declare as its own `clientInfo.name`.
// Deliberately includes forward slashes, backslashes, "://", and prototype-pollution-shaped keys.
const ADVERSARIAL_STRINGS = [
  "/Users/alice/vault/Private/journal.md",
  "C:\\Users\\alice\\vault\\Private\\journal.md",
  "https://evil.example/steal?token=abc123",
  "file:///etc/passwd",
  "SELECT * FROM chunk_retrievals WHERE caller = 'bob'",
  "vault-id-abc123",
  "sk-live-abcdef1234567890",
  "Bearer eyJhbGciOiJIUzI1NiJ9.token",
  "192.168.1.42",
  "principal:alice@example.com",
  "__proto__",
  "constructor",
  "toolCalls",
  "errorCodes",
  "schema",
  "a".repeat(300),
];

const REGISTERED_TOOL_NAMES = ["search_text", "read_note", "write_note"];

const fakeDb = {
  prepare: () => ({ run: () => undefined, get: () => undefined, all: () => [] }),
} as unknown as Database;

function ctx(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "main",
    db: fakeDb,
    ...overrides,
  };
}

const tool = (name: string) => ({
  name,
  description: "",
  inputSchema: z.object({}).strict(),
  requiredScopes: [] as string[],
  handler: () => ({ ok: true }),
});

describe("telemetry property test — fed through the REAL ToolRegistry.dispatch path (THE-1125)", () => {
  it("random tool names and client names, dispatched for real, never leak a path/URL/raw-string key at any depth", async () => {
    const rand = mulberry32(20260925);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;

    const config = {
      telemetry: { enabled: false, intervalMinutes: 60 },
      toolFacade: { mode: "triad" },
    } as unknown as Parameters<typeof wireTelemetry>[0]["config"];
    const telemetry = wireTelemetry({
      config,
      db: fakeDb,
      serverVersion: "test",
      getKnownToolNames: () => new Set(REGISTERED_TOOL_NAMES),
    });
    const metrics = new MetricsRecorder({}, telemetry.observer);
    const registry = new ToolRegistry({ metrics });
    for (const name of REGISTERED_TOOL_NAMES) registry.register(tool(name));

    let registeredCalls = 0;
    let unregisteredCalls = 0;

    for (let trial = 0; trial < 300; trial++) {
      const useRegistered = rand() < 0.3;
      const name = useRegistered ? pick(REGISTERED_TOOL_NAMES) : pick(ADVERSARIAL_STRINGS);
      if (useRegistered) registeredCalls++;
      else unregisteredCalls++;
      const clientName = rand() < 0.4 ? pick(ADVERSARIAL_STRINGS) : undefined;
      // `reg.dispatch` is the REAL dispatch path (mcp/registry.ts -> registry/dispatch.ts):
      // an unregistered name throws `not_found` internally and is still recorded via
      // `observeToolCall`, exactly the sequence grok's HIGH-1 finding named.
      await registry.dispatch(
        name,
        {},
        ctx({ clientInfo: clientName ? { name: clientName } : undefined }),
      );
    }

    // Existence floor: both branches of the generator actually ran.
    expect(registeredCalls).toBeGreaterThan(0);
    expect(unregisteredCalls).toBeGreaterThan(0);

    const doc = telemetry.previewDocument();
    const serialized = JSON.stringify(doc);

    // Top-level closed-key-set check (belt + suspenders — the schema itself already enforces it).
    for (const k of Object.keys(doc)) expect(TELEMETRY_DOCUMENT_KEYS).toContain(k);
    expect(TelemetryDocumentSchema.safeParse(JSON.parse(serialized)).success).toBe(true);

    // ANY-DEPTH check, scoped to the CALLER-INFLUENCED VALUES only — the MAP KEYS of
    // toolCalls/errorCodes and the ELEMENTS of clientNames, joined as a flat string, never this
    // test's own wrapper structure (which would otherwise false-positive on the literal strings
    // "toolCalls"/"errorCodes" appearing as JSON keys, and `doc.schema` legitimately contains a
    // "/" in its version literal). Must never contain a path separator, a "scheme://" marker, or
    // any of the adversarial strings verbatim.
    const callerInfluenced = [
      ...Object.keys(doc.toolCalls),
      ...Object.keys(doc.errorCodes),
      ...doc.clientNames,
    ].join("\u0000");
    expect(callerInfluenced).not.toMatch(/\//);
    expect(callerInfluenced).not.toMatch(/\\\\/);
    expect(callerInfluenced).not.toContain("://");
    for (const s of ADVERSARIAL_STRINGS) {
      if (s.length === 0) continue;
      expect(callerInfluenced).not.toContain(s);
    }

    // Positive control: a REGISTERED tool's own name DOES appear (proves the allowlist did not
    // just blank everything — only unregistered/adversarial input is bucketed away).
    expect(Object.keys(doc.toolCalls).some((k) => REGISTERED_TOOL_NAMES.includes(k))).toBe(true);
    // And every unregistered call collapsed into the single "unknown" bucket, never its own key.
    expect(doc.toolCalls.unknown).toBeGreaterThan(0);
  });
});
