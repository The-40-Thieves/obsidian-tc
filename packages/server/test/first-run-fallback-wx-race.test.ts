// Fix round (cross-vendor review, finding 1): `finalizeExclusiveCreate`'s no-`--force` fallback
// for volumes where `linkSync` is unavailable claims a marker (`target.wx-claim`) BEFORE `target`'s
// own name is ever touched. A concurrent LOSER that reaches the marker while it is still held sees
// `target` does not exist yet (the winner hasn't renamed its staged file onto it) — the OLD catch
// in `attemptFirstRunFallback` only entered the race-read retry loop when `existsSync(target)` was
// already true, so the loser threw "a config already exists" instead of waiting. Own file for the
// same `vi.mock("node:fs", ...)` isolation reason `setup-write-wx-fallback.test.ts`'s own header
// documents — every OTHER first-run-fallback test needs the real `linkSync`.
//
// True OS-level concurrency through this exact branch is hard to force deterministically (two real
// processes racing `linkSync`-unavailable is itself a race on WHICH one claims the marker first).
// This test instead builds the one state a genuine loser observes deterministically — a marker
// already held, target still absent — then completes the "winner" on a delay, proving the loser's
// retry loop picks up the winner's file instead of failing immediately.

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registryCandidates } from "../src/capability/locate";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp, stubHomedir } from "./tmp";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: vi.fn(() => {
      const e = new Error("ENOTSUP: operation not supported, link") as NodeJS.ErrnoException;
      e.code = "ENOTSUP";
      throw e;
    }),
  };
});

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = makeTempDir(prefix);
  tmpDirs.push(d);
  return d;
};

let restoreHome: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("ECONNREFUSED (stubbed — no Ollama in tests)"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreHome?.();
  restoreHome = undefined;
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* best-effort */
    }
  }
});

/** Same fixture shape as setup-first-run-fallback-e2e.test.ts's own `fakeObsidianEnv`. */
function fakeObsidianEnv(vaultIds: string[]): Record<string, string> {
  const home = tmpDir("otc-wx-race-home-");
  restoreHome = stubHomedir(home);
  const registryPath = registryCandidates(process.platform, process.env, home)[0];
  if (registryPath === undefined) {
    throw new Error(`no obsidian.json registry candidate for platform ${process.platform}`);
  }
  const vaultPaths: Record<string, string> = {};
  const vaults: Record<string, { path: string; open: boolean }> = {};
  for (const id of vaultIds) {
    const p = tmpDir(`otc-wx-race-vault-${id}-`);
    vaultPaths[id] = p;
    vaults[id] = { path: p, open: true };
  }
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ vaults }));
  return vaultPaths;
}

describe("attemptFirstRunFallback — concurrent loser on the linkSync-unavailable marker fallback", () => {
  it(
    "finding 1: the loser waits for the winner's file instead of throwing 'a config already exists'",
    async () => {
      const { attemptFirstRunFallback } = await import("../src/cli/setup/first-run-fallback");
      const { defaultSetupConfigPath } = await import("../src/cli/resolve-config");
      const vaultPaths = fakeObsidianEnv(["main"]);
      const target = defaultSetupConfigPath();
      mkdirSync(dirname(target), { recursive: true });

      // The exact state a genuine loser observes: another process's marker is LIVE (fresh claim,
      // holder pid alive) and `target` does not exist yet — its rename is still ahead of it.
      writeFileSync(`${target}.wx-claim`, JSON.stringify({ pid: process.pid, ts: Date.now() }));

      // The "winner" finishes shortly after: renames its own staged content onto `target`, then
      // releases the marker — same order write.ts's real fallback uses.
      setTimeout(() => {
        writeFileSync(
          target,
          JSON.stringify({
            vaults: [{ id: "main", path: vaultPaths.main }],
            cacheDir: dirname(target),
          }),
        );
        try {
          unlinkSync(`${target}.wx-claim`);
        } catch {
          /* best-effort */
        }
      }, 300);

      const result = await attemptFirstRunFallback();

      expect(result.outcome).toBe("raced");
      if (result.outcome !== "raced") throw new Error("unreachable");
      expect(result.path).toBe(target);
      expect(result.config.vaults).toMatchObject([{ id: "main", path: vaultPaths.main }]);
    },
    stallTimeout(10_000),
  );
});
