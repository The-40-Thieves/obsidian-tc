// GH #995 — one-shot challenger for test/vault-lock-gc-trap.test.ts. Makes exactly ONE
// acquisition attempt against the real production module (src/runtime/vault-lock.ts) and prints
// "ACQUIRED" or "BLOCKED", then exits. Retry is effectively disabled (a huge jitter window) since
// this probe only cares about the FIRST attempt's outcome and exits immediately after — a
// scheduled-but-never-fired retry timer is `.unref()`'d already by the module itself, so it does
// not keep this process alive past its own explicit exit below.
import { startVaultLeaderElection } from "../src/runtime/vault-lock";

async function main(): Promise<void> {
  const cacheDir = process.argv[2];
  if (!cacheDir) throw new Error("usage: vault-lock-challenger-probe.ts <cacheDir>");
  const election = await startVaultLeaderElection({
    cacheDir,
    retryMinMs: 3_600_000,
    retryMaxMs: 3_600_000,
  });
  console.log(election.isLeader() ? "ACQUIRED" : "BLOCKED");
  await election.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
