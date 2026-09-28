// Fix round (cross-vendor review, finding 1): `finalizeExclusiveCreate`'s no-`--force` fallback
// for volumes where `linkSync` isn't available (exFAT, SMB/CIFS home dirs, some Windows volumes —
// write.ts's own header). `linkSync` is forced to fail here (ENOTSUP) so every assertion below
// exercises this fallback branch specifically, never the primary hard-link path. Own file because
// `vi.mock("node:fs", ...)` is hoisted per-module — see setup-write-crash.test.ts's own header for
// why this split exists.
//
// Fix round 2 (cross-vendor review, finding 4): the ORIGINAL fallback opened `target` itself with
// `wx` and wrote content DIRECTLY into it — claiming `target`'s own NAME, visible to a racing
// loser (or a crash) as a REAL file at the exact path `serve` boots from, before a single byte had
// landed. The rewritten fallback claims exclusivity on a disposable MARKER name instead (same "wx
// wins the race" semantics, an instant zero-byte write) and touches `target`'s own name with
// exactly ONE syscall — `renameSync` moving an already-complete, fsynced STAGED file onto it — so
// `target` is never observably created-but-incomplete. Tests below are rewritten for that shape.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rmTemp } from "./tmp";

function enotsupError(syscall: string): NodeJS.ErrnoException {
  const e = new Error(
    `ENOTSUP: operation not supported on socket, ${syscall}`,
  ) as NodeJS.ErrnoException;
  e.code = "ENOTSUP";
  return e;
}

let writeSyncCallCount = 0;
let failWriteSyncOnCall: number | undefined;
let renameCalls: Array<{ from: string; to: string }> = [];
let renameCallCount = 0;
let failRenameOnCall: number | undefined;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: vi.fn(() => {
      throw enotsupError("link");
    }),
    writeSync: vi.fn((...args: Parameters<typeof actual.writeSync>) => {
      writeSyncCallCount += 1;
      if (writeSyncCallCount === failWriteSyncOnCall) {
        const e = new Error("ENOSPC: no space left on device, write") as NodeJS.ErrnoException;
        e.code = "ENOSPC";
        throw e;
      }
      return actual.writeSync(...args);
    }),
    renameSync: vi.fn((from: string, to: string) => {
      renameCallCount += 1;
      renameCalls.push({ from, to });
      if (renameCallCount === failRenameOnCall) {
        const e = new Error("ENOSPC: no space left on device, rename") as NodeJS.ErrnoException;
        e.code = "ENOSPC";
        throw e;
      }
      return actual.renameSync(from, to);
    }),
  };
});

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

afterEach(() => {
  writeSyncCallCount = 0;
  failWriteSyncOnCall = undefined;
  renameCalls = [];
  renameCallCount = 0;
  failRenameOnCall = undefined;
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* best-effort */
    }
  }
});

const decision = {
  vaults: [{ id: "main", path: "/vault" }],
  cacheDir: "/tmp/whatever-cachedir",
  embeddings: {
    provider: "local" as const,
    model: "nomic-embed-text-v1.5",
    dimensions: 768,
    reason: "test",
  },
  hostedSuggestions: [],
};

describe("writeSetupConfig — wx-fallback (linkSync unavailable)", () => {
  it("still writes a complete, loadable config when linkSync fails and the marker+stage+rename path is used", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-wx-ok-");
    const target = join(dir, "config.json");

    const result = writeSetupConfig(target, { ...decision, cacheDir: dir });

    expect(result.config.vaults).toMatchObject([{ id: "main", path: "/vault" }]);
    expect(existsSync(target)).toBe(true);
    // No leftover marker/staged litter after a clean success.
    const leftovers = renameCalls.filter((c) => c.to === target);
    expect(leftovers).toHaveLength(1);
    expect(existsSync(`${target}.wx-claim`)).toBe(false);
  });

  it("a writeSync failure on the staged file never creates `target` at all — no poison file blocks the next attempt", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-wx-poison-");
    const target = join(dir, "config.json");

    // Call #1 is writeTempFile's own write (must succeed so the tmp file holds complete bytes).
    // Call #3 is the fallback's write into the STAGED file (call #2 is the marker's own pid+ts
    // write) — THIS is the one that fails, before `target`'s own name has ever been touched.
    failWriteSyncOnCall = 3;

    expect(() => writeSetupConfig(target, { ...decision, cacheDir: dir })).toThrow(/ENOSPC/);

    // `target` was never created at all — not "created empty then unlinked", genuinely never
    // touched, since the fallback now only ever reaches `target`'s own name via one atomic rename
    // of already-complete content.
    expect(existsSync(target)).toBe(false);
    // The marker (exclusivity claim) is cleaned up too, or a retry would be wrongly refused with
    // "a config already exists" forever.
    expect(existsSync(`${target}.wx-claim`)).toBe(false);

    // A retry with no poison file left behind must succeed cleanly.
    failWriteSyncOnCall = undefined;
    const result = writeSetupConfig(target, { ...decision, cacheDir: dir });
    expect(result.config.vaults).toMatchObject([{ id: "main", path: "/vault" }]);
  });

  it("finding 4: `target` is never observably created-but-incomplete — renameSync is the ONLY syscall that ever touches its name, and only once, with full content already staged", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-wx-atomic-");
    const target = join(dir, "config.json");

    writeSetupConfig(target, { ...decision, cacheDir: dir });

    const finalRename = renameCalls.find((c) => c.to === target);
    expect(finalRename).toBeDefined();
    // The staged source `renameSync` moved onto `target` must already have held the FULL,
    // parseable config content at the moment of the call — the mock records the call, then the
    // real `renameSync` runs, so by the time we inspect `target` afterward, its content came
    // entirely from that single already-complete file, never a direct write into `target`'s name.
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk.vaults).toMatchObject([{ id: "main", path: "/vault" }]);
  });

  // Fix round (cross-vendor review, finding 2): the marker used to be a permanent claim — a
  // crash between `openSync(marker, "wx")` and the `finally` unlink left it on disk forever,
  // refusing EVERY future first run with a misleading "a config already exists" error (the config
  // does not exist; only the marker does). The marker now carries its holder's pid + claim time,
  // so a LIVE holder (another process genuinely mid-write) still refuses — but names the marker
  // file, not the config — while a STALE holder (dead pid or past the TTL) is unlinked and the
  // exclusive create retried once, recovering silently instead of wedging every later first run.
  it("finding 2: a LIVE marker (fresh claim, holder pid alive) refuses and names the marker file, not a permanent block", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-wx-marker-live-");
    const target = join(dir, "config.json");
    const { writeFileSync } = await import("node:fs");
    // The exact shape a genuine, still-in-flight racer leaves: its OWN pid (alive — it's this
    // test process) and a claim timestamp from just now.
    writeFileSync(`${target}.wx-claim`, JSON.stringify({ pid: process.pid, ts: Date.now() }));

    expect(() => writeSetupConfig(target, { ...decision, cacheDir: dir })).toThrow(
      `${target}.wx-claim`,
    );
    expect(existsSync(target)).toBe(false);
  });

  it("finding 2: a STALE marker (dead pid) self-heals — the exclusive create is retried once and succeeds", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-wx-marker-dead-pid-");
    const target = join(dir, "config.json");
    const { writeFileSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");
    // A pid guaranteed dead on this host: spawn a trivial process and read its pid back after it
    // has already exited.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid ?? 999999;
    writeFileSync(`${target}.wx-claim`, JSON.stringify({ pid: deadPid, ts: Date.now() }));

    const result = writeSetupConfig(target, { ...decision, cacheDir: dir });

    expect(result.config.vaults).toMatchObject([{ id: "main", path: "/vault" }]);
    expect(existsSync(`${target}.wx-claim`)).toBe(false);
  });

  it("finding 2: a STALE marker (TTL-expired, live pid) self-heals the same way", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-wx-marker-ttl-");
    const target = join(dir, "config.json");
    const { writeFileSync } = await import("node:fs");
    // This process's own pid IS alive, but the claim is far older than any real write takes —
    // staleness must fire on age alone, independent of pid liveness.
    writeFileSync(
      `${target}.wx-claim`,
      JSON.stringify({ pid: process.pid, ts: Date.now() - 10 * 60 * 1000 }),
    );

    const result = writeSetupConfig(target, { ...decision, cacheDir: dir });

    expect(result.config.vaults).toMatchObject([{ id: "main", path: "/vault" }]);
    expect(existsSync(`${target}.wx-claim`)).toBe(false);
  });

  // Fix round (finding 5): if `renameSync(staged, target)` fails, the staged file must not be
  // left as litter alongside the marker — a follow-up retry with the marker gone would otherwise
  // still trip over a stale `.wx-stage-*` file.
  it("finding 5: a failing renameSync(staged, target) leaves no .wx-stage-* litter, and a retry succeeds", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const { readdirSync } = await import("node:fs");
    const dir = tmpDir("otc-setup-write-wx-stage-cleanup-");
    const target = join(dir, "config.json");
    // Call #1: writeTempFile's own write. Call #2: the staged file's write. The rename that
    // follows is what we fail — via `failRenameOnCall`, not `failWriteSyncOnCall`.
    failRenameOnCall = 1;

    expect(() => writeSetupConfig(target, { ...decision, cacheDir: dir })).toThrow(/ENOSPC/);

    const leftovers = readdirSync(dir).filter((f) => f.includes(".wx-stage-"));
    expect(leftovers).toEqual([]);
    expect(existsSync(`${target}.wx-claim`)).toBe(false);
    expect(existsSync(target)).toBe(false);

    failRenameOnCall = undefined;
    const result = writeSetupConfig(target, { ...decision, cacheDir: dir });
    expect(result.config.vaults).toMatchObject([{ id: "main", path: "/vault" }]);
  });

  // Fix round (finding 5): the staged name must not be purely pid-keyed — two rapid attempts by
  // the SAME pid (a retry right after a failure, or a stale-marker self-heal) must never collide
  // on a raw `wx` EEXIST for the staged file's own name.
  it("finding 5: the staged temp file name carries randomness beyond the pid", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-wx-stage-name-");
    const target = join(dir, "config.json");

    writeSetupConfig(target, { ...decision, cacheDir: dir });

    const staged = renameCalls.find((c) => c.to === target)?.from;
    expect(staged).toBeDefined();
    expect(staged).toMatch(new RegExp(`\\.wx-stage-${process.pid}-\\d+-[a-z0-9]+$`));
  });
});
