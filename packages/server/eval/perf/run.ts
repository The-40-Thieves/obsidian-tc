import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { collectDispatch } from "./collectors/dispatch";
import { collectHttp, collectHttpConcurrency } from "./collectors/http";
import { collectIndexing } from "./collectors/indexing";
import { collectLifecycle } from "./collectors/lifecycle";
import { collectRetrieval } from "./collectors/retrieval";
import { collectRuntime } from "./collectors/runtime";
import { collectStorage } from "./collectors/storage";
import { type ContentionOptions, calibrate } from "./contention";
import { evaluate } from "./gate";
import { buildVault } from "./harness";
import { type AggregatedReport, toMedianReport } from "./isolate";
import { type Baseline, type PerfReport, toMarkdown } from "./report";
import { runIsolatedSamples } from "./sample";
import { SCENARIOS, type Scenario } from "./scenarios";

/** Build the vault once, run every collector in a fixed order (lifecycle LAST — it closes the DB). */
export async function runScenario(name: Scenario["name"]): Promise<PerfReport> {
  const sc = SCENARIOS[name];
  const t0 = performance.now();
  const vault = await buildVault(sc);
  const buildMs = performance.now() - t0;

  const samples = [
    ...collectIndexing(vault, buildMs),
    ...(await collectRetrieval(vault)),
    ...(await collectDispatch(vault)),
    ...collectStorage(vault),
    ...(await collectRuntime(vault)),
    // THE-495 (family 12). Must precede lifecycle: the handshake needs a live db, and lifecycle
    // closes it as its shutdown-drain measurement.
    ...(await collectHttp(vault)),
    // THE-503 Part 2: 2/8 concurrent HTTP callers. Same live-db requirement as collectHttp, so it
    // must also run before lifecycle closes the db.
    ...(await collectHttpConcurrency(vault)),
    ...(await collectLifecycle(vault)), // closes db
  ];
  // lifecycle closed the db; only remove the temp dir.
  vault.cleanup();
  return { scenario: name, samples };
}

const CALIBRATION_REFERENCE_PATH = "eval/perf/calibration-reference.json";

interface CalibrationReference {
  referenceMs: number;
  tol: number;
}

/** The committed "quiet host" calibration reference (THE-503), used ONLY to catch SUSTAINED,
 *  uniform contention that the relative CV/max checks cannot see (see contention.ts's module
 *  comment). Optional by design: absent on a fresh checkout or a fork that never ran
 *  --update-baseline, in which case only the relative checks apply — never a hard requirement to
 *  run the harness at all. */
function readCalibrationReference(): ContentionOptions {
  try {
    const ref = JSON.parse(
      readFileSync(CALIBRATION_REFERENCE_PATH, "utf8"),
    ) as CalibrationReference;
    return { referenceMs: ref.referenceMs, referenceTol: ref.tol };
  } catch {
    return {};
  }
}

function writeCalibrationReference(medianMs: number, tol = 0.5): void {
  const ref: CalibrationReference = { referenceMs: medianMs, tol };
  writeFileSync(CALIBRATION_REFERENCE_PATH, JSON.stringify(ref, null, 2));
  process.stdout.write(`wrote ${CALIBRATION_REFERENCE_PATH}\n`);
}

function writeBaseline(name: Scenario["name"], report: PerfReport): void {
  const baseline: Baseline = {};
  for (const s of report.samples) {
    baseline[s.key] = {
      value: s.value,
      tol:
        s.direction === "exact" ? 0 : s.unit === "per_s" ? 0.25 : s.class === "hard" ? 0.15 : 0.5,
      mode: s.unit === "ratio" || s.unit === "bool" ? "abs" : "ratio",
      class: s.class,
      direction: s.direction,
    };
  }
  writeFileSync(`eval/perf/baseline.${name}.json`, JSON.stringify(baseline, null, 2));
  process.stdout.write(`\nwrote eval/perf/baseline.${name}.json\n`);
}

/** Returns true iff a hard failure occurred (caller decides when to exit — isolated mode also
 *  wants to report contention/hard-instability findings before exiting). */
function runGate(name: Scenario["name"], report: PerfReport): boolean {
  const baseline = JSON.parse(readFileSync(`eval/perf/baseline.${name}.json`, "utf8")) as Baseline;
  const result = evaluate(report, baseline);
  for (const w of result.warnings)
    process.stdout.write(`WARN ${w.key}: ${w.actual} vs baseline ${w.baseline}\n`);
  if (result.hardFailures.length > 0) {
    for (const f of result.hardFailures)
      process.stderr.write(`FAIL ${f.key}: ${f.actual} vs baseline ${f.baseline} (tol ${f.tol})\n`);
    return true;
  }
  process.stdout.write(`perf gate OK (${result.warnings.length} warnings)\n`);
  return false;
}

function printAggregateSummary(agg: AggregatedReport): void {
  process.stdout.write(`\n## perf isolated samples — ${agg.scenario} (n=${agg.n})\n\n`);
  process.stdout.write("| metric | median | cv | raw |\n|---|---|---|---|\n");
  for (const s of agg.samples) {
    process.stdout.write(
      `| ${s.key} | ${s.median} | ${s.cv.toFixed(3)} | ${s.raw.map((v) => v.toFixed(3)).join(", ")} |\n`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const name = (get("--scenario") ?? "small") as Scenario["name"];
  const out = get("--out") ?? "perf-report.json";
  const samplesFlag = get("--samples");

  if (samplesFlag !== undefined) {
    // THE-503 Part 1: isolated mode. Each of the N samples is a genuinely fresh `bun` subprocess
    // (sample.ts), never sharing event loop / module cache / GC state with this process or with
    // each other. Gate on the MEDIAN, never a single observation; track + report CV; preserve
    // every raw sample in the artifact; reject a baseline recorded under detected host
    // contention rather than silently committing a bad number.
    const n = Number.parseInt(samplesFlag, 10);
    const {
      aggregate: agg,
      contention,
      hardInstabilities,
    } = runIsolatedSamples(name, {
      n,
      contention: readCalibrationReference(),
    });
    writeFileSync(out, JSON.stringify(agg, null, 2));
    printAggregateSummary(agg);
    process.stdout.write(
      `\ncontention: ${contention.contended ? "DETECTED" : "clean"} (median ${contention.median.toFixed(2)}ms, cv ${contention.cv.toFixed(3)})` +
        `${contention.reason ? ` — ${contention.reason}` : ""}\n`,
    );

    // Correctness (hard-class agreement across isolated samples) is checked FIRST and always,
    // independent of --gate/--update-baseline: a hard-class metric that varies across identically
    // seeded runs is a broken invariant, not a tolerance question.
    if (hardInstabilities.length > 0) {
      for (const h of hardInstabilities)
        process.stderr.write(
          `HARD-UNSTABLE ${h.key}: varied across samples -> [${h.raw.join(", ")}]\n`,
        );
      process.exit(1);
    }

    const medianReport = toMedianReport(agg);

    if (args.includes("--update-baseline")) {
      if (contention.contended) {
        process.stderr.write(
          `REFUSING to record baseline: host contention detected during isolated sampling (${contention.reason ?? "high variance"}). Re-run on a quiet host.\n`,
        );
        process.exit(1);
      }
      writeBaseline(name, medianReport);
      writeCalibrationReference(contention.median);
      return;
    }

    if (args.includes("--gate")) {
      if (contention.contended) {
        process.stdout.write(
          `WARN host contention detected during this gate run (${contention.reason ?? "high variance"}) — perf numbers may be unreliable this run\n`,
        );
      }
      if (runGate(name, medianReport)) process.exit(1);
    }
    return;
  }

  // Single-shot mode (dev-fast default; also what each isolated subprocess sample runs as).
  const report = await runScenario(name);
  report.calibrationMs = calibrate();
  writeFileSync(out, JSON.stringify(report, null, 2));
  process.stdout.write(toMarkdown(report));

  if (args.includes("--update-baseline")) {
    writeBaseline(name, report);
    return;
  }

  if (args.includes("--gate")) {
    if (runGate(name, report)) process.exit(1);
  }
}

// Run as a script (bun eval/perf/run.ts ...) but not when imported by tests. `import.meta.main` is
// a Bun/Node-recent addition without a stable TS lib type in this repo's target — see the same
// cast in eval/run.ts. Under Node vitest this is falsy, so importing `runScenario` never runs the CLI.
if ((import.meta as unknown as { main?: boolean }).main) {
  void main();
}
