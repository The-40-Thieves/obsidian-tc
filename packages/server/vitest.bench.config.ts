import { BENCH_EXCLUDE_DEFAULTS, WALLTIME_BENCH_FILES } from "./bench/instruments";
import { benchConfig } from "./vitest.bench.base";

// The CodSpeed Simulation suite (`bun run bench`): every bench file except the ones
// bench/instruments.ts routes to Walltime.
export default benchConfig({
  include: ["bench/**/*.bench.ts"],
  exclude: [...BENCH_EXCLUDE_DEFAULTS, ...WALLTIME_BENCH_FILES],
});
