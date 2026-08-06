// THE-466 slice 2: run_serve's observability wiring (MetricsRecorder, its gauge sources,
// onVecFallback/onStageMetric/sqlHooksFor, the MORGIANA emitter) moved out of cli.ts into
// runtime/observability.ts. Before this extraction the ONLY construction site for the
// indexCoordinator/scheduler/httpConstructSeconds gauge sources was buried inside run_serve's
// 1000+ line boot function — no test could reach it, which is exactly how THE-585 found three
// gauges that were declared in GaugeSources, registered a `# TYPE` line, and emitted no series
// at all for many releases (see metrics-gauge-sources.test.ts).
//
// These tests drive REAL IndexCoordinator/Scheduler instances (the same classes run_serve
// constructs) through createObservability and assert the resulting values reach the Prometheus
// TEXT EXPOSITION — not just a shim/recorder-method assertion, which is the assertion shape that
// let the three THE-585 gauges go dark in the first place.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { createObservability, wireActivationRecompute } from "../src/runtime/observability";
import { Scheduler } from "../src/scheduler/scheduler";
import { IndexCoordinator } from "../src/search/index-coordinator";
import { createRetrievalCaches } from "../src/search/query_cache";
import { openMemoryDb } from "./helpers";

const readMigration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");

/** Same minimal experiential chain activation.test.ts uses: chunk_retrievals + vault_object_state. */
function experientialDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [
    { version: "20260626_001", sql: readMigration("20260626_001_experiential_init.sql") },
    { version: "20260711_001", sql: readMigration("20260711_001_experiential_outcome.sql") },
  ]);
  return db;
}

async function seededDb(): Promise<Database> {
  const raw = openMemoryDb();
  const db: Database = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
  };
  await provisionCacheDb(db);
  return db;
}

function baseDeps(db: Database) {
  return {
    db,
    cacheDir: "/tmp/the466s2-observability-test",
    morgianaSpool: false,
    retrievalCaches: createRetrievalCaches({ maxEntries: 10, ttlMs: 60_000 }),
    getIndexCoordinatorStats: () =>
      new IndexCoordinator({ write: () => {}, delete: () => {} }).stats(),
    getSchedulerStats: () => new Scheduler().stats(),
    getHttpConstructSeconds: () => null,
  };
}

describe("THE-466 slice 2: createObservability wires a real IndexCoordinator to the exposition", () => {
  it("indexCoalesced/indexQueueDepth reflect a REAL coordinator's live depth, not a snapshot", async () => {
    const db = await seededDb();
    // A handler that never resolves within this test, so the op stays queued (not yet drained) —
    // deterministic without fake timers, since enqueue() updates `chain`/`coalesced` synchronously
    // before the drain's `.then()` callback ever gets a microtask turn.
    const coordinator = new IndexCoordinator({
      write: () => new Promise<void>(() => {}),
      delete: () => new Promise<void>(() => {}),
    });
    const observability = createObservability({
      ...baseDeps(db),
      getIndexCoordinatorStats: () => coordinator.stats(),
    });

    // Two writes to the SAME (vault, path) before the first has a chance to drain: the second
    // COALESCES the first (THE-585 #2), and the key stays queued (THE-585 #1) until it drains.
    coordinator.submitWrite("main", "note.md", "v1");
    coordinator.submitWrite("main", "note.md", "v2");
    expect(coordinator.stats()).toMatchObject({ queued: 1, coalesced: 1 });

    const text = await observability.metrics.metrics();
    expect(text).toContain('obsidian_tc_index_queue_depth{vault="coordinator"} 1');
    expect(text).toContain('obsidian_tc_index_coalesced_total{vault="coordinator"} 1');
  });

  it("indexActive reports a REAL in-flight drain, per vault", async () => {
    const db = await seededDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const coordinator = new IndexCoordinator({
      write: async () => {
        await gate;
      },
      delete: () => {},
    });
    const observability = createObservability({
      ...baseDeps(db),
      getIndexCoordinatorStats: () => coordinator.stats(),
    });

    coordinator.submitWrite("main", "note.md", "v1");
    // Let the drain's chained `.then()` run, acquire its (uncontended) per-vault and global
    // semaphore permits, and reach the awaited gate — each `await` is its own microtask hop.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(coordinator.stats().perVaultActive).toEqual({ main: 1 });

    const text = await observability.metrics.metrics();
    expect(text).toContain('obsidian_tc_index_active{vault="main"} 1');

    release();
    await coordinator.idle();
  });
});

describe("THE-466 slice 2: createObservability wires a real Scheduler to the exposition", () => {
  it("schedulerSkipped reports a REAL single-flight skip, by job name", async () => {
    const db = await seededDb();
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const scheduler = new Scheduler();
      scheduler.register({
        name: "hang",
        intervalMs: 1000,
        run: async () => {
          await gate;
        },
      });
      const observability = createObservability({
        ...baseDeps(db),
        getSchedulerStats: () => scheduler.stats(),
      });
      scheduler.start();
      // tick@1000 starts the (never-settling) run; tick@2000 finds it still in flight -> skipped.
      await vi.advanceTimersByTimeAsync(2500);
      expect(scheduler.stats()).toContainEqual(
        expect.objectContaining({ job: "hang", skipped: 1 }),
      );

      const text = await observability.metrics.metrics();
      expect(text).toContain('obsidian_tc_scheduler_skipped_total{vault="hang"} 1');

      release();
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("THE-466 slice 2: httpConstructSeconds keeps its stdio-only no-series behaviour", () => {
  it("emits nothing when the accessor reports null (never measured)", async () => {
    const db = await seededDb();
    const observability = createObservability({
      ...baseDeps(db),
      getHttpConstructSeconds: () => null,
    });
    const text = await observability.metrics.metrics();
    expect(text).toContain("# TYPE obsidian_tc_http_construct_seconds gauge");
    expect(text).not.toMatch(/^obsidian_tc_http_construct_seconds\{/m);
  });

  it("emits the one boot-time sample once the accessor reports it", async () => {
    const db = await seededDb();
    const observability = createObservability({
      ...baseDeps(db),
      getHttpConstructSeconds: () => 0.0231,
    });
    const text = await observability.metrics.metrics();
    expect(text).toContain('obsidian_tc_http_construct_seconds{vault="http"} 0.0231');
  });
});

describe("THE-603: onSnapshotSkipped makes the snapshot no-op legible", () => {
  it("writes a best-effort skipped event_log row, keyed by vault and tool", async () => {
    const db = await seededDb();
    const observability = createObservability(baseDeps(db));

    observability.onSnapshotSkipped("main", "note.md", "patch_note");

    const rows = db
      .prepare("SELECT vault_id, tool_name, status, error_code, event_type FROM event_log")
      .all();
    expect(rows).toEqual([
      {
        vault_id: "main",
        tool_name: "patch_note",
        status: "skipped",
        error_code: "snapshots_disabled",
        event_type: "snapshot_skipped",
      },
    ]);
  });
});

describe("THE-466 slice 2: the metric-emitting seams route to the SAME recorder", () => {
  it("onVecFallback/onStageMetric/sqlHooksFor observe on the recorder createObservability returned", async () => {
    const db = await seededDb();
    const observability = createObservability(baseDeps(db));

    observability.onVecFallback("main", "underfill");
    observability.onStageMetric("main", {
      stage: "diversity",
      candidatesIn: 10,
      candidatesOut: 3,
      durationMs: 12.5,
    });
    const hooks = observability.sqlHooksFor("main");
    hooks.onLockWait?.("index_note", 0.002);
    hooks.onBusy?.("index_note", "busy");

    const text = await observability.metrics.metrics();
    expect(text).toContain('obsidian_tc_vec_fallback_total{vault="main",reason="underfill"} 1');
    expect(text).toContain(
      'obsidian_tc_retrieval_stage_candidates_in_total{vault="main",stage="diversity"} 10',
    );
    expect(text).toContain(
      'obsidian_tc_sql_busy_total{vault="main",txn="index_note",reason="busy"} 1',
    );
  });
});

describe("onRerankOutcome reaches the exposition", () => {
  it("routes a rerank decision to the recorder, by vault and outcome", async () => {
    const db = await seededDb();
    const observability = createObservability(baseDeps(db));

    observability.onRerankOutcome("main", "not_configured");
    observability.onRerankOutcome("main", "executed");

    const text = await observability.metrics.metrics();
    expect(text).toContain(
      'obsidian_tc_rerank_outcome_total{vault="main",outcome="not_configured"} 1',
    );
    expect(text).toContain('obsidian_tc_rerank_outcome_total{vault="main",outcome="executed"} 1');
  });
});

describe("THE-645 item 1: onActivationRecompute reaches the exposition", () => {
  it("routes registerActivationRecompute's stats to the recorder instead of discarding them", async () => {
    const db = await seededDb();
    const observability = createObservability(baseDeps(db));

    // Mirrors cli.ts's onRecompute wiring: the job name is the bounded `vault` label, per the
    // same process-wide-subsystem precedent as the scheduler gauges (job name, not a real vault).
    observability.onActivationRecompute("activation-recompute", { chunks: 12 });

    const text = await observability.metrics.metrics();
    expect(text).toContain(
      'obsidian_tc_activation_recompute_chunks_total{vault="activation-recompute"} 12',
    );
  });

  it("wireActivationRecompute: a REAL scheduler tick reaches the exposition end-to-end", async () => {
    const db = await seededDb();
    const observability = createObservability(baseDeps(db));
    const edb = experientialDb();
    edb
      .prepare(
        "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at) VALUES ('r1', 'hot', 1000)",
      )
      .run();

    vi.useFakeTimers();
    try {
      const scheduler = new Scheduler();
      wireActivationRecompute(scheduler, observability, { edb, intervalMs: 1000 });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(1000);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }

    const text = await observability.metrics.metrics();
    expect(text).toContain(
      'obsidian_tc_activation_recompute_chunks_total{vault="activation-recompute"} 1',
    );
  });

  // THE-644 item 3. Every layer beneath this wiring already accepted a `decay` and forwarded it;
  // this function was the one link that dropped it, so `experiential.activationDecay` had nowhere
  // to land and the constant was unreachable outside an eval script. Asserting the OBSERVABLE
  // consequence rather than the argument: two decays over the same event log must produce
  // different cached scores, which is only true if the value actually arrived.
  it("wireActivationRecompute: the configured decay reaches recomputeActivation (THE-644)", async () => {
    const scoreWith = async (decay: number | undefined): Promise<number> => {
      const db = await seededDb();
      const observability = createObservability(baseDeps(db));
      const edb = experientialDb();
      // A RECENT retrieval, and the reason is worth stating because the obvious choice does not
      // work. THE-193's stale floor clamps any raw activation below 0.5 back UP to 0.5 unless
      // there is explicit negative evidence, and a single old retrieval lands under the floor at
      // every decay — so an "old hit" version of this test reads 0.5 == 0.5 and passes whether or
      // not the value was ever forwarded. Measured: at 45 days both 0.1 and 1.5 return exactly 0.5.
      const recent = Date.now() - 2 * 3_600_000;
      edb
        .prepare("INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at) VALUES ('r1','hot',?)")
        .run(recent);
      vi.useFakeTimers();
      try {
        const scheduler = new Scheduler();
        wireActivationRecompute(scheduler, observability, {
          edb,
          intervalMs: 1000,
          ...(decay !== undefined ? { decay } : {}),
        });
        scheduler.start();
        await vi.advanceTimersByTimeAsync(1000);
        await scheduler.stop();
      } finally {
        vi.useRealTimers();
      }
      const row = edb
        .prepare(
          "SELECT cached_activation_score AS s FROM vault_object_state WHERE object_id='hot'",
        )
        .get() as { s: number };
      return row.s;
    };

    const lowExp = await scoreWith(0.1);
    const highExp = await scoreWith(1.5);
    const dflt = await scoreWith(undefined);

    // The exponent arrived: three distinct scores over an identical event log.
    //
    // DIRECTION, stated carefully because it inverts inside one day and a preset written from the
    // wrong half would be backwards. Weight is `days ** -decay`. Above one day that is < 1, so a
    // larger exponent attenuates harder — the "higher decay = faster forgetting" the config
    // presets describe. BELOW one day it is > 1, so a larger exponent AMPLIFIES. This fixture sits
    // at two hours, so the high exponent scores higher; that is the same formula, not a
    // contradiction, and it is the only window where the stale floor does not hide the difference.
    expect(highExp).toBeGreaterThan(lowExp);
    // Omitting the option must leave recomputeActivation's own default in charge rather than
    // pinning a second copy of it in the wiring — two defaults are how they drift apart. 0.5 sits
    // between 0.1 and 1.5, so a default that silently became one of the extremes would show here.
    expect(dflt).toBeGreaterThan(lowExp);
    expect(dflt).toBeLessThan(highExp);
  });
});

describe("THE-612: onVecRebuild reaches the exposition", () => {
  it("routes ensureVecChunks' onRebuild event to the recorder, by reason, with no vault label", async () => {
    const db = await seededDb();
    const observability = createObservability(baseDeps(db));

    observability.onVecRebuild({ reason: "fingerprint_changed", skippedVectors: 3 });

    const text = await observability.metrics.metrics();
    expect(text).toContain('obsidian_tc_vec_rebuild_total{reason="fingerprint_changed"} 1');
  });
});
