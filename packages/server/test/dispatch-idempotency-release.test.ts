// THE-667: the two silent catches in dispatch.ts that survived triage.
//
// Most of the 67 strictly-inert catch blocks in packages/server/src are correct by construction —
// telemetry sinks carrying an explicit "must never break dispatch" comment, which fail condition 3
// of the danger filter (the caller does not proceed as if a load-bearing operation succeeded; only
// telemetry is lost). These two are different, and were commented only `/* best-effort */`:
//
//   1. persistent failure mode      — a DELETE that fails on disk I/O or schema drift keeps failing
//   2. nothing downstream reveals it — the catch was the whole story; no log, no counter, no channel
//   3. the caller proceeds as if it succeeded — and this is the sharp one. Both sites sit on a
//      REJECTION path that releases the idempotency claim so the caller's retry can re-take it, and
//      both rejections explicitly invite that retry (`retry_after_seconds`, `elicit_required`).
//      An orphaned claim is neither expired (idempotencyTtlSeconds, default 24h) nor yet
//      reclaimable (idempotencyReclaimSeconds, default 60s), so claimOrReplay falls through to
//      `in_flight` and the invited retry returns idempotency_in_flight instead.
//
// The fix does NOT change behaviour: the release stays best-effort, because replacing a `throttled`
// or `elicit_required` error with a cleanup error would be strictly worse. It only gives the
// failure the channel it never had — `deps.observability.meter`, which dispatch already uses for
// exactly this shape (incAuditWriteFailed). No third mechanism.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { MetricsRecorder } from "../src/metrics/registry";
import { RateLimiter } from "../src/throttle";

/** A db whose idempotency DELETE fails and whose every other statement succeeds — so the claim IS
 *  taken and only the RELEASE breaks. A blanket-throwing db would fail the claim instead and never
 *  reach the code under test. */
function dbWithFailingRelease(): { db: Database; deleteAttempts: () => number } {
  let attempts = 0;
  const db = {
    prepare: (sql: string) => ({
      run: () => {
        if (/DELETE\s+FROM\s+idempotency_keys/i.test(sql)) {
          attempts++;
          throw new Error("disk I/O error");
        }
        return undefined;
      },
      get: () => undefined,
      all: () => [],
    }),
  } as unknown as Database;
  return { db, deleteAttempts: () => attempts };
}

const tool = (name: string, requiredScopes: string[]) => ({
  name,
  description: "",
  // idempotency_key must be accepted by the schema or extractIdempotencyKey never sees it.
  inputSchema: z.object({ idempotency_key: z.string().optional() }).strict(),
  requiredScopes,
  handler: () => ({ ok: 1 }),
});

/** The counter's value for a label set, read back out of the Prometheus exposition — not a spy.
 *  A registered metric is not an emitting metric; the assertion has to reach the text. */
async function releaseFailures(m: MetricsRecorder, gate: string): Promise<number> {
  const text = await m.metrics();
  const row = text
    .split("\n")
    .find(
      (l) =>
        l.startsWith("obsidian_tc_idempotency_release_failed_total{") && l.includes(`"${gate}"`),
    );
  return row === undefined ? 0 : Number(row.trim().split(/\s+/).pop());
}

describe("THE-667: a failed idempotency-claim release is no longer silent", () => {
  it("throttle gate — counts the failure, and still throws `throttled`, not the cleanup error", async () => {
    const metrics = new MetricsRecorder();
    const { db, deleteAttempts } = dbWithFailingRelease();
    const r = new ToolRegistry({
      rateLimiter: new RateLimiter(),
      verifyElicit: () => true,
      metrics,
    });
    r.register(tool("exec", ["execute:shell"]));
    const now = () => 0; // frozen clock -> no refill, so call 2 is throttled
    const ctx = (): CallerContext => ({
      caller: "c",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "main",
      db,
      now,
      elicitToken: "tok",
    });

    // execute tier burst is 1: the first call clears, the second is throttled.
    expect((await r.dispatch("exec", { idempotency_key: "k1" }, ctx())).ok).toBe(true);
    const res = await r.dispatch("exec", { idempotency_key: "k2" }, ctx());

    expect(res.ok).toBe(false);
    // The rejection the caller must see is preserved — the cleanup failure never replaces it.
    expect(JSON.stringify(res)).toMatch(/throttled|rate limit/i);
    expect(JSON.stringify(res)).not.toMatch(/disk I\/O error/);
    expect(deleteAttempts()).toBeGreaterThan(0);
    expect(await releaseFailures(metrics, "throttle")).toBe(1);
  });

  it("labels the gate, so the counter can name WHICH rejection path is failing", async () => {
    const metrics = new MetricsRecorder();
    const { db } = dbWithFailingRelease();
    const r = new ToolRegistry({
      rateLimiter: new RateLimiter(),
      // HITL is NOT satisfied -> the elicit gate rejects and releases the claim.
      verifyElicit: () => false,
      metrics,
    });
    r.register(tool("bulk_create_notes", ["write:notes", "bulk:notes"]));
    const ctx = (): CallerContext => ({
      caller: "c2",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "main",
      db,
      now: () => 0,
      elicitToken: "tok",
    });

    const res = await r.dispatch("bulk_create_notes", { idempotency_key: "h1" }, ctx());

    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/elicit|confirmation/i);
    expect(JSON.stringify(res)).not.toMatch(/disk I\/O error/);
    expect(await releaseFailures(metrics, "hitl")).toBe(1);
    // The two gates are distinguishable — a counter that merges them cannot point at the failure.
    expect(await releaseFailures(metrics, "throttle")).toBe(0);
  });

  it("stays silent when the release SUCCEEDS — the counter means something", async () => {
    const metrics = new MetricsRecorder();
    // Every statement succeeds, including the DELETE.
    const db = {
      prepare: () => ({ run: () => undefined, get: () => undefined, all: () => [] }),
    } as unknown as Database;
    const r = new ToolRegistry({
      rateLimiter: new RateLimiter(),
      verifyElicit: () => true,
      metrics,
    });
    r.register(tool("exec", ["execute:shell"]));
    const ctx = (): CallerContext => ({
      caller: "c3",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "main",
      db,
      now: () => 0,
      elicitToken: "tok",
    });

    expect((await r.dispatch("exec", { idempotency_key: "s1" }, ctx())).ok).toBe(true);
    expect((await r.dispatch("exec", { idempotency_key: "s2" }, ctx())).ok).toBe(false);

    expect(await releaseFailures(metrics, "throttle")).toBe(0);
  });
});
