import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
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
  // Trailing newline: these files are COMMITTED, and biome's formatter requires one — without it
  // every automated recording produces a lint-failing PR (caught on the first real run, THE-534).
  writeFileSync(CALIBRATION_REFERENCE_PATH, `${JSON.stringify(ref, null, 2)}\n`);
  process.stdout.write(`wrote ${CALIBRATION_REFERENCE_PATH}\n`);
}

/** THE-534: what the baseline was measured against. Written as a SIDECAR rather than a key inside
 *  baseline.<name>.json on purpose — the gate now walks the baseline's own keys and demands a sample
 *  for each, so a metadata key living in that file would be read as a metric that never gets
 *  measured, i.e. a permanent phantom hard failure. */
function writeBaselineProvenance(
  name: Scenario["name"],
  mode: "isolated-median" | "single-shot",
  samples: number,
): void {
  const git = (args: string[]): string => {
    try {
      return execFileSync("git", args, { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const sha = git(["rev-parse", "HEAD"]) || "unknown";
  // A baseline measured on a dirty tree is not reproducible from its SHA, so the SHA alone would be
  // a false provenance claim. Record it and say so loudly rather than quietly writing a number
  // nobody can reproduce.
  const dirty = git(["status", "--porcelain"]) !== "";
  const provenance = {
    scenario: name,
    mode,
    samples,
    measuredAtSha: sha,
    treeDirty: dirty,
    measuredAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, cpus: cpus().length },
  };
  writeFileSync(
    `eval/perf/baseline.${name}.provenance.json`,
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  process.stdout.write(`wrote eval/perf/baseline.${name}.provenance.json (sha ${sha})\n`);
  if (dirty) {
    process.stdout.write(
      `WARN baseline measured on a DIRTY working tree — ${sha} does not reproduce it. Commit first, then re-record.\n`,
    );
  }
}

function writeBaseline(
  name: Scenario["name"],
  report: PerfReport,
  mode: "isolated-median" | "single-shot",
  samples: number,
): void {
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
  writeFileSync(`eval/perf/baseline.${name}.json`, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(`\nwrote eval/perf/baseline.${name}.json\n`);
  writeBaselineProvenance(name, mode, samples);
}

/** Returns true iff a hard failure occurred (caller decides when to exit — isolated mode also
 *  wants to report contention/hard-instability findings before exiting). */
function runGate(name: Scenario["name"], report: PerfReport): boolean {
  const baseline = JSON.parse(readFileSync(`eval/perf/baseline.${name}.json`, "utf8")) as Baseline;
  const result = evaluate(report, baseline);
  // THE-534: a "missing" violation has no measured value, so print WHY rather than `NaN vs
  // baseline X` — the actionable fact is that the harness stopped emitting the metric (or the key
  // was renamed), not that some number drifted.
  const describe = (v: (typeof result.hardFailures)[number]): string =>
    v.reason === "missing"
      ? `${v.key}: NOT MEASURED (baseline ${v.baseline} — metric absent from report; renamed or no longer emitted?)`
      : `${v.key}: ${v.actual} vs baseline ${v.baseline} (tol ${v.tol})`;

  for (const w of result.warnings) process.stdout.write(`WARN ${describe(w)}\n`);

  // Improvements never fail, but a large one means this baseline no longer describes the system —
  // THE-486's 113x landed through a silent `perf gate OK`, and THE-467/THE-468 are gated on these
  // numbers being current. Say so loudly instead.
  for (const s of result.stale) {
    process.stdout.write(
      `STALE BASELINE ${s.key}: ${s.actual} is ${s.factor.toFixed(1)}x better than baseline ${s.baseline} — re-record the baseline (THE-534).\n`,
    );
  }

  if (result.hardFailures.length > 0) {
    for (const f of result.hardFailures) process.stderr.write(`FAIL ${describe(f)}\n`);
    return true;
  }
  process.stdout.write(
    `perf gate OK (${result.warnings.length} warnings, ${result.stale.length} stale)\n`,
  );
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

/** Which runtime is executing — reported in the artifact so a Node number is never mistaken for a
 *  bun one. `Bun` is a global only under bun. */
function runtimeName(): string {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  return bun ? `bun-${bun.version}` : `node-${process.versions.node}`;
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
  const profile = get("--profile");

  // THE-494: the Node portability run. The gated harness is bun + better-sqlite3 + sqlite-vec —
  // the real production storage path. Under Node + node:sqlite the sqlite-vec extension does not
  // load and vector search silently degrades to brute force, so gating there would benchmark a
  // path production never takes. This profile therefore reports ONLY the metrics tagged
  // `portable` at their source (deterministic + storage-agnostic) and REFUSES to gate or to
  // record a baseline: two runtimes, two meanings, never one baseline.
  if (profile !== undefined) {
    if (profile !== "portable") {
      process.stderr.write(`unknown --profile ${profile} (only "portable" exists)\n`);
      process.exit(2);
    }
    for (const forbidden of ["--gate", "--update-baseline"]) {
      if (args.includes(forbidden)) {
        process.stderr.write(
          `--profile portable is informational and cannot ${forbidden}: it measures a runtime the production path never uses, so its numbers must never become a gate or a baseline.\n`,
        );
        process.exit(2);
      }
    }
    const full = await runScenario(name);
    const samples = full.samples.filter((s) => s.portable === true);
    // A profile that silently measured nothing would read as a clean portability signal. The
    // portable set is opt-in, so an empty one means the tags were lost, not that nothing ported.
    if (samples.length === 0) {
      process.stderr.write(
        "portable profile selected ZERO metrics — the `portable` tags are missing from the collectors. Refusing to report a portability result over an empty set.\n",
      );
      process.exit(1);
    }
    const report: PerfReport = { scenario: `${name} (portable/${runtimeName()})`, samples };
    writeFileSync(out, JSON.stringify(report, null, 2));
    process.stdout.write(toMarkdown(report));
    process.stdout.write(
      `\nportable profile: ${samples.length} of ${full.samples.length} metrics, runtime ${runtimeName()} — informational, never gated.\n`,
    );
    return;
  }

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
      writeBaseline(name, medianReport, "isolated-median", agg.n);
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
    writeBaseline(name, report, "single-shot", 1);
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
