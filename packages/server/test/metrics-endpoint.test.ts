import { describe, expect, it } from "vitest";
import { createMetricsApp, startMetricsEndpoint } from "../src/metrics/endpoint";
import { MetricsRecorder } from "../src/metrics/registry";

describe("/metrics endpoint (THE-211)", () => {
  it("serves the catalog on a loopback bind with no auth", async () => {
    const app = createMetricsApp({
      recorder: new MetricsRecorder(),
      bind: "127.0.0.1",
      port: 0,
      auth: { mode: "none", tokenTtlSeconds: 86400 },
    });
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("# TYPE obsidian_tc_tool_calls_total counter");
  });

  it("requires a bearer token on a non-loopback bind (jwt mode)", async () => {
    const app = createMetricsApp({
      recorder: new MetricsRecorder(),
      bind: "0.0.0.0",
      port: 0,
      auth: { mode: "jwt", jwtSecret: "x".repeat(32), tokenTtlSeconds: 86400 },
    });
    const res = await app.request("/metrics");
    expect(res.status).toBe(401);
  });

  it("refuses to bind a non-loopback address under auth.mode none (hardcoded floor)", () => {
    expect(() =>
      startMetricsEndpoint({
        recorder: new MetricsRecorder(),
        bind: "0.0.0.0",
        port: 0,
        auth: { mode: "none", tokenTtlSeconds: 86400 },
      }),
    ).toThrow(/non-localhost/);
  });
});

// THE-507 (folding in THE-489), extended THE-588: the ingest events had no telemetry at all — only
// `[ingest]`/`[index]` stderr lines, which are grep-able but not queryable. They are emitted from an
// indexing pass's AGGREGATE stats (one inc per pass carrying the pass's count), not per event, so
// the indexer keeps its property of having zero telemetry-layer references.
//
// NOTE for future additions: this test calls MetricsRecorder's inc* methods directly, which proves
// only that the method and the Prometheus registration work — it does NOT prove the real ingest
// pipeline (indexVault -> IndexStats -> recordIngestStats) actually feeds the counter. That gap is
// exactly how three THE-585 gauges sat registered-but-unfed for releases. Do not use this file's
// pattern as the ONLY test for a new ingest counter — pair it with one that drives a real indexVault
// pass through recordIngestStats (see test/dedup-unresolved.test.ts).
describe("THE-507/THE-588 ingest work counters", () => {
  it("exports all five counters with a bounded `vault` label and no per-path cardinality", async () => {
    const rec = new MetricsRecorder();
    rec.incIngestSecretsSkipped("v1", 3);
    rec.incIngestDedupSkipped("v1", 2);
    rec.incIngestDedupUnresolved("v1", 4);
    rec.incEmbedBatchRejections("v1", 1);
    rec.incIndexWriteFailures("v1", 5);
    const text = await rec.registry.metrics();
    expect(text).toMatch(/obsidian_tc_ingest_secrets_skipped_total\{vault="v1"\} 3/);
    expect(text).toMatch(/obsidian_tc_ingest_dedup_skipped_total\{vault="v1"\} 2/);
    expect(text).toMatch(/obsidian_tc_ingest_dedup_unresolved_total\{vault="v1"\} 4/);
    expect(text).toMatch(/obsidian_tc_embed_batch_rejections_total\{vault="v1"\} 1/);
    expect(text).toMatch(/obsidian_tc_index_write_failures_total\{vault="v1"\} 5/);
    // The audit constraint: bounded labels ONLY — never paths, queries, chunk ids or caller ids.
    // `vault` is the sole label, so cardinality is bounded by the vault count.
    const ingestLines = text
      .split("\n")
      .filter((l) => /^obsidian_tc_(ingest_|embed_batch_|index_write_)/.test(l));
    expect(ingestLines.length).toBeGreaterThan(0);
    for (const l of ingestLines) expect(l).not.toMatch(/path=|query=|chunk=|caller=/);
  });

  it("accumulates across passes rather than overwriting", async () => {
    const rec = new MetricsRecorder();
    rec.incIngestSecretsSkipped("v1", 3);
    rec.incIngestSecretsSkipped("v1", 4);
    expect(await rec.registry.metrics()).toMatch(
      /obsidian_tc_ingest_secrets_skipped_total\{vault="v1"\} 7/,
    );
  });

  it("a clean pass creates no label series at all", async () => {
    // Emitting inc(0) would register a vault series that never moves, which reads on a dashboard as
    // "this vault has a counter" rather than "nothing happened".
    const rec = new MetricsRecorder();
    rec.incIngestSecretsSkipped("quiet-vault", 0);
    expect(await rec.registry.metrics()).not.toMatch(/quiet-vault/);
  });
});
