// Fix round (cross-vendor review, finding 1): `finalizeExclusiveCreate`'s no-`--force` fallback
// for volumes where `linkSync` isn't available (exFAT, SMB/CIFS home dirs, some Windows volumes —
// write.ts's own header). `linkSync` is forced to fail here (ENOTSUP) so every assertion below
// exercises the `openSync(target, "wx")` + `writeSync` fallback branch specifically, never the
// primary hard-link path. Own file because `vi.mock("node:fs", ...)` is hoisted per-module — see
// setup-write-crash.test.ts's own header for why this split exists.
import { existsSync, mkdtempSync } from "node:fs";
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
  it("still writes a complete, loadable config when linkSync fails and the wx create-and-copy path is used", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-wx-ok-");
    const target = join(dir, "config.json");

    const result = writeSetupConfig(target, { ...decision, cacheDir: dir });

    expect(result.config.vaults).toMatchObject([{ id: "main", path: "/vault" }]);
    expect(existsSync(target)).toBe(true);
  });

  it("a writeSync failure on the wx-created target unlinks it — no poison file blocks the next attempt", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-wx-poison-");
    const target = join(dir, "config.json");

    // Call #1 is writeTempFile's own write (must succeed so the temp file holds complete bytes).
    // Call #2 is the wx-fallback's write into `target` — THIS is the one that fails.
    failWriteSyncOnCall = 2;

    expect(() => writeSetupConfig(target, { ...decision, cacheDir: dir })).toThrow(/ENOSPC/);

    // RED without the fix: openSync("wx") already claimed `target` (empty) before writeSync threw,
    // and nothing removed it — `existsSync(target)` stays true forever, poisoning every retry
    // (shouldAttemptFirstRunFallback reads this exact existsSync as "already configured").
    expect(existsSync(target)).toBe(false);

    // A retry with no poison file left behind must succeed cleanly.
    failWriteSyncOnCall = undefined;
    const result = writeSetupConfig(target, { ...decision, cacheDir: dir });
    expect(result.config.vaults).toMatchObject([{ id: "main", path: "/vault" }]);
  });
});
