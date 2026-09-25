// THE-1125 — TelemetryDocumentSchema is `.strict()`: the acceptance-critical guarantee this repo
// promised (SECURITY.md, THE-1117 owner constraints) is that NOTHING but the declared keys can
// ever reach the network. This file has two halves: (1) the schema's own shape (accepts the
// well-formed document, rejects an extra key), and (2) a hand-rolled property test — no
// fast-check in this repo's devDependencies, so a small seeded PRNG generator stands in for it —
// that feeds hundreds of adversarial tool names / error codes / client names through the REAL
// collector -> document pipeline and asserts the resulting object, re-serialized through
// JSON.stringify, NEVER contains a key outside TELEMETRY_DOCUMENT_KEYS.
import { describe, expect, it } from "vitest";
import { TelemetryCollector } from "../src/telemetry/collector";
import {
  buildTelemetryDocument,
  TELEMETRY_DOCUMENT_KEYS,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryDocumentSchema,
} from "../src/telemetry/document";

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

// Mostly within TelemetryDocumentSchema's own bounds (min 1, max 200 for map keys / 128 for
// client names) — adversarial in CONTENT (paths, SQL, secrets, prototype-pollution-shaped keys),
// which is what a real (bounded-vocabulary) tool/error-code name could never legitimately be but
// a bug elsewhere might still hand the collector. Two entries are deliberately OUT of bounds (an
// empty string, an over-length string) to exercise buildTelemetryDocument's fail-closed path too.
const ADVERSARIAL_STRINGS = [
  "/Users/alice/vault/Private/journal.md",
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
  "", // out of bounds: exercises the fail-closed (empty-key) path
  "a".repeat(500), // out of bounds: exercises the fail-closed (over-length) path
];

describe("telemetry forbidden-fields property test (THE-1125)", () => {
  it("random tool names / error codes / client names flowing through the REAL collector never leak a key outside the closed schema", () => {
    const rand = mulberry32(20260925);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;
    let successCount = 0;
    let failClosedCount = 0;

    for (let trial = 0; trial < 500; trial++) {
      const collector = new TelemetryCollector(() => 1000);
      const toolCallCount = 1 + Math.floor(rand() * 8);
      for (let i = 0; i < toolCallCount; i++) {
        const tool = pick(ADVERSARIAL_STRINGS);
        const hasError = rand() < 0.5;
        collector.recordToolCall(tool, hasError ? pick(ADVERSARIAL_STRINGS) : undefined);
        if (rand() < 0.5) collector.recordClientName(pick(ADVERSARIAL_STRINGS));
      }
      const snap = collector.snapshot(() => 2000);
      // FAIL CLOSED is an acceptable outcome here: buildTelemetryDocument's own contract (see its
      // doc comment) is to THROW rather than send a document it cannot validate — an
      // out-of-bounds key/name from a malformed collector entry (never expected from the real
      // bounded tool/error-code vocabularies, but this generator deliberately includes some) must
      // never produce a document that escapes the closed schema; throwing satisfies that just as
      // well as succeeding with a clean document does. Only a SUCCESSFUL build is checked against
      // the closed key set below — a thrown build sent nothing, so there is nothing to leak.
      let doc: ReturnType<typeof buildTelemetryDocument> | undefined;
      try {
        doc = buildTelemetryDocument({
          installId: "3b9e1a2c-4b1e-4a2f-9c3d-1e2f3a4b5c6d",
          serverVersion: "1.31.3",
          os: "linux",
          arch: "x64",
          facadeMode: pick(["triad", "domain", "flat"] as const),
          clientNames: snap.clientNames,
          toolCalls: snap.toolCalls,
          errorCodes: snap.errorCodes,
          windowStart: snap.windowStart,
          windowEnd: snap.windowEnd,
        });
      } catch {
        failClosedCount++;
        continue; // fail-closed: nothing was built, so nothing could have leaked.
      }
      successCount++;
      // Round-trip through JSON exactly as the sender does before it ever reaches `fetch`.
      const roundTripped = JSON.parse(JSON.stringify(doc));
      const keys = Object.keys(roundTripped);
      for (const k of keys) {
        expect(TELEMETRY_DOCUMENT_KEYS).toContain(k);
      }
      // And the schema itself agrees (belt + suspenders: the closed key set AND strict parsing).
      expect(TelemetryDocumentSchema.safeParse(roundTripped).success).toBe(true);
    }

    // Existence floor: a generator that always throws (or always succeeds) would make one whole
    // branch of this test vacuous — assert BOTH paths actually ran, not just that neither one
    // crashed the loop.
    expect(successCount).toBeGreaterThan(0);
    expect(failClosedCount).toBeGreaterThan(0);
  });
});
