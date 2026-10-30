import { WALLTIME_BENCH_FILES } from "./bench/instruments";
import { benchConfig } from "./vitest.bench.base";

// The CodSpeed Walltime suite (`bun run bench:walltime`): only the files bench/instruments.ts
// routes away from Simulation, and that list is the single source of truth for both suites.
export default benchConfig({ include: [...WALLTIME_BENCH_FILES] });
