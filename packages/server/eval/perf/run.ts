import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { collectDispatch } from "./collectors/dispatch";
import { collectIndexing } from "./collectors/indexing";
import { collectLifecycle } from "./collectors/lifecycle";
import { collectRetrieval } from "./collectors/retrieval";
import { collectRuntime } from "./collectors/runtime";
import { collectStorage } from "./collectors/storage";
import { evaluate } from "./gate";
import { buildVault } from "./harness";
import { type Baseline, type PerfReport, toMarkdown } from "./report";
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
    ...(await collectLifecycle(vault)), // closes db
  ];
  // lifecycle closed the db; only remove the temp dir.
  vault.cleanup();
  return { scenario: name, samples };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const name = (get("--scenario") ?? "small") as Scenario["name"];
  const out = get("--out") ?? "perf-report.json";
  const report = await runScenario(name);
  writeFileSync(out, JSON.stringify(report, null, 2));
  process.stdout.write(toMarkdown(report));

  if (args.includes("--update-baseline")) {
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
    return;
  }

  if (args.includes("--gate")) {
    const baseline = JSON.parse(
      readFileSync(`eval/perf/baseline.${name}.json`, "utf8"),
    ) as Baseline;
    const result = evaluate(report, baseline);
    for (const w of result.warnings)
      process.stdout.write(`WARN ${w.key}: ${w.actual} vs baseline ${w.baseline}\n`);
    if (result.hardFailures.length > 0) {
      for (const f of result.hardFailures)
        process.stderr.write(
          `FAIL ${f.key}: ${f.actual} vs baseline ${f.baseline} (tol ${f.tol})\n`,
        );
      process.exit(1);
    }
    process.stdout.write(`perf gate OK (${result.warnings.length} warnings)\n`);
  }
}

// Run as a script (bun eval/perf/run.ts ...) but not when imported by tests. `import.meta.main` is
// a Bun/Node-recent addition without a stable TS lib type in this repo's target — see the same
// cast in eval/run.ts. Under Node vitest this is falsy, so importing `runScenario` never runs the CLI.
if ((import.meta as unknown as { main?: boolean }).main) {
  void main();
}
