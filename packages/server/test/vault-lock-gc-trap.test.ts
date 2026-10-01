// GH #995 — THE GC TRAP, pinned as a RED case.
//
// A previous agent concluded "bun:sqlite does not enforce BEGIN EXCLUSIVE across processes". That
// was WRONG. The real root cause, reproduced here: an UNREFERENCED bun:sqlite `Database` is
// garbage-collected, and its finalizer CLOSES the native connection — silently releasing the
// lock. Measured on this box (Bun 1.4.2, SQLite 3.53.2) before src/runtime/vault-lock.ts existed:
//   - a holder that stashes its `Database` on `globalThis` (a live strong ref) stayed leader
//     through `setInterval(() => Bun.gc(true), 200)` for 2.3s of forced GC; kill -9 released it.
//   - a holder with NO live reference let a challenger ACQUIRE within ~0.3s of forced GC.
//   - a `setInterval(() => { void db }, …)` closure that only CAPTURES `db` is not enough — JSC
//     drops the unused capture; the closure must actually USE it.
//
// This file proves BOTH halves against REAL bun processes (not a simulation):
//   1. the RED control (vault-lock-gc-trap-bad-holder-probe.ts) reproduces the trap — a challenger
//      ACQUIRES against it under forced GC, exactly like the previous agent's broken design would.
//   2. the real module (vault-lock-holder-probe.ts, VAULT_LOCK_PROBE_FORCE_GC=1) does NOT have the
//      trap — a challenger stays BLOCKED under the same forced-GC pressure.
// Bun only: the trap is Bun-specific (bun:sqlite's own GC-finalizer semantics), so this whole file
// is skipped, not failed, when bun is absent — mirroring every other bun-only probe test here.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stallTimeout } from "./stall-timeouts";
import { rmTemp } from "./tmp";

const HERE = dirname(fileURLToPath(import.meta.url));
const BAD_HOLDER_PROBE = join(HERE, "vault-lock-gc-trap-bad-holder-probe.ts");
const GOOD_HOLDER_PROBE = join(HERE, "vault-lock-holder-probe.ts");
const CHALLENGER_PROBE = join(HERE, "vault-lock-challenger-probe.ts");

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "otc-vault-lock-gc-"));
  tmpDirs.push(d);
  return d;
}
const spawned: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // best-effort
    }
  }
});

/** Spawns a bun holder probe and resolves with the CHILD once it has printed "LEADER" on stdout —
 *  TEST_FALSE_ASSURANCE (fix round): the caller needs the child reference to assert it is still
 *  alive (not merely that some challenger acquired), so the RED control actually isolates the
 *  GC-finalizer trap rather than a holder process that crashed outright. */
function spawnHolder(
  script: string,
  cacheDir: string,
  env: NodeJS.ProcessEnv = {},
): Promise<ReturnType<typeof spawn>> {
  const child = spawn("bun", [script, cacheDir], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  spawned.push(child);
  let out = "";
  return new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`holder probe never reported LEADER: ${out}`)),
      stallTimeout(15_000),
    );
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (out.includes("LEADER")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
  });
}

/** Runs the one-shot challenger and returns its verdict. TEST_FALSE_ASSURANCE (fix round): a
 *  non-zero exit or a `spawnSync` timeout must FAIL this helper outright, never fall through to
 *  reading whatever happened to be on stdout — a challenger that printed "BLOCKED" and then hung
 *  past the timeout (killed by `spawnSync`'s own `timeout`) previously still returned "BLOCKED" as
 *  if it had exited cleanly. */
function challenge(cacheDir: string): "ACQUIRED" | "BLOCKED" {
  const r = spawnSync("bun", [CHALLENGER_PROBE, cacheDir], {
    encoding: "utf8",
    timeout: stallTimeout(15_000),
  });
  if (r.error) {
    throw new Error(`challenger probe failed to run: ${r.error.message}`);
  }
  if (r.signal !== null) {
    throw new Error(
      `challenger probe was killed by signal ${r.signal} (likely the spawnSync timeout); stdout=${r.stdout} stderr=${r.stderr}`,
    );
  }
  if (r.status !== 0) {
    throw new Error(
      `challenger probe exited non-zero (status=${r.status}); stdout=${r.stdout} stderr=${r.stderr}`,
    );
  }
  const line = r.stdout.trim().split("\n").at(-1);
  if (line !== "ACQUIRED" && line !== "BLOCKED") {
    throw new Error(
      `challenger probe produced unexpected output: stdout=${r.stdout} stderr=${r.stderr}`,
    );
  }
  return line;
}

describe.skipIf(!bunAvailable)("GH #995: bun:sqlite GC-finalizer trap on the leader lock", () => {
  it("RED control: an unreferenced bun:sqlite Database is GC'd and releases the lock under forced GC", {
    timeout: stallTimeout(20_000),
  }, async () => {
    const cacheDir = tmpDir();
    const holder = await spawnHolder(BAD_HOLDER_PROBE, cacheDir);
    // Let the holder's forced-GC loop run a few cycles (200ms each) — matches the primitives
    // doc's measured ~0.3s window for a challenger to acquire against an unreferenced Database.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    // TEST_FALSE_ASSURANCE (fix round): the holder process itself must still be running — otherwise
    // an ACQUIRED verdict just proves the holder crashed, not that its unreferenced Database was
    // GC'd out from under a still-live process (the actual trap this RED control exists to pin).
    expect(holder.exitCode).toBeNull();
    expect(holder.signalCode).toBeNull();
    expect(challenge(cacheDir)).toBe("ACQUIRED");
  });

  it("the real module (src/runtime/vault-lock.ts) keeps the lock held through repeated forced GC", {
    timeout: stallTimeout(20_000),
  }, async () => {
    const cacheDir = tmpDir();
    const holder = await spawnHolder(GOOD_HOLDER_PROBE, cacheDir, {
      VAULT_LOCK_PROBE_FORCE_GC: "1",
    });
    // Longer than the bad-control window above (2.3s in the primitives doc's own measurement) —
    // this is the case that must NOT flip to ACQUIRED under sustained GC pressure.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(holder.exitCode).toBeNull();
    expect(holder.signalCode).toBeNull();
    expect(challenge(cacheDir)).toBe("BLOCKED");
  });
});
