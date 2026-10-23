// StrykerJS mutation testing for the three pure parsers in this package. Run by the nightly,
// NON-gating .github/workflows/mutation.yml, and by hand with `bun run mutate` here.
//
// Scope is three files, not the package: the parsers are pure and have the strongest tests, while
// the schema files under src/config/ are mostly declarative zod shape, so their mutants are mostly
// equivalent and would only add noise to the score.
//
// WHY THE COMMAND RUNNER, NOT @stryker-mutator/vitest-runner. Under Vitest 5 the vitest runner runs
// none of a mutant's covering tests and marks it Survived, which makes the score meaningless.
// Measured on src/fetch-cause.ts alone (Stryker 10.0.0, vitest 5.0.5):
//   vitest-runner:  4 killed, 22 survived (15.38%). One "survivor" empties extractCauseCode's whole
//                   body; applying that mutant by hand makes 4 tests in test/fetch-cause.test.ts fail.
//   command runner: 25 killed, 1 survived (96.15%), 14 s.
// The cause is upstream: the vitest runner builds a per-mutant testNamePattern from space-joined
// names, but Vitest 5 matches the suite chain joined with ' > ', so nested tests never run per
// mutant. Tracked at https://github.com/stryker-mutator/stryker-js/issues/6210 (fix PRs open). The
// vitest runner can come back once a release fixes it. Until then the command runner runs the whole
// shared suite per mutant, which is slower but records real kills.
//
// MEASURED (full run, all three files, command runner; see the commit message for the table):
//   846 mutants in 3 files: 675 killed, 2 timeout, 169 survived, 0 no coverage, 0 errors.
//   Score 80.02% (fetch-cause.ts 96.15%, net-host.ts 77.85%, net-ip.ts 83.93%).
//   Wall time 21 min 23 s on a 4-core ARM dev host (Node v26.10.0, Stryker 10.0.0, vitest 5.0.5).
//   Stryker reports "1.00 tests per mutant": the command runner counts the whole suite as one test.
//
// thresholds.break is null on purpose: a mutation score is a signal to read, not a build gate.
// `incremental` keeps a rerun to the mutants whose source or tests changed (the incremental file
// lives under reports/mutation/, which is gitignored).
//
// `inPlace` skips the sandbox copy, which cannot resolve tsconfig.json "extends"
// (../../tsconfig.base.json lies outside this package), and Stryker's tsconfig rewrite needs the
// TypeScript JS API, which TypeScript 7 no longer exports. Mutants are written to the real files and
// restored after the run. Do NOT pipe the run's output into head or tail: a SIGPIPE kills Stryker
// before it restores the files.

export default {
  testRunner: "command",
  commandRunner: { command: "node ./node_modules/vitest/vitest.mjs run" },
  mutate: ["src/net-ip.ts", "src/net-host.ts", "src/fetch-cause.ts"],
  inPlace: true,
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
  thresholds: { high: 80, low: 60, break: null },
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/html/index.html" },
};
