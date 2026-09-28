// GH #995 — child-process holder for test/vault-lock.test.ts's SIGKILL/failover case and
// test/vault-lock-gc-trap.test.ts's control case. Spawned with `bun` ONLY (like this repo's other
// raw-TS probes, e.g. param-binding-bun-probe.ts): the extensionless relative imports below match
// every source file in this repo, which Bun resolves directly but plain `node script.ts` does not
// (confirmed empirically — Node's ESM loader requires an explicit extension per import even with
// type-stripping on). The Node-side proof of the same failover behavior runs against the real
// BUILT dist CLI instead (test/vault-leader-failover.test.ts), which is how this repo already
// tests Node behavior without a raw-TS interpreter for it (see shutdown-boot-embed.test.ts).
// startVaultLeaderElection itself still routes through db/open.ts's own runtime detection, same
// as every other production caller — this probe's bun-only invocation is a TEST-HARNESS
// constraint, not a limitation of the module under test.
//
// argv[1]: cacheDir
// env VAULT_LOCK_PROBE_FORCE_GC=1: (Bun only) repeatedly call Bun.gc(true) after acquiring, to
//   reproduce this file's own GC-trap test — see vault-lock.ts's header comment for what that
//   proves. A no-op under Node (no Bun.gc to call).
//
// Prints exactly one line — "LEADER" or "FOLLOWER" — then blocks forever so the test harness can
// kill -9 it at a moment of its choosing. The `election` object returned by
// startVaultLeaderElection is kept in a real, live local binding (`election`) for the entire
// process lifetime — the correct pattern this probe exists to demonstrate, contrasted with
// test/vault-lock-gc-trap-bad-holder-probe.ts's deliberately wrong one.
import { startVaultLeaderElection } from "../src/runtime/vault-lock";

async function main(): Promise<void> {
  const cacheDir = process.argv[2];
  if (!cacheDir) throw new Error("usage: vault-lock-holder-probe.ts <cacheDir>");
  const election = await startVaultLeaderElection({ cacheDir });
  console.log(election.isLeader() ? "LEADER" : "FOLLOWER");
  const forceGc =
    process.env.VAULT_LOCK_PROBE_FORCE_GC === "1" &&
    typeof (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc === "function";
  // ONE ref'd (NOT unref'd) interval: this is what keeps the process alive until the harness
  // kills it — an unref'd-only timer plus a never-resolving `await` would let the event loop go
  // idle and the process exit on its own, which is the opposite of what this probe is for. It also
  // references `election` on every tick — belt-and-braces against a future refactor tree-shaking
  // the binding as "unused" (the module's own keepalive tick, inside vault-lock.ts, is the real
  // defense; see its header comment).
  setInterval(() => {
    void election.isLeader();
    if (forceGc) {
      (globalThis as unknown as { Bun: { gc: (force: boolean) => void } }).Bun.gc(true);
    }
  }, 200);
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
