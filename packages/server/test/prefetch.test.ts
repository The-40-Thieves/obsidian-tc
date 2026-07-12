// THE-136 — prewarm cache unit pins. The load-bearing one is TTL enforcement at READ time:
// FlowState-QMD's actual bug was a reader that never inspected the timestamp it stored, so an
// arbitrarily old cache returned as a hit. Also pins signal-hash invalidation (edited note),
// atomicity residue, and malformed-file misses.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type PrewarmEntry,
  prewarmPathFor,
  readPrewarm,
  writePrewarm,
} from "../src/search/prefetch";

const dir = mkdtempSync(join(tmpdir(), "obtc-prewarm-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function entry(over: Partial<PrewarmEntry> = {}): PrewarmEntry {
  return {
    generated_at: 100,
    expires_at: 200,
    signal: "memory/_next-session.md",
    signal_hash: "h1",
    empty: false,
    bundle: { x: 1 },
    ...over,
  };
}

describe("prewarm cache (THE-136)", () => {
  it("roundtrips atomically with no tmp residue", () => {
    const f = prewarmPathFor(dir, "v1");
    writePrewarm(f, entry());
    expect(existsSync(`${f}.tmp`)).toBe(false);
    expect(readPrewarm(f, { nowMs: 150, signalHash: "h1" })?.bundle).toEqual({ x: 1 });
  });

  it("enforces the TTL it stored (the FlowState staleness bug)", () => {
    const f = prewarmPathFor(dir, "v2");
    writePrewarm(f, entry());
    expect(readPrewarm(f, { nowMs: 199, signalHash: "h1" })).not.toBeNull();
    expect(readPrewarm(f, { nowMs: 200, signalHash: "h1" })).toBeNull();
    expect(readPrewarm(f, { nowMs: 10_000, signalHash: "h1" })).toBeNull();
  });

  it("refuses a signal-hash mismatch (edited note invalidates immediately)", () => {
    const f = prewarmPathFor(dir, "v3");
    writePrewarm(f, entry());
    expect(readPrewarm(f, { nowMs: 150, signalHash: "other" })).toBeNull();
  });

  it("missing, malformed, or shape-broken files are a miss", () => {
    expect(readPrewarm(prewarmPathFor(dir, "absent"), { nowMs: 1, signalHash: "h" })).toBeNull();
    const bad = prewarmPathFor(dir, "v4");
    writeFileSync(bad, "{not json");
    expect(readPrewarm(bad, { nowMs: 1, signalHash: "h" })).toBeNull();
    const shapeless = prewarmPathFor(dir, "v5");
    writeFileSync(shapeless, JSON.stringify({ expires_at: 99999, signal_hash: "h" }));
    expect(readPrewarm(shapeless, { nowMs: 1, signalHash: "h" })).toBeNull();
  });

  it("keeps the empty marker readable (the floor entry is a valid entry)", () => {
    const f = prewarmPathFor(dir, "v6");
    writePrewarm(f, entry({ empty: true, bundle: undefined }));
    const e = readPrewarm(f, { nowMs: 150, signalHash: "h1" });
    expect(e?.empty).toBe(true);
    expect(e?.bundle).toBeUndefined();
  });
});
