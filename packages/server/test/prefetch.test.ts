// THE-136 — prewarm cache unit pins. The load-bearing one is TTL enforcement at READ time:
// FlowState-QMD's actual bug was a reader that never inspected the timestamp it stored, so an
// arbitrarily old cache returned as a hit. Also pins signal-hash invalidation (edited note),
// atomicity residue, and malformed-file misses.
// THE-543: adds the ACL-fingerprint and vault-generation halves of the cache key (the security
// fix — see prewarm-acl.test.ts for the end-to-end leak/staleness pins against vault_context).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  callerAclFingerprint,
  type PrewarmEntry,
  prewarmPathFor,
  readPrewarm,
  writePrewarm,
} from "../src/search/prefetch";

const dir = mkdtempSync(join(tmpdir(), "obtc-prewarm-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FP = "fp-test";
function readOpts(
  over: Partial<{
    nowMs: number;
    signalHash: string;
    aclFingerprint: string;
    vaultGeneration: number;
  }> = {},
) {
  return { nowMs: 150, signalHash: "h1", aclFingerprint: FP, vaultGeneration: 0, ...over };
}

function entry(over: Partial<PrewarmEntry> = {}): PrewarmEntry {
  return {
    generated_at: 100,
    expires_at: 200,
    signal: "memory/_next-session.md",
    signal_hash: "h1",
    empty: false,
    bundle: { x: 1 },
    acl_fingerprint: FP,
    vault_generation: 0,
    ...over,
  };
}

describe("prewarm cache (THE-136)", () => {
  it("roundtrips atomically with no tmp residue", () => {
    const f = prewarmPathFor(dir, "v1", FP);
    writePrewarm(f, entry());
    expect(existsSync(`${f}.tmp`)).toBe(false);
    expect(readPrewarm(f, readOpts())?.bundle).toEqual({ x: 1 });
  });

  it("enforces the TTL it stored (the FlowState staleness bug)", () => {
    const f = prewarmPathFor(dir, "v2", FP);
    writePrewarm(f, entry());
    expect(readPrewarm(f, readOpts({ nowMs: 199 }))).not.toBeNull();
    expect(readPrewarm(f, readOpts({ nowMs: 200 }))).toBeNull();
    expect(readPrewarm(f, readOpts({ nowMs: 10_000 }))).toBeNull();
  });

  it("refuses a signal-hash mismatch (edited note invalidates immediately)", () => {
    const f = prewarmPathFor(dir, "v3", FP);
    writePrewarm(f, entry());
    expect(readPrewarm(f, readOpts({ signalHash: "other" }))).toBeNull();
  });

  it("missing, malformed, or shape-broken files are a miss", () => {
    expect(readPrewarm(prewarmPathFor(dir, "absent", FP), readOpts())).toBeNull();
    const bad = prewarmPathFor(dir, "v4", FP);
    writeFileSync(bad, "{not json");
    expect(readPrewarm(bad, readOpts())).toBeNull();
    const shapeless = prewarmPathFor(dir, "v5", FP);
    writeFileSync(shapeless, JSON.stringify({ expires_at: 99999, signal_hash: "h1" }));
    expect(readPrewarm(shapeless, readOpts())).toBeNull();
  });

  it("keeps the empty marker readable (the floor entry is a valid entry)", () => {
    const f = prewarmPathFor(dir, "v6", FP);
    writePrewarm(f, entry({ empty: true, bundle: undefined }));
    const e = readPrewarm(f, readOpts());
    expect(e?.empty).toBe(true);
    expect(e?.bundle).toBeUndefined();
  });

  it("THE-543: refuses an ACL-fingerprint mismatch (a different caller's cache key)", () => {
    const f = prewarmPathFor(dir, "v7", FP);
    writePrewarm(f, entry());
    expect(readPrewarm(f, readOpts({ aclFingerprint: "other-fp" }))).toBeNull();
  });

  it("THE-543: refuses a vault-generation mismatch (content moved since the write)", () => {
    const f = prewarmPathFor(dir, "v8", FP);
    writePrewarm(f, entry({ vault_generation: 3 }));
    expect(readPrewarm(f, readOpts({ vaultGeneration: 3 }))).not.toBeNull();
    expect(readPrewarm(f, readOpts({ vaultGeneration: 4 }))).toBeNull();
  });

  it("THE-543: a pre-fix entry with no acl_fingerprint/vault_generation is always a miss", () => {
    const f = prewarmPathFor(dir, "v9", FP);
    // Simulates an entry written before THE-543 (old-format file on disk): no fingerprint,
    // no generation field at all — never trusted, regardless of what the reader asks for.
    writeFileSync(
      f,
      JSON.stringify({
        generated_at: 100,
        expires_at: 999_999_999_999,
        signal: "memory/_next-session.md",
        signal_hash: "h1",
        empty: false,
        bundle: { x: 1 },
      }),
    );
    expect(readPrewarm(f, readOpts())).toBeNull();
  });

  it("THE-543: callerAclFingerprint is a stable sentinel for an unbound (no-ACL) caller", () => {
    const noAcl = callerAclFingerprint(undefined, ["read:notes"]);
    expect(noAcl).toBe(callerAclFingerprint(undefined, ["write:notes"]));
    const withAcl = callerAclFingerprint(
      { fingerprint: (scopes) => `fp:${[...scopes].sort().join(",")}` },
      ["read:notes"],
    );
    expect(withAcl).toBe("fp:read:notes");
    expect(withAcl).not.toBe(noAcl);
  });
});
