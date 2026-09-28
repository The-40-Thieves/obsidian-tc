// GH #995 — RED-control fixture for test/vault-lock-gc-trap.test.ts, Bun ONLY.
//
// Deliberately reproduces the EXACT bug a previous agent shipped and wrongly diagnosed as
// "bun:sqlite does not enforce BEGIN EXCLUSIVE across processes": it opens the lock connection
// inside a function and never stores the returned `Database` anywhere the caller keeps alive, so
// once that function returns there is NO reachable JS reference to it. Under Bun's GC, an
// unreferenced bun:sqlite `Database`'s finalizer runs and CLOSES the native connection — silently
// releasing the OS-level lock out from under a still-"running" leader. This file exists ONLY to
// prove that trap is real (test/vault-lock-gc-trap.test.ts asserts a challenger ACQUIRES against
// this probe); no production code in this repo takes this shape — see src/runtime/vault-lock.ts's
// header comment for the correct pattern (hold a live reference; a keepalive tick that USES it,
// not just captures it).
import { join } from "node:path";

async function acquireBadly(path: string): Promise<void> {
  // "bun:sqlite" resolves only under the bun-smoke tsconfig, not this package's main one (see
  // src/db/bun-sqlite.ts's matching comment) — an unconditional ignore, not `expect-error`, since
  // this file's own type-checking runs under the main tsconfig only (it is not itself part of the
  // bun-smoke project), where the specifier never resolves.
  // biome-ignore lint/suspicious/noTsIgnore: expect-error is unusable here — see comment above.
  // @ts-ignore
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=0");
  db.exec("BEGIN EXCLUSIVE");
  // `db` falls out of scope HERE with no reachable reference anywhere else — the bug, on purpose.
}

async function main(): Promise<void> {
  const cacheDir = process.argv[2];
  if (!cacheDir) throw new Error("usage: vault-lock-gc-trap-bad-holder-probe.ts <cacheDir>");
  await acquireBadly(join(cacheDir, "vault-lock.db"));
  console.log("LEADER");
  // Force GC aggressively and repeatedly — this is what collects the now-unreferenced `db` above
  // and runs its finalizer.
  setInterval(() => {
    (globalThis as unknown as { Bun: { gc: (force: boolean) => void } }).Bun.gc(true);
  }, 200);
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
