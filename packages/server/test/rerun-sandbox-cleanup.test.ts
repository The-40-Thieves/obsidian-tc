// workspace/rerun-sandbox-cleanup.ts's own coverage — the Windows safety net under `stageSandbox`'s
// staged directories (workspace/rerun.ts). Three properties: the sweep only touches entries that
// match `stageSandbox`'s own mint shape exactly AND are older than its threshold, and a deferred
// cleanup retry eventually removes a directory whose first removal attempt failed.

import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as sandboxCleanup from "../src/workspace/rerun-sandbox-cleanup";
import {
  awaitPendingSandboxCleanup,
  RERUN_TMP_PREFIX,
  scheduleDeferredCleanup,
  sweepStaleSandboxDirs,
} from "../src/workspace/rerun-sandbox-cleanup";
import { makeTempDir, rmTemp } from "./tmp";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // best-effort
    }
  }
});

/** A `stageSandbox`-shaped dir (`RERUN_TMP_PREFIX` + `mkdtempSync`'s own alphanumeric suffix),
 *  backdated by setting its mtime directly — cheaper and more deterministic than actually waiting
 *  out `maxAgeMs`. */
function mintAgedSandboxDir(root: string, ageMs: number, now: number): string {
  const dir = mkdtempSync(join(root, RERUN_TMP_PREFIX));
  const mtime = new Date(now - ageMs);
  utimesSync(dir, mtime, mtime);
  return dir;
}

describe("sweepStaleSandboxDirs", () => {
  it("removes an obtc-rerun-* dir older than maxAgeMs", () => {
    const root = makeTempDir("obtc-sweep-test-");
    tmpDirs.push(root);
    const now = Date.now();
    const stale = mintAgedSandboxDir(root, 2 * 60 * 60 * 1000, now); // 2h old

    sweepStaleSandboxDirs({ tmpDir: root, maxAgeMs: 60 * 60 * 1000, now });

    expect(existsSync(stale)).toBe(false);
  });

  it("ignores an obtc-rerun-* dir younger than maxAgeMs", () => {
    const root = makeTempDir("obtc-sweep-test-");
    tmpDirs.push(root);
    const now = Date.now();
    const fresh = mintAgedSandboxDir(root, 5_000, now); // 5s old

    sweepStaleSandboxDirs({ tmpDir: root, maxAgeMs: 60 * 60 * 1000, now });

    expect(existsSync(fresh)).toBe(true);
  });

  it("keeps an old sandbox whose live heartbeat is fresh", () => {
    expect(sandboxCleanup).toHaveProperty("RERUN_LIVE_MARKER");
    const marker = (sandboxCleanup as typeof sandboxCleanup & { RERUN_LIVE_MARKER: string })
      .RERUN_LIVE_MARKER;
    const root = makeTempDir("obtc-sweep-test-");
    tmpDirs.push(root);
    const now = Date.now();
    const active = mintAgedSandboxDir(root, 2 * 60 * 60 * 1000, now);
    writeFileSync(join(active, marker), "active\n");
    const old = new Date(now - 2 * 60 * 60 * 1000);
    utimesSync(active, old, old);

    sweepStaleSandboxDirs({ tmpDir: root, maxAgeMs: 60 * 60 * 1000, now });

    expect(existsSync(active)).toBe(true);
  });

  it("ignores an entry whose name does not match the mint shape exactly, however old", () => {
    const root = makeTempDir("obtc-sweep-test-");
    tmpDirs.push(root);
    const now = Date.now();
    // A differently-suffixed fixture shape other test files mint (session-rerun-tool-sandbox.test.ts's
    // own header names "obtc-rerun-cache-..." as exactly the kind of dir this must NOT touch) and an
    // unrelated name that merely shares the prefix as a substring, not a match.
    const other = join(root, "obtc-rerun-cache-abc123");
    mkdirSync(other);
    const old = new Date(now - 2 * 60 * 60 * 1000);
    utimesSync(other, old, old);
    const unrelated = join(root, "some-other-tmp-dir");
    mkdirSync(unrelated);
    utimesSync(unrelated, old, old);

    sweepStaleSandboxDirs({ tmpDir: root, maxAgeMs: 60 * 60 * 1000, now });

    expect(existsSync(other)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });
});

describe("scheduleDeferredCleanup / awaitPendingSandboxCleanup", () => {
  it("retries a failing remove and eventually succeeds", async () => {
    let attempts = 0;
    const remove = (path: string): void => {
      attempts += 1;
      if (attempts < 3) throw new Error(`simulated failure #${attempts} for ${path}`);
    };

    scheduleDeferredCleanup("/fake/path/does-not-matter", { remove, delaysMs: [1, 1, 1] });
    await awaitPendingSandboxCleanup();

    expect(attempts).toBe(3);
  });

  it("gives up after exhausting delaysMs and still settles (does not hang the caller)", async () => {
    let attempts = 0;
    const remove = (): void => {
      attempts += 1;
      throw new Error("persistent failure");
    };

    scheduleDeferredCleanup("/fake/path/never-succeeds", { remove, delaysMs: [1, 1] });
    await awaitPendingSandboxCleanup();

    expect(attempts).toBe(2);
  });
});
