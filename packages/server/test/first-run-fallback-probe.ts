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
