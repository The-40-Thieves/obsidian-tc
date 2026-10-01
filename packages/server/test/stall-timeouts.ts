// The one Windows runner-stall ceiling, for every budget a test sizes against a stalled runner: a
// per-test vitest timeout, or the kill timeout of a child process the test spawns. The perf-harness
// tests reach it as `perfTimeout` (perf-timeouts.ts); spawn-based tests as `stallTimeout` directly
// or through `runBunSync` (spawn-cli.ts). Do not mint a second constant.
//
// Measured on GitHub-hosted runners (the `build-test` matrix, Node 24, `vitest run`), workload
// unchanged: `runScenario("small")` takes ~2.1-3.4s on ubuntu, ~2.5-3.9s on macOS and ~4.1-4.8s on
// windows-latest when its file runs alone; inside the full parallel suite the same call measured
// 5.0s / 3.0s / 7.7s. The Windows cost is mostly process spawn (the boot probe ~1.0s vs ~0.3s) and
// file I/O on the temp dirs.
//
// What breaks these tests is not that steady-state cost but a runner-wide stall: in one
// windows-latest run `perf-collectors-storage` (0.8s in every other run, pure in-memory SQLite, no
// spawn) took 11.2s and `perf-run` passed 22.7s, both inside the same ~12s window, while
// `perf-isolate-integration` ran 65s against 21-37s elsewhere. A stall stretches whatever is in
// flight by the stall's length, so the budget is sized against the stall, not the work: 60s is ~8x
// the worst in-suite Windows measurement and ~2.6x the worst stall observed. Linux and macOS have
// never shown a stall, so they keep the tight budget that still catches genuinely slow code.
//
// A spawned child is stretched the same way: `memory-import-cli` "exits 2 when --from/--dir/--vault
// are missing" ran 20031ms and was killed (exit -1) by its own 20s `spawnSync` timeout on
// windows-latest (run 36794595067): the child was stretched by the stall, not hung.
//
// These are correctness tests (report shape, determinism, exit codes), so a larger ceiling weakens
// nothing: a hung run still fails, just later.
export const WINDOWS_STALL_TIMEOUT_MS = 60_000;

export function stallTimeout(nonWindowsMs: number): number {
  return process.platform === "win32"
    ? Math.max(nonWindowsMs, WINDOWS_STALL_TIMEOUT_MS)
    : nonWindowsMs;
}
