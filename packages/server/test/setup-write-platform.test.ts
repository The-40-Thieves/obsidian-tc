// `obsidian-tc setup`'s writer — cross-filesystem/cross-platform finalization fallbacks (fix round
// 2, Codex review 1001-verify-r2, findings 5 + Windows CI). Own file for the same `vi.mock`
// isolation reason setup-write-crash.test.ts / setup-write-toctou.test.ts document.
//
// Finding 5 (MEDIUM): `linkSync`'s same-directory hard link (the no-`--force` exclusive-create
// primitive) can fail with EPERM/EXDEV/ENOTSUP/ENOSYS on exFAT, SMB/CIFS home directories, some NAS
// mounts, and some Windows volumes — it must fall back to an exclusive `wx` create-and-copy rather
// than hard-fail the whole command on a box that simply cannot hard-link there.
//
// Windows CI (macOS/windows fix round): `--force`'s `renameSync` over an EXISTING target can fail
// with EPERM on Windows when that target carries the read-only attribute (this writer's own 0o600
// mode, or an operator's own chmod) — reproduced directly in CI (windows-latest,
// `setup-write.test.ts` "--force preserves a STRICTER existing mode"). Must clear read-only and
// retry, or fall back to copying the temp file's bytes over the target in place, rather than fail
// the whole write after the pre-write backup has already been made.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupDecision } from "../src/cli/setup/decide";
import { rmTemp } from "./tmp";

// Fix round 2 (finding 4): the no-`--force` exclusive-create fallback now ALSO finalizes via
// `renameSync` (moving an already-staged, complete file onto `target` — write.ts's own header on
// `finalizeExclusiveCreate`), so a `renameSync` that fails UNCONDITIONALLY would now break that
// fallback too, not just the `--force` path finding 5/Windows-CI originally targeted this mock
// for. `renameShouldFail` lets each test opt in to the EPERM only where it means to exercise it.
let renameShouldFail = true;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: vi.fn(() => {
      const e = new Error("EXDEV: cross-device link not permitted, link") as NodeJS.ErrnoException;
      e.code = "EXDEV";
      throw e;
    }),
    renameSync: vi.fn((from: string, to: string) => {
      if (renameShouldFail) {
        const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      return actual.renameSync(from, to);
    }),
    fchmodSync: vi.fn(actual.fchmodSync),
  };
});

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  renameShouldFail = true;
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* best-effort */
    }
  }
});

function decision(): SetupDecision {
  return {
    vaults: [{ id: "main", path: "/vault" }],
    cacheDir: "/tmp/otc-cache",
    embeddings: {
      provider: "local",
      model: "nomic-embed-text-v1.5",
      dimensions: 768,
      reason: "test",
    },
    hostedSuggestions: [],
  };
}

describe("writeSetupConfig — cross-filesystem/platform finalization fallbacks", () => {
  it("no --force: linkSync unsupported (EXDEV) falls back to an exclusive create-and-copy instead of failing the write", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-linkfallback-");
    const target = join(dir, "config.json");
    // This fallback's own finalization step (marker + staged file + `renameSync`) is real here —
    // only the SECOND test below means to exercise a renameSync failure.
    renameShouldFail = false;

    const result = writeSetupConfig(target, decision());

    expect(result.path).toBe(target);
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk.vaults).toEqual([{ id: "main", path: "/vault" }]);
    const { linkSync } = await import("node:fs");
    expect(vi.mocked(linkSync)).toHaveBeenCalled();
  });

  it("--force: a renameSync EPERM (Windows read-only attribute / sharing violation) falls back to copying over the target instead of failing after the backup is already made", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-renamefallback-");
    const target = join(dir, "config.json");
    writeFileSync(target, JSON.stringify({ existing: true }));

    const result = writeSetupConfig(target, decision(), { force: true });

    expect(result.backupPath).toBeDefined();
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk.existing).toBeUndefined();
    expect(onDisk.vaults).toEqual([{ id: "main", path: "/vault" }]);
    const { renameSync } = await import("node:fs");
    expect(vi.mocked(renameSync)).toHaveBeenCalled();
  });

  // Security addendum (automated review, fix round 2): `copyOverInPlace`'s `openSync(target, "w",
  // mode)` only applies `mode` when the open call CREATES the file — here `target` already exists,
  // so its OLD, possibly looser permissions would otherwise sit on the NEW content (which may carry
  // real secrets: auth.jwtSecret, an inline embeddings.apiKey) for as long as it takes
  // `writeSetupConfig`'s own unconditional END-of-function `chmodSync` to run. `copyOverInPlace`
  // must tighten the mode on the OPEN FD itself (`fchmodSync`) BEFORE writing the new content —
  // closing that window at the source, not just fixing the end state up a moment later. POSIX-only
  // — Windows has no POSIX mode bits (see setup-write.test.ts's own
  // `describe.skipIf(process.platform === "win32")` convention for the same reason); `fchmodSync`
  // is still called there (best-effort, never fatal), just not meaningfully assertable.
  (process.platform === "win32" ? it.skip : it)(
    "--force: the EPERM-rename fallback tightens an existing looser mode via fchmodSync on the open fd, not only the end-of-write chmodSync",
    async () => {
      const { writeSetupConfig } = await import("../src/cli/setup/write");
      const dir = tmpDir("otc-setup-write-renamefallback-mode-");
      const target = join(dir, "config.json");
      writeFileSync(target, JSON.stringify({ existing: true }), { mode: 0o644 });

      writeSetupConfig(target, decision(), { force: true });

      const { fchmodSync, statSync } = await import("node:fs");
      expect(vi.mocked(fchmodSync)).toHaveBeenCalledWith(expect.any(Number), 0o600);
      expect(statSync(target).mode & 0o777).toBe(0o600);
    },
  );
});
