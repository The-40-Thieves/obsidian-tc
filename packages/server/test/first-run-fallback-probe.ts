// Fix round (cross-vendor review, finding 2): a REAL child-process racer for
// test/setup-first-run-fallback-e2e.test.ts's concurrency test — grok's own review found the
// previous in-process `Promise.all([attemptFirstRunFallback(), attemptFirstRunFallback()])` could
// never actually overlap (writeSetupConfig is fully synchronous, so the second call cannot enter
// the writer until the first has fully returned): it only ever exercised "the file already existed
// at the opening `existsSync`", never a genuine `linkSync`/`wx` EEXIST race between two OS
// processes. This probe is spawned TWICE, nearly simultaneously, against the SAME HOME/registry —
// same "bun-only raw-TS probe" pattern as vault-lock-holder-probe.ts (its own header explains why:
// this repo's extensionless relative imports resolve directly under bun, not plain `node script.ts`).
//
// Prints exactly one line of JSON: `{ outcome, path, vaultIds }` (or `{ outcome: "declined",
// reason }`), then exits — the test harness reads both processes' stdout and asserts on the pair.
import { attemptFirstRunFallback } from "../src/cli/setup/first-run-fallback";

// The vitest setup file that stubs `systeminformation` (hardware-probe-stub-setup.ts) cannot reach
// this separate bun process, and on Windows the real probe starts a powershell.exe that hardware.ts
// abandons after 2 s: it outlives this process and holds a handle under the test's HOME, which is
// what kept the test's temp dir from being removed. hardware.ts imports the module lazily, so a
// runtime plugin registered here, before the first call, replaces it.
(globalThis as { Bun?: { plugin(p: unknown): void } }).Bun?.plugin({
  name: "stub-systeminformation",
  setup(build: {
    module(name: string, cb: () => { exports: object; loader: "object" }): void;
  }): void {
    build.module("systeminformation", () => ({
      exports: {
        cpu: async () => ({ manufacturer: "Test", brand: "CPU" }),
        graphics: async () => ({ controllers: [] }),
      },
      loader: "object",
    }));
  },
});

async function main(): Promise<void> {
  const result = await attemptFirstRunFallback();
  if (result.outcome === "declined") {
    console.log(JSON.stringify({ outcome: result.outcome, reason: result.reason }));
    return;
  }
  console.log(
    JSON.stringify({
      outcome: result.outcome,
      path: result.path,
      vaultIds: result.config.vaults.map((v) => v.id),
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
