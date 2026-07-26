// THE-590: the MCP index_vault tool path never called recordIngestStats -- only cli.ts's
// add_vault handler and the boot reconcile did, both of which are DIFFERENT surfaces from the one
// an agent actually drives. So agent-triggered indexing (the normal production path) emitted zero
// ingest telemetry: no Prometheus counters, no event_log row.
//
// This test dispatches index_vault THROUGH THE REGISTRY (registry.dispatch, the real MCP entry
// point) with onIndexVaultComplete wired the same way cli.ts's run_serve wires it -- straight to
// recordIngestStats -- and asserts the counter's VALUE lands in the Prometheus exposition plus a
// real event_log row. Asserting only via a direct recordIngestStats() call (as
// metrics-endpoint.test.ts and dedup-unresolved.test.ts's THE-588 case do) would pass today for
// the wrong reason: it proves the function works, not that the index_vault path reaches it.
import { describe, expect, it } from "vitest";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { recordIngestStats } from "../src/metrics/ingest-stats";
import { MetricsRecorder } from "../src/metrics/registry";
import { makeM2Vault } from "./m2-helpers";

describe("THE-590 index_vault (MCP path) feeds ingest telemetry", () => {
  it("a registry-dispatched index_vault call writes the Prometheus counter and an event_log row", async () => {
    const metrics = new MetricsRecorder();
    const body = "# H\n\nthe exact same paragraph of content appears in both notes verbatim";
    const v = makeM2Vault({
      files: { "a.md": body, "b.md": body },
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      onIndexVaultComplete: (vaultId, stats) => recordIngestStats(v.db, metrics, vaultId, stats),
    });

    const res = await v.call("index_vault", { vault: v.id });
    expect(res.ok).toBe(true);
    const d = (res.ok ? res.data : {}) as Record<string, number>;
    expect(d.chunks_dedup_reused).toBeGreaterThan(0);

    // Prometheus exposition carries the real value from THIS dispatch, not a hand-fed one.
    const text = await metrics.metrics();
    expect(text).toMatch(
      new RegExp(
        `obsidian_tc_ingest_dedup_skipped_total\\{vault="${v.id}"\\} ${d.chunks_dedup_reused}`,
      ),
    );

    // The event_log sink (get_metrics' durable surface) got a row too.
    const row = v.db
      .prepare("SELECT result_size FROM event_log WHERE event_type = 'ingest_dedup_skipped'")
      .get() as { result_size: number } | undefined;
    expect(row?.result_size).toBe(d.chunks_dedup_reused);

    v.cleanup();
  });
});
