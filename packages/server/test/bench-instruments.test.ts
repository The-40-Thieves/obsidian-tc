// bench/instruments.ts partitions the bench files between CodSpeed's two instruments, and
// codspeed.yml runs one node job per instrument. Nothing else notices when those drift apart: a
// WALLTIME_BENCH_FILES entry naming a file that no longer exists collects nothing and still exits
// 0, a bench file ends up measured by neither suite if its job or its script is dropped, and
// CodSpeed is not one of main's required status checks - so a run that measured nothing looks
// exactly like a green one. This test is that guard.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BENCH_EXCLUDE_DEFAULTS, WALLTIME_BENCH_FILES } from "../bench/instruments";

const serverRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");

describe("CodSpeed bench instruments", () => {
  const benchFiles = readdirSync(join(serverRoot, "bench")).filter((f) => f.endsWith(".bench.ts"));

  it("has bench files to partition", () => {
    // Floor: everything below is vacuous over an empty or collapsed bench directory.
    expect(benchFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("routes only real bench files to Walltime, each named once", () => {
    expect(WALLTIME_BENCH_FILES.length).toBeGreaterThan(0);
    expect(new Set(WALLTIME_BENCH_FILES).size).toBe(WALLTIME_BENCH_FILES.length);

    for (const file of WALLTIME_BENCH_FILES) {
      expect(file, "paths are relative to packages/server").toMatch(/^bench\/[\w.-]+\.bench\.ts$/);
      expect(existsSync(join(serverRoot, file)), `${file} does not exist`).toBe(true);
      expect(benchFiles).toContain(file.slice("bench/".length));
    }
  });

  it("carries vitest's own benchmark.exclude defaults, which naming an exclude list replaces", () => {
    expect(BENCH_EXCLUDE_DEFAULTS).toContain("**/node_modules/**");
    expect(BENCH_EXCLUDE_DEFAULTS).toContain("**/.git/**");
  });

  it("derives both suites' file sets from instruments.ts, so neither can hardcode a stale list", () => {
    const simulation = read(serverRoot, "vitest.bench.config.ts");
    const walltime = read(serverRoot, "vitest.bench.walltime.config.ts");

    expect(simulation).toMatch(
      /exclude: \[\.\.\.BENCH_EXCLUDE_DEFAULTS, \.\.\.WALLTIME_BENCH_FILES\]/,
    );
    expect(walltime).toMatch(/include: \[\.\.\.WALLTIME_BENCH_FILES\]/);
    for (const src of [simulation, walltime]) {
      expect(src).toMatch(/from "\.\/bench\/instruments"/);
    }
  });

  it("runs each suite under its own instrument in CI", () => {
    const workflow = read(repoRoot, ".github", "workflows", "codspeed.yml");

    // Pinned as mode-plus-command pairs: either half alone would still pass with the wrong
    // instrument measuring the wrong files.
    expect(workflow).toMatch(
      /mode: simulation\n\s+working-directory: packages\/server\n\s+run: bun run bench\n/,
    );
    expect(workflow).toMatch(
      /mode: walltime\n\s+working-directory: packages\/server\n\s+run: bun run bench:walltime\n/,
    );

    // Walltime is only meaningful on a CodSpeed macro runner, and the job stays skipped rather
    // than queued until one is available.
    expect(workflow).toMatch(/if: vars\.CODSPEED_MACRO_RUNNERS == 'true'/);

    // A macro-runner label is self-hosted as far as GitHub is concerned, so actionlint - a gate in
    // ci-security.yml - rejects it unless it is declared. That config is the only thing standing
    // between a renamed label and a red workflow-lint job.
    const labels = workflow.match(/codspeed-macro-[\w-]+/g) ?? [];
    expect(labels.length).toBeGreaterThan(0);

    const actionlint = read(repoRoot, ".github", "actionlint.yaml");
    for (const label of labels) {
      expect(actionlint, `${label} must be declared for actionlint`).toContain(`- ${label}`);
    }
  });

  it("gives every suite a script that points at an existing config", () => {
    const pkg = JSON.parse(read(serverRoot, "package.json")) as { scripts: Record<string, string> };

    const suites: Array<[script: string, config: string]> = [
      ["bench", "vitest.bench.config.ts"],
      ["bench:walltime", "vitest.bench.walltime.config.ts"],
    ];

    for (const [script, config] of suites) {
      expect(pkg.scripts[script], `missing script: ${script}`).toBe(
        `vitest bench --run --config ${config}`,
      );
      expect(existsSync(join(serverRoot, config)), `${config} does not exist`).toBe(true);
    }
  });
});
