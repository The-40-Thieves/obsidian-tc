import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ContentionOptions, type ContentionResult, detectContention } from "./contention";
import {
  type AggregatedReport,
  aggregate,
  checkHardStability,
  type HardInstability,
} from "./isolate";
import type { PerfReport } from "./report";
import type { Scenario } from "./scenarios";

// THE-503 Part 1: "run each benchmark family in a fresh subprocess" + ">=5 samples, gate on the
// median". This module is the subprocess-orchestration half (isolate.ts is the pure aggregation
// half): it spawns N genuinely separate `bun run.ts` processes -- no shared module cache, event
// loop, JIT state, or GC pressure with the harness's own runtime or with each other -- and hands
// the resulting reports to isolate.ts + contention.ts.

export interface IsolatedRunResult {
  aggregate: AggregatedReport;
  contention: ContentionResult;
  hardInstabilities: HardInstability[];
}

export type SpawnRun = (scenario: Scenario["name"], outPath: string) => void;

const RUN_TS_PATH = fileURLToPath(new URL("./run.ts", import.meta.url));

/** Real isolation: a fresh `bun` process per sample. Synchronous by design -- samples must run
 *  one at a time, not concurrently, or they would contend with EACH OTHER on CPU and defeat the
 *  whole point. Not called directly by tests, which inject a fake `SpawnRun` instead so the
 *  aggregation/orchestration logic can be verified without paying for N real vault builds. */
function spawnBunRun(scenario: Scenario["name"], outPath: string): void {
  const result = spawnSync("bun", [RUN_TS_PATH, "--scenario", scenario, "--out", outPath], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.error) {
    throw new Error(`isolated perf sample failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `isolated perf sample subprocess exited ${result.status} (scenario "${scenario}")`,
    );
  }
}

/**
 * Run `n` (default 5, per THE-503) fresh, isolated samples of `scenario`, then:
 *  - aggregate them (median + CV + raw samples preserved, isolate.ts),
 *  - run host-contention detection over each subprocess's calibration probe (contention.ts),
 *  - check hard-class metrics agree exactly across all N samples (isolate.ts).
 *
 * Callers (run.ts's CLI) decide what to DO with contention/instability findings -- refuse a
 * baseline update, hard-fail a gate run, or just annotate the report. This function only reports
 * what it measured.
 */
export function runIsolatedSamples(
  scenario: Scenario["name"],
  opts?: { n?: number; spawn?: SpawnRun; contention?: ContentionOptions },
): IsolatedRunResult {
  const n = opts?.n ?? 5;
  if (n < 1) throw new Error("runIsolatedSamples(): n must be >= 1");
  const spawn = opts?.spawn ?? spawnBunRun;

  const dir = mkdtempSync(join(tmpdir(), "obtc-perf-isolate-"));
  try {
    const reports: PerfReport[] = [];
    const calibrations: number[] = [];
    for (let i = 0; i < n; i++) {
      const outPath = join(dir, `sample-${i}.json`);
      spawn(scenario, outPath);
      const report = JSON.parse(readFileSync(outPath, "utf8")) as PerfReport;
      reports.push(report);
      calibrations.push(report.calibrationMs ?? 0);
    }
    const agg = aggregate(reports);
    const contention = detectContention(calibrations, opts?.contention);
    const hardInstabilities = checkHardStability(agg);
    return { aggregate: agg, contention, hardInstabilities };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
