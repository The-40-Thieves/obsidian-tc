// Which bench file is measured by which CodSpeed instrument.
//
// codspeed.yml runs one node job per instrument and both derive their file sets from this module,
// so every bench file is measured exactly once: the Walltime job includes the files listed here,
// the Simulation job excludes them. Paths are relative to packages/server, the working directory
// both jobs run `vitest bench` from.
//
// Simulation (instruction counts under Valgrind) is the default and the right instrument for pure
// CPU work. A file belongs here only when Simulation has been shown to measure it bimodally for
// reasons outside the code, because Walltime buys that stability at the cost of needing a CodSpeed
// macro runner: Walltime on a shared GitHub-hosted runner produces inconsistent data, and a
// baseline is only comparable to runs on the same class of machine.
//
// markdown.bench.ts: a census of 23 runs of `chunkNote::small note` found exactly two modes with
// nothing between them - ~504-511us with sysCount 0 and ~696-731us with sysCount 2 - alternating
// across commits that touched no markdown code (a ~29% "regression" landed on an OAuth state fix,
// GH #1448). Neither candidate cause survived. The runner CPU does not decide the mode: EPYC 7763
// produced both modes and EPYC 9V45 produced both, so the "Environment Differences" notice
// CodSpeed prints on every such comparison is a confounder here, not the cause. Nor does the
// node:crypto warm-up added by GH #1450 cure it: that warm-up is present on a commit which still
// measured 715us with sysCount 2, so it moved the floor by ~5us without removing the mode. Every
// flamegraph frame matches between the modes to within 0.2us except contentHash, which carries the
// entire ~208us gap (+42us instructions, +64us cache, +102us memory, two syscalls) - the signature
// of a GC landing in the measured region, which no warm-up can pre-empt. Walltime takes a
// distribution instead of one Valgrind pass, so a stray pause lands in the spread rather than in
// the headline number.
//
// Worth knowing before reading anything into this benchmark either way: contentHash is 62% of it
// even in the fast mode, so `chunkNote::small note` measures sha256 more than it measures chunking,
// and a real chunking regression arrives diluted roughly threefold.

/** Bench files measured with CodSpeed's Walltime instrument instead of Simulation. */
export const WALLTIME_BENCH_FILES = ["bench/markdown.bench.ts"];

/**
 * vitest's own `benchmark.exclude` defaults. Naming an exclude list replaces them rather than
 * adding to them, so they have to be carried forward explicitly or node_modules gets collected.
 */
export const BENCH_EXCLUDE_DEFAULTS = ["**/node_modules/**", "**/.git/**"];
