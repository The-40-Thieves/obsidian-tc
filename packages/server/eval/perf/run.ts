import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { collectBoot } from "./collectors/boot";
import { collectDensification } from "./collectors/densification";
import { collectDispatch } from "./collectors/dispatch";
import { collectHttp, collectHttpConcurrency } from "./collectors/http";
import { collectIndexing } from "./collectors/indexing";
import { collectLifecycle } from "./collectors/lifecycle";
import { collectLock } from "./collectors/lock";
import { collectRetrieval } from "./collectors/retrieval";
import { collectRuntime } from "./collectors/runtime";
import { collectStorage } from "./collectors/storage";
import {
  CALIBRATION_CHANNELS,
  type CalibrationChannel,
  type CalibrationReferenceVector,
  type ChannelThresholdOverrides,
  calibrate,
  calibrateIo,
  formatCalibrationVector,
  measureIoScalingRho,
  type VectorContentionResult,
} from "./contention";
import { evaluate } from "./gate";
import { buildVault } from "./harness";
import { type AggregatedReport, toMedianReport } from "./isolate";
import { type Baseline, type PerfReport, toMarkdown } from "./report";
import { runIsolatedSamples } from "./sample";
import { SCENARIOS, type Scenario } from "./scenarios";
import { SPEARMAN_THRESHOLD } from "./spearman";
import { detectUniformShift } from "./uniform-shift";

/** Build the vault once, run every collector in a fixed order (lifecycle LAST — it closes the DB). */
export async function runScenario(
  name: Scenario["name"],
  opts: {
    /** THE-515: skip the cold-boot probe (family 16). Set by the `portable` profile, which is the
     *  one path that runs this file BUNDLED (`perf:node-parity` builds it to
     *  eval/perf/.node-parity.mjs). The collector resolves the probe relative to `import.meta.url`,
     *  so from a bundle that path is wrong and the spawn fails — and the profile discards boot.*
     *  anyway, since none of it is tagged `portable`. Skipping is both the fix and the honest
     *  behaviour: never pay for a subprocess whose output is thrown away. */
    skipBoot?: boolean;
  } = {},
): Promise<PerfReport> {
  const sc = SCENARIOS[name];
  const t0 = performance.now();
  const vault = await buildVault(sc);
  const buildMs = performance.now() - t0;

  const samples = [
    ...collectIndexing(vault, buildMs),
    // THE-515 (family 16). Cold boot is scenario-INDEPENDENT — the probe never touches the vault —
    // so it is measured once, on the CI-gated scenario, rather than in every baseline. Emitting it
    // everywhere would copy identical numbers into several baseline files and make one
    // registration change demand several deliberate re-records for no added signal.
    ...(name === "small" && !opts.skipBoot ? collectBoot() : []),
    // THE-581 (family 15). Emits nothing for scenarios without densification, so the existing
    // scenarios' metric sets — and therefore their committed baselines — are unchanged.
    ...collectDensification(vault),
    ...(await collectRetrieval(vault)),
    ...(await collectDispatch(vault)),
    ...collectStorage(vault),
    // THE-458: writer-vs-writer lock contention. Its own temp FILE db — the vault is :memory:,
    // where every connection is a separate database and there is no lock to contend for.
    ...(await collectLock()),
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

/** THE-584 shape: one committed quiet-host median per calibration channel. `referenceMs`/`tol` are
 *  the pre-THE-584 scalar (CPU-only) fields, still read so a reference committed before this change
 *  keeps working instead of silently losing the CPU absolute check. */
interface CalibrationReference {
  channels?: Partial<Record<CalibrationChannel, number>>;
  referenceMs?: number;
  tol?: number;
}

/** The committed "quiet host" calibration reference (THE-503, vectorised in THE-584), used ONLY to
 *  catch SUSTAINED, uniform contention that the relative CV/max checks cannot see (see
 *  contention.ts's module comment). Optional by design: absent on a fresh checkout or a fork that
 *  never ran --update-baseline, in which case only the relative checks apply — never a hard
 *  requirement to run the harness at all.
 *
 *  A channel missing from the file simply has no absolute check; it is NOT treated as 0, which
 *  would make every run look infinitely slower than reference and refuse every recording. */
function readCalibrationReference(): {
  reference: CalibrationReferenceVector;
  overrides: ChannelThresholdOverrides;
} {
  try {
    const ref = JSON.parse(
      readFileSync(CALIBRATION_REFERENCE_PATH, "utf8"),
    ) as CalibrationReference;
    if (ref.channels) return { reference: ref.channels, overrides: {} };
    // Legacy scalar file: CPU only. The I/O channel then runs relative checks alone until the next
    // --update-baseline rewrites this file in the vector shape.
    //
    // The legacy `tol` is carried through rather than dropped. It happens to equal the CPU default
    // (0.5) in the committed file, so dropping it would look harmless here — but a checkout that
    // had tuned it would silently get a different tolerance than the one it wrote down, which is a
    // worse failure than not supporting the field at all.
    if (ref.referenceMs === undefined) return { reference: {}, overrides: {} };
    return {
      reference: { cpuMs: ref.referenceMs },
      overrides: ref.tol !== undefined ? { cpuMs: { referenceTol: ref.tol } } : {},
    };
  } catch {
    return { reference: {}, overrides: {} };
  }
}

/** The committed baseline for `name`, or null on a first-ever recording. Absent is not an error:
 *  the uniform-shift check has nothing to compare against and stands down rather than blocking
 *  bootstrap of a new scenario. */
function readBaselineIfPresent(name: Scenario["name"]): Baseline | null {
  try {
    return JSON.parse(readFileSync(`eval/perf/baseline.${name}.json`, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function writeCalibrationReference(result: VectorContentionResult): void {
  const channels: Partial<Record<CalibrationChannel, number>> = {};
  for (const c of CALIBRATION_CHANNELS) channels[c] = result.channels[c].median;
  const ref: CalibrationReference = { channels };
  // Trailing newline: these files are COMMITTED, and biome's formatter requires one — without it
  // every automated recording produces a lint-failing PR (caught on the first real run, THE-534).
  writeFileSync(CALIBRATION_REFERENCE_PATH, `${JSON.stringify(ref, null, 2)}\n`);
  process.stdout.write(`wrote ${CALIBRATION_REFERENCE_PATH}\n`);
}

/** THE-534: what the baseline was measured against. Written as a SIDECAR rather than a key inside
 *  baseline.<name>.json on purpose — the gate now walks the baseline's own keys and demands a sample
 *  for each, so a metadata key living in that file would be read as a metric that never gets
 *  measured, i.e. a permanent phantom hard failure. */
/** Was the working tree dirty BEFORE this process wrote anything? Captured at module load, which is
 *  the only moment that answers the question the provenance actually asks — "does `measuredAtSha`
 *  reproduce this measurement?". Any later read is contaminated by the run's own output files. */
const treeDirtyAtStart = ((): boolean => {
  try {
    return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
  } catch {
    // Not a git checkout (or git unavailable): claim nothing rather than assert cleanliness.
    return false;
  }
})();

function writeBaselineProvenance(
  name: Scenario["name"],
  mode: "isolated-median" | "single-shot",
  samples: number,
  /** THE-584: the per-channel calibration this recording was accepted under. Recorded so a PAST
   *  baseline can be re-judged later — the CPU-only scalar could not answer "was the host's disk
   *  slow when this was measured?", which is precisely the question the 40-90% drift raised.
   *  Absent in single-shot mode, which runs no contention detection at all. */
  calibration?: VectorContentionResult,
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
  //
  // The dirtiness snapshot is taken at process START (see `treeDirtyAtStart`), NOT here. Read here,
  // it would see the baseline/calibration files this very run just wrote and report `true` on every
  // recording that changed a number — including a pristine CI checkout, which is exactly the case
  // this flag exists to bless. `baseline.small.provenance.json` carries that false positive today.
  // A flag that is always true carries no information and would camouflage a genuinely dirty run.
  const dirty = treeDirtyAtStart;
  const provenance = {
    scenario: name,
    mode,
    samples,
    measuredAtSha: sha,
    treeDirty: dirty,
    measuredAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, cpus: cpus().length },
    ...(calibration
      ? {
          calibration: Object.fromEntries(
            CALIBRATION_CHANNELS.map((c) => [
              c,
              { median: calibration.channels[c].median, cv: calibration.channels[c].cv },
            ]),
          ),
        }
      : {}),
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
  calibration?: VectorContentionResult,
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
  writeBaselineProvenance(name, mode, samples, calibration);
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
    // skipBoot: this profile runs from a BUNDLE, where the boot probe's path resolution does not
    // hold — and it filters boot.* out immediately below regardless, since none of it is tagged
    // `portable`. See runScenario's option doc.
    const full = await runScenario(name, { skipBoot: true });
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
      ioScalingRho,
    } = runIsolatedSamples(name, { n, ...readCalibrationReference() });
    writeFileSync(out, JSON.stringify(agg, null, 2));
    printAggregateSummary(agg);
    // THE-584: print the VECTOR, not a scalar, so a reviewer can see which dimension was clean.
    // The old single median could not distinguish a quiet host from an I/O-saturated one.
    process.stdout.write(
      `\ncontention: ${contention.contended ? "DETECTED" : "clean"} [${formatCalibrationVector(contention)}]` +
        `${contention.reason ? ` — ${contention.reason}` : ""}\n`,
    );
    process.stdout.write(
      `io-scaling calibration: median rho ${ioScalingRho.median.toFixed(3)} ` +
        `[${ioScalingRho.raw.map((v) => v.toFixed(3)).join(", ")}]\n`,
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

    // THE-594: the calibrateIo() scaling calibration, relocated here from the unit suite (it
    // flaked on macOS AND windows-latest even after a THE-584 recalibration -- see spearman.ts's
    // module note). Checked unconditionally, like the hard-instability check above: this proves
    // the I/O contention probe is measuring real work, which is a correctness invariant of the
    // harness itself, not a tolerance question the baseline/gate system answers.
    if (ioScalingRho.median <= SPEARMAN_THRESHOLD) {
      process.stderr.write(
        `FAIL calibrateIo() scaling check: median Spearman rho ${ioScalingRho.median.toFixed(3)} ` +
          `across ${n} isolated samples does not exceed ${SPEARMAN_THRESHOLD} -- calibrateIo() may ` +
          `not be measuring real work (THE-584/THE-594).\n`,
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
      // THE-584 item 4: the probe-free comparability check. The calibration probes above can only
      // catch a channel someone thought to measure; this reads the WORKLOAD instead, so it is blind
      // to nothing. A uniform slowdown across warn metrics with every deterministic count unchanged
      // is a slower host, not a slower build.
      //
      // Skipped when no baseline exists yet — there is nothing to compare a first recording against,
      // and refusing one would make the harness impossible to bootstrap.
      const previous = readBaselineIfPresent(name);
      if (previous) {
        const shift = detectUniformShift(medianReport, previous);
        if (shift.suspect && !args.includes("--accept-uniform-shift")) {
          process.stderr.write(
            `REFUSING to record baseline: ${shift.reason}\n` +
              `  moved: ${shift.movedWorse.join(", ")}\n` +
              `If this host IS the new reference (a deliberate CI hardware change, or numbers that\n` +
              `reproduce across runners while the old ones do not), re-run with --accept-uniform-shift.\n`,
          );
          process.exit(1);
        }
        if (shift.suspect) {
          process.stdout.write(
            `ACCEPTING a uniform ${shift.medianFactor.toFixed(2)}x shift across ${shift.movedWorse.length}/${shift.comparable} warn metrics (--accept-uniform-shift). This ratchets those thresholds; the diff is worth reading metric by metric.\n`,
          );
        }
      }
      writeBaseline(name, medianReport, "isolated-median", agg.n, contention);
      writeCalibrationReference(contention);
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
  report.calibrationIoMs = calibrateIo(); // THE-584: the second contention channel
  report.ioScalingRho = measureIoScalingRho(); // THE-594: proves the I/O probe measures real work
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
